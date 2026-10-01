"""aside-remote — Aside 를 폰에서 쓰기 위한 로컬 브리지.

  Android ──HTTPS/WSS──> Cloudflare Access ──> cloudflared ──> 여기(127.0.0.1:8799)
                                                                 ├ aside mcp  (브라우저/탭)
                                                                 ├ aside exec (에이전트 실행)
                                                                 ├ messages.jsonl tail (스트리밍)
                                                                 └ daemon :21420 (세션 목록)

설계 제약 (CF 때문에 반드시 지켜야 하는 것):
  · 모든 실행 API 는 즉시 반환한다. CF 엣지 HTTP 타임아웃이 100초라 블로킹하면 504.
  · WS 는 20초 하트비트. CF Free/Pro 는 100초 idle 이면 끊는다.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import subprocess
import time

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

import browser
import cfaccess
import config
import daemondb
import fonts
import uploads
import runner
import sessions
from mcp_client import ReplError, mcp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)


class _StripQuery(logging.Filter):
    """uvicorn 접근로그는 전체 경로를 찍는다. 쿼리스트링에 토큰이 실릴 수 있어 잘라낸다."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[1], str):
            path = args[1].split("?", 1)
            if len(path) == 2:
                record.args = (args[0], path[0] + "?…", *args[2:])
        return True


logging.getLogger("uvicorn.access").addFilter(_StripQuery())
log = logging.getLogger("aside-remote")

STARTED_AT = time.time()
app = FastAPI(title="aside-remote", docs_url=None, redoc_url=None)
_http: httpx.AsyncClient | None = None


# ------------------------------------------------------------------ 인증
COOKIE = "ar_token"


def _token_of(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    # cookie fallback: <img>/WS cannot attach headers. Never a query string —
    # tokens in URLs leak into access logs and Referer headers.
    return request.cookies.get(COOKIE, "")


async def require_auth(request: Request) -> None:
    if not config.BEARER:          # 토큰 미설정 = 로컬 개발 모드
        return
    if _token_of(request) != config.BEARER:
        raise HTTPException(status_code=401, detail="unauthorized")


Auth = Depends(require_auth)


@app.exception_handler(browser.TooBusy)
async def _too_busy_handler(_request: Request, _exc: browser.TooBusy):
    """캡처 큐가 꽉 참. 클라이언트는 파비콘으로 폴백한다."""
    return JSONResponse({"error": "busy"}, status_code=503,
                        headers={"Retry-After": "3"})


@app.exception_handler(browser.TabAsleep)
async def _tab_asleep_handler(_request: Request, exc: browser.TabAsleep):
    """잠든 탭은 깨울 방법이 없다(chrome.tabs.update 차단). 앱은 openTab 으로 유도한다."""
    return JSONResponse({
        "error": "tab_asleep",
        "detail": "크롬이 메모리 회수한 잠든 탭이라 캡처/읽기가 불가능합니다.",
        "action": "open_url",
        "url": exc.tab.get("url"),
        "tab": exc.tab,
    }, status_code=409)


@app.exception_handler(browser.TabNotFound)
async def _tab_missing_handler(_request: Request, exc: browser.TabNotFound):
    return JSONResponse({"error": "tab_not_found", "targetId": str(exc)}, status_code=404)


@app.exception_handler(ReplError)
async def _repl_error_handler(_request: Request, exc: ReplError):
    return JSONResponse({"error": "repl_error", "detail": str(exc)[:1200]}, status_code=502)


# ------------------------------------------------------------------ 수명주기
@app.on_event("startup")
async def _startup() -> None:
    global _http
    _http = httpx.AsyncClient()
    asyncio.create_task(_warm_mcp())
    log.info("aside-remote up on %s:%s (auth=%s)",
             config.HOST, config.PORT, "on" if config.BEARER else "OFF")


async def _warm_mcp() -> None:
    try:
        await mcp.ensure()
    except Exception:
        log.exception("mcp warmup failed (계속 진행 — 첫 요청 때 다시 시도)")


@app.on_event("shutdown")
async def _shutdown() -> None:
    await mcp.close()
    if _http:
        await _http.aclose()


# ------------------------------------------------------------------ 웹 UI
WEB_DIR = config.BASE_DIR / "web"


@app.get("/")
async def web_index():
    """웹 화면. 인증은 앞단 CF Access 가 막고, 브리지 토큰은 이 셸이 로드된 뒤 물어본다.

    HTML 자체에는 데이터가 없다 — 세션/탭/미디어는 전부 토큰이 붙은 API 호출로만 나간다.
    """
    f = WEB_DIR / "index.html"
    if not f.exists():
        raise HTTPException(404, "web UI not installed")
    return FileResponse(f, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})


@app.get("/api/web-token")
async def web_token(request: Request):
    """웹 UI 부트스트랩: Access 를 통과한 브라우저에만 브리지 토큰을 내준다.

    헤더 문자열을 믿지 않고 `cf-access-jwt-assertion` 을 Cloudflare 공개키로 서명 검증한다.
    로컬(127.0.0.1)에서 직접 부르는 경우는 이미 이 맥 안이라 그대로 허용한다.
    """
    host = (request.headers.get("host") or "").split(":")[0]
    if host in ("127.0.0.1", "localhost", "::1"):
        return _token_response(request, "loopback", None)

    assertion = request.headers.get("cf-access-jwt-assertion")
    if not assertion:
        raise HTTPException(401, "no Access assertion")
    email = await cfaccess.verify(
        _http, assertion, aud=config.ACCESS_AUD,
        allowed_emails=config.ACCESS_EMAILS, allowed_cns=config.ACCESS_SERVICE_CNS,
    )
    if not email:
        raise HTTPException(403, "Access assertion rejected")
    log.info("web-token issued to %s", email)
    return _token_response(request, "cf-access", email)


def _token_response(request: Request, via: str, email: str | None) -> JSONResponse:
    body = {"token": config.BEARER, "via": via}
    if email:
        body["email"] = email
    r = JSONResponse(body)
    r.set_cookie(
        COOKIE, config.BEARER,
        max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax",
        secure=request.url.scheme == "https", path="/",
    )
    return r


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(WEB_DIR / "icons" / "favicon.ico",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/vendor/{name}")
async def vendor(name: str):
    """자체 호스팅 서드파티 자산(highlight.js). 런타임에 외부를 안 본다."""
    p = WEB_DIR / "vendor" / name
    if "/" in name or ".." in name or not p.exists():
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="application/javascript",
                        headers={"Cache-Control": "public, max-age=604800"})


@app.get("/icons/{name}")
async def icon(name: str):
    p = WEB_DIR / "icons" / name
    if "/" in name or ".." in name or not p.exists():
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "public, max-age=86400"})


# ------------------------------------------------------------------ 폰트
@app.get("/api/font/list")
async def font_list():
    """설정 화면이 고를 수 있는 본문 폰트 목록."""
    return {"fonts": fonts.catalog()}


@app.get("/api/font/css/{font_id}")
async def font_css(font_id: str):
    """폰트 CSS. 폰트 파일 URL 은 브리지 경유로 치환되어 나간다 → 브라우저는 서드파티를 안 본다."""
    if font_id not in fonts.FAMILIES:
        raise HTTPException(404, "unknown font")
    try:
        text = await fonts.css(_http, font_id)
    except Exception as exc:
        log.warning("font css failed: %s", exc)
        raise HTTPException(502, "font fetch failed")
    return Response(text, media_type="text/css",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/font/file/{fid}")
async def font_file(fid: str):
    got = await fonts.file(_http, fid)
    if not got:
        raise HTTPException(404, "not found")
    data, ctype = got
    return Response(data, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ------------------------------------------------------------------ 상태
def _aside_app_running() -> bool:
    try:
        out = subprocess.run(["pgrep", "-f", "/Applications/Aside.app/Contents/MacOS/Aside"],
                             capture_output=True, timeout=5)
        return out.returncode == 0
    except Exception:
        return False


@app.get("/api/health")
async def health():
    daemon = None
    try:
        r = await _http.get(f"{config.DAEMON_URL}/health", timeout=5)
        daemon = r.json()
    except Exception as exc:
        daemon = {"error": str(exc)}
    return {
        "ok": True,
        "uptime": round(time.time() - STARTED_AT, 1),
        "daemon": daemon,
        "asideApp": _aside_app_running(),
        "mcp": {
            "alive": mcp.alive,
            "pwd": mcp.session_pwd,
            "restarts": mcp.restarts,
            "lastOk": mcp.last_ok,
        },
        "runningSessions": runner.running_ids(),
    }


@app.post("/api/aside/launch", dependencies=[Auth])
async def launch_aside():
    """Aside.app 이 꺼져 있으면 브라우저 툴이 전부 실패한다. 폰에서 깨울 수 있게."""
    if _aside_app_running():
        return {"ok": True, "already": True}
    subprocess.Popen(["open", "-g", "-a", "Aside"])
    for _ in range(20):
        await asyncio.sleep(0.5)
        if _aside_app_running():
            return {"ok": True, "already": False}
    return JSONResponse({"ok": False, "error": "Aside.app 기동 실패"}, status_code=503)


# ------------------------------------------------------------------ 세션
@app.get("/api/sessions", dependencies=[Auth])
async def api_sessions(
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, description="이전 페이지의 nextCursor. 키셋 기준 (mtime, id)"),
    q: str | None = Query(None, description="제목·미리보기 전체 검색 (로드된 페이지가 아니라 전 구간)"),
):
    return await sessions.list_sessions(_http, limit=limit, cursor=cursor, q=q)


@app.get("/api/sessions/{session_id}/messages", dependencies=[Auth])
async def api_messages(session_id: str, tail: int = Query(400, ge=1, le=5000)):
    msgs, offset = sessions.read_messages(session_id, tail=tail)
    return {
        "sessionId": session_id,
        "messages": msgs,
        "offset": offset,
        "nextSeq": (msgs[-1]["seq"] + 1) if msgs else 0,
        "running": await _is_running(session_id),
    }


async def _is_running(session_id: str) -> bool:
    """브리지가 아는 실행 + 데몬이 보는 상태를 함께 본다."""
    run = runner.get_run(session_id)
    if run and run.running:
        return True
    return (await sessions.session_status(_http, session_id)) == "running"


@app.get("/api/sessions/{session_id}/status", dependencies=[Auth])
async def api_status(session_id: str):
    """가벼운 실행 여부 확인. run.done 을 놓쳤을 때 클라이언트가 스피너를 끄는 용도."""
    return {"sessionId": session_id, "running": await _is_running(session_id)}


def _with_attachments(payload: dict) -> str:
    """첨부가 있으면 프롬프트 앞에 경로 블록을 붙인다.

    `aside exec` 은 텍스트 프롬프트만 받는다 → 이미지는 "여기 있으니 읽어봐"로 전달하는 수밖에 없다.
    """
    prompt = (payload.get("prompt") or "").strip()
    atts = payload.get("attachments") or []
    clean = []
    for a in atts:
        fid = (a or {}).get("id") if isinstance(a, dict) else a
        p = uploads.path_of(str(fid or ""))
        if p:
            clean.append({"name": (a.get("name") if isinstance(a, dict) else None) or p.name,
                          "path": str(p)})
    return (uploads.prompt_prefix(clean) + prompt) if clean else prompt


@app.post("/api/runs", dependencies=[Auth])
async def api_run(payload: dict):
    """새 실행. 절대 블로킹하지 않는다 — 세션 id 만 확정해서 즉시 반환."""
    prompt = _with_attachments(payload)
    if not prompt:
        raise HTTPException(400, "prompt required")
    run = await runner.start_run(
        prompt,
        model=payload.get("model"),
        effort=payload.get("effort"),
        speed=payload.get("speed"),
        provider=payload.get("provider"),
        permission=payload.get("permission"),
        host=payload.get("host"),
    )
    if not run.session_id:
        raise HTTPException(502, run.error or "세션 시작 실패")
    return JSONResponse({"sessionId": run.session_id, "running": run.running}, status_code=202)


@app.post("/api/sessions/{session_id}/messages", dependencies=[Auth])
async def api_continue(session_id: str, payload: dict):
    prompt = _with_attachments(payload)
    if not prompt:
        raise HTTPException(400, "prompt required")
    if sessions.session_dir(session_id) is None:
        raise HTTPException(404, "unknown session")
    existing = runner.get_run(session_id)
    if existing and existing.running:
        raise HTTPException(409, "이미 실행 중입니다")
    # `aside session resume` takes no model/effort/speed options — the session
    # keeps the settings it was created with.
    run = await runner.continue_run(session_id, prompt)
    return JSONResponse({"sessionId": session_id, "running": run.running}, status_code=202)


@app.post("/api/sessions/{session_id}/abort", dependencies=[Auth])
async def api_abort(session_id: str):
    return {"aborted": await runner.abort(session_id)}


@app.post("/api/sessions/{session_id}/steer", dependencies=[Auth])
async def api_steer(session_id: str, payload: dict):
    """실행 중인 스텝을 끊고 새 지시를 넣는다. mode=queue 면 현재 스텝 뒤에 붙인다."""
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    fn = runner.queue if payload.get("mode") == "queue" else runner.steer
    return {"ok": await fn(session_id, prompt)}


# ------------------------------------------------------------------ 미디어
@app.get("/api/media/{media_id}", dependencies=[Auth])
async def api_media(media_id: str):
    p = sessions.media_path(media_id)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/sessions/{session_id}/file/{rel:path}", dependencies=[Auth])
async def api_session_file(session_id: str, rel: str):
    """에이전트가 답변에 박아 넣은 로컬 파일(스크린샷·긴 툴출력)을 폰에 내준다."""
    p = sessions.session_file(session_id, rel)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p)


@app.get("/api/sessions/{session_id}/artifacts", dependencies=[Auth])
async def api_artifacts(session_id: str):
    d = sessions.session_dir(session_id)
    if not d:
        raise HTTPException(404, "unknown session")
    adir = d / "artifacts"
    if not adir.exists():
        return []
    return [
        {"name": f.name, "bytes": f.stat().st_size, "mtime": int(f.stat().st_mtime)}
        for f in sorted(adir.iterdir()) if f.is_file()
    ]


@app.get("/api/sessions/{session_id}/artifacts/{name}", dependencies=[Auth])
async def api_artifact(session_id: str, name: str):
    d = sessions.session_dir(session_id)
    if not d or "/" in name or ".." in name:
        raise HTTPException(404, "not found")
    p = d / "artifacts" / name
    if not p.exists():
        raise HTTPException(404, "not found")
    return FileResponse(p)


# ------------------------------------------------------------------ 첨부
@app.post("/api/upload", dependencies=[Auth])
async def api_upload(request: Request):
    """이미지 원본 바이트를 그대로 받는다(멀티파트 파싱 의존성 없이).

    파일명은 X-Filename 헤더로 받는다. 저장 위치는 Aside 유저 루트 안이어야
    에이전트의 repl 이 읽을 수 있다 (uploads.py 주석 참조).
    """
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "empty body")
    if len(raw) > config.UPLOAD_MAX_BYTES:
        raise HTTPException(413, f"too large ({len(raw)}B)")
    name = request.headers.get("x-filename") or ""
    try:
        from urllib.parse import unquote
        name = unquote(name)
    except Exception:
        pass
    try:
        return uploads.save(raw, name)
    except ValueError as exc:
        raise HTTPException(415, str(exc))


@app.get("/api/upload/{fid}", dependencies=[Auth])
async def api_upload_get(fid: str):
    p = uploads.path_of(fid)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ------------------------------------------------------------------ 탭
@app.get("/api/tabs", dependencies=[Auth])
async def api_tabs(refresh: bool = False):
    tabs = await browser.list_tabs(force=refresh)
    return {"count": len(tabs), "tabs": tabs}


@app.get("/api/tabs/{target_id}/shot", dependencies=[Auth])
async def api_tab_shot(target_id: str, full: bool = False, q: int = Query(62, ge=20, le=95),
                       fresh: bool = False):
    path, _meta = await browser.screenshot(target_id, full=full, quality=q,
                                           max_age=0 if fresh else None)
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "no-cache"})


@app.get("/api/tabs/{target_id}/text", dependencies=[Auth])
async def api_tab_text(target_id: str, interactive: bool = False):
    return await browser.tab_text(target_id, interactive=interactive)


@app.post("/api/tabs", dependencies=[Auth])
async def api_open_tab(payload: dict):
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "url required")
    return await browser.open_tab(url)


@app.post("/api/tabs/{target_id}/focus", dependencies=[Auth])
async def api_focus(target_id: str):
    return await browser.focus_tab(target_id)


@app.delete("/api/tabs/{target_id}", dependencies=[Auth])
async def api_close_tab(target_id: str):
    return await browser.close_tab(target_id)


@app.post("/api/repl", dependencies=[Auth])
async def api_repl(payload: dict):
    """탈출구. 본인 전용이니까 남겨둔다."""
    code = payload.get("code") or ""
    if not code.strip():
        raise HTTPException(400, "code required")
    out = await mcp.repl(code, title=payload.get("title") or "Manual REPL",
                         wrap=bool(payload.get("wrap", True)))
    return {"output": out}


# ------------------------------------------------------------------ WebSocket
class Hub:
    """세션별 tail 태스크를 소켓들이 공유한다."""

    def __init__(self) -> None:
        self._subs: dict[str, set[WebSocket]] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def subscribe(self, ws: WebSocket, session_id: str, from_seq: int, from_offset: int) -> None:
        self._subs.setdefault(session_id, set()).add(ws)
        if session_id not in self._tasks or self._tasks[session_id].done():
            self._tasks[session_id] = asyncio.create_task(
                self._pump(session_id, from_offset, from_seq))

    def unsubscribe(self, ws: WebSocket, session_id: str | None = None) -> None:
        targets = [session_id] if session_id else list(self._subs)
        for sid in targets:
            subs = self._subs.get(sid)
            if not subs:
                continue
            subs.discard(ws)
            if not subs:
                task = self._tasks.pop(sid, None)
                if task:
                    task.cancel()
                self._subs.pop(sid, None)

    async def broadcast(self, session_id: str, payload: dict) -> None:
        dead = []
        for ws in list(self._subs.get(session_id, ())):
            try:
                await ws.send_text(json.dumps(payload, ensure_ascii=False))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(ws)

    async def _pump(self, session_id: str, offset: int, seq: int) -> None:
        try:
            async for msg in sessions.tail_messages(session_id, offset, seq):
                await self.broadcast(session_id, {"op": "msg", "sessionId": session_id,
                                                  "message": msg})
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("pump failed for %s", session_id)

    async def watch_run(self, run: "runner.Run") -> None:
        """프로세스 종료를 기다렸다가 run.done 을 쏜다. jsonl 마지막 줄이 도착할 시간을 준다."""
        sid = run.session_id
        if not sid:
            return
        while run.running:
            await asyncio.sleep(0.4)
        await asyncio.sleep(config.JSONL_POLL_SEC * 3)
        sessions.invalidate_index()   # 목록 캐시(TTL 4s)를 기다리지 않고 즉시 반영
        await self.broadcast(sid, {
            "op": "run.done", "sessionId": sid,
            "exitCode": run.exit_code,
            "output": (run.output or "")[:4000],
            "error": run.error,
        })
        log.info("run.done broadcast session=%s → ntfy", sid)
        await push_ntfy(sid, run)


async def push_ntfy(session_id: str, run: "runner.Run") -> None:
    """실행 완료 푸시. 실패해도 조용히 넘어간다 — 알림 때문에 본 기능이 막히면 안 된다.

    ntfy 는 헤더로도 받지만 HTTP 헤더는 latin-1 이라 한글 제목이 깨지거나 예외가 난다.
    루트 엔드포인트에 JSON 을 던지는 형식이 UTF-8 을 제대로 처리한다.
    """
    if not config.NTFY_ENABLED or not _http:
        return
    title = "Aside"
    try:
        for s in (await sessions.list_sessions(_http, limit=20))["items"]:
            if s["id"] == session_id:
                title = s["title"] or title
                break
    except Exception:
        pass
    body = [ln for ln in (run.output or "").strip().splitlines() if ln.strip()]
    tail = "\n".join(body[-6:])[:600] or ("실패" if run.exit_code else "완료")
    try:
        await _http.post(
            config.NTFY_URL,
            json={
                "topic": config.NTFY_TOPIC,
                "title": title[:120],
                "message": tail,
                "tags": ["white_check_mark"] if run.exit_code == 0 else ["x"],
            },
            timeout=10,
        )
    except Exception:
        log.warning("ntfy push failed", exc_info=True)


hub = Hub()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if config.BEARER:
        header = ws.headers.get("authorization", "")
        supplied = (header[7:].strip() if header.lower().startswith("bearer ")
                    else ws.cookies.get(COOKIE, ""))
        if supplied != config.BEARER:
            await ws.close(code=4401)
            return
    await ws.accept()
    hb = asyncio.create_task(_heartbeat(ws))
    try:
        await ws.send_text(json.dumps({"op": "hello", "running": runner.running_ids()}))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await _handle_ws(ws, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws error")
    finally:
        hb.cancel()
        hub.unsubscribe(ws)
        with contextlib.suppress(Exception):
            await ws.close()


async def _heartbeat(ws: WebSocket) -> None:
    """CF Free/Pro 는 100초 무통신이면 WS 를 끊는다. 20초마다 살아있다고 알린다."""
    try:
        while True:
            await asyncio.sleep(config.WS_HEARTBEAT_SEC)
            await ws.send_text(json.dumps({"op": "ping", "t": int(time.time())}))
    except (asyncio.CancelledError, Exception):
        return


async def _send(ws: WebSocket, payload: dict) -> None:
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(payload, ensure_ascii=False))


async def _handle_ws(ws: WebSocket, msg: dict) -> None:
    op = msg.get("op")
    rid = msg.get("requestId")

    if op in ("pong", "ping"):
        return

    if op == "sub":
        sid = msg.get("sessionId")
        if not sid:
            return
        await hub.subscribe(ws, sid, int(msg.get("fromSeq") or 0), int(msg.get("fromOffset") or 0))
        await _send(ws, {"op": "sub.ok", "sessionId": sid, "requestId": rid})
        return

    if op == "unsub":
        hub.unsubscribe(ws, msg.get("sessionId"))
        return

    if op == "run":
        prompt = _with_attachments(msg)
        if not prompt:
            await _send(ws, {"op": "error", "requestId": rid, "message": "prompt required"})
            return
        try:
            run = await runner.start_run(prompt, model=msg.get("model"),
                                         effort=msg.get("effort"), speed=msg.get("speed"),
                                         provider=msg.get("provider"),
                                         permission=msg.get("permission"),
                                         host=msg.get("host"))
        except Exception as exc:
            await _send(ws, {"op": "error", "requestId": rid, "message": str(exc)})
            return
        if not run.session_id:
            await _send(ws, {"op": "error", "requestId": rid,
                             "message": run.error or "세션 시작 실패"})
            return
        await hub.subscribe(ws, run.session_id, 0, 0)
        asyncio.create_task(hub.watch_run(run))
        await _send(ws, {"op": "run.started", "requestId": rid, "sessionId": run.session_id})
        return

    if op == "continue":
        sid = msg.get("sessionId")
        prompt = _with_attachments(msg)
        if not sid or not prompt:
            await _send(ws, {"op": "error", "requestId": rid, "message": "sessionId/prompt required"})
            return
        existing = runner.get_run(sid)
        if existing and existing.running:
            await _send(ws, {"op": "error", "requestId": rid, "message": "이미 실행 중입니다"})
            return
        # 데몬이 퍼지한 세션이면(재시작으로 잊음) 레지스트리 행을 재삽입해 되살린다.
        await asyncio.to_thread(daemondb.ensure_alive, sid)
        _msgs, offset = sessions.read_messages(sid)
        await hub.subscribe(ws, sid, len(_msgs), offset)
        try:
            run = await runner.continue_run(sid, prompt)
        except Exception as exc:
            await _send(ws, {"op": "error", "requestId": rid, "message": str(exc)})
            return
        asyncio.create_task(hub.watch_run(run))
        await _send(ws, {"op": "run.started", "requestId": rid, "sessionId": sid})
        return

    if op == "abort":
        sid = msg.get("sessionId")
        await _send(ws, {"op": "abort.ok", "requestId": rid,
                         "aborted": (await runner.abort(sid)) if sid else False})
        return

    if op == "tabs":
        try:
            tabs = await browser.list_tabs(force=bool(msg.get("refresh")))
        except Exception as exc:
            await _send(ws, {"op": "error", "requestId": rid, "message": str(exc)})
            return
        await _send(ws, {"op": "tabs", "requestId": rid, "count": len(tabs), "tabs": tabs})
        return

    await _send(ws, {"op": "error", "requestId": rid, "message": f"unknown op: {op}"})


# ------------------------------------------------------------------ SPA 셸
# 클라이언트 라우팅용. 반드시 "맨 마지막"에 등록해야 한다 — FastAPI 는 선언 순서로
# 매칭하므로, 위에 두면 /api/* 를 전부 삼킨다.
# 느슨한 catch-all 대신 화이트리스트를 쓴다. /api 오타가 200 HTML 로 돌아오면
# 디버깅이 괴로워진다 — 없는 주소는 정직하게 404 여야 한다.
_SPA_PATHS = re.compile(r"tabs|settings|c/[A-Za-z0-9_-]{1,64}")


@app.get("/{path:path}")
async def spa_shell(path: str):
    if not _SPA_PATHS.fullmatch(path):
        raise HTTPException(404, "not found")
    return await web_index()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info",
                ws_ping_interval=None, ws_ping_timeout=None)
