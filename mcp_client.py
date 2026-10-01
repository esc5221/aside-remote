"""`aside mcp` 를 상시 프로세스로 붙들고 쓰는 JSON-RPC 클라이언트.

핵심 사실 (실측):
  - 노출 툴은 `repl` 하나. 그 안에서 Playwright 호환 API로 브라우저 전권.
  - REPL 스코프는 프로세스가 살아있는 한 유지된다 (replIdleTimeoutMs=1,800,000).
    → 원샷 `aside repl "..."` 과 달리 탭/변수가 호출 간에 살아남는다.
  - 호출 지연 ~0.3s.

스코프 충돌을 피하려고 모든 코드를 async IIFE로 감싼다.
그래야 같은 변수명을 몇 번을 다시 써도 재선언 에러가 안 난다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import config

log = logging.getLogger("aside-remote.mcp")

_WRAP = "await (async () => {\n%s\n})();"


class ReplError(RuntimeError):
    """repl 이 isError 로 응답한 경우."""


class MCPClient:
    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 1
        self._call_lock = asyncio.Lock()   # REPL 스코프는 하나뿐 → 호출 직렬화
        self._start_lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        self._keepalive_task: asyncio.Task | None = None
        self.last_ok: float = 0.0
        self.session_pwd: str | None = None   # repl 세션 작업 디렉토리
        self.restarts = 0

    # ------------------------------------------------------------------ 수명주기
    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def ensure(self) -> None:
        if self.alive:
            return
        async with self._start_lock:
            if self.alive:
                return
            await self._spawn()

    async def _spawn(self) -> None:
        await self._teardown()
        log.info("spawning `aside mcp` ...")
        self._proc = await asyncio.create_subprocess_exec(
            config.ASIDE_BIN, "mcp",
            *(["--account", config.ASIDE_ACCOUNT] if config.ASIDE_ACCOUNT else []),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=8 * 1024 * 1024,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        await self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "aside-remote", "version": "1"},
        }, timeout=30)
        self._notify("notifications/initialized", {})
        # 세션 pwd 확보 (스크린샷 저장 경로로 쓴다)
        out = await self._raw_repl("console.log(pwd);", title="Bridge ready", timeout=30)
        self.session_pwd = out.strip().splitlines()[-1].strip() if out.strip() else None
        self.last_ok = time.time()
        if self._keepalive_task is None or self._keepalive_task.done():
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        log.info("aside mcp ready · pwd=%s", self.session_pwd)

    async def _teardown(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        self._proc = None
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("aside mcp restarted"))
        self._pending.clear()

    async def close(self) -> None:
        if self._keepalive_task:
            self._keepalive_task.cancel()
            self._keepalive_task = None
        await self._teardown()

    # ------------------------------------------------------------------ 전송
    def _notify(self, method: str, params: dict) -> None:
        assert self._proc and self._proc.stdin
        payload = json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
        self._proc.stdin.write((payload + "\n").encode())

    async def _request(self, method: str, params: dict, timeout: float) -> Any:
        assert self._proc and self._proc.stdin
        rid = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        payload = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        self._proc.stdin.write((payload + "\n").encode())
        await self._proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(rid, None)

    async def _read_loop(self) -> None:
        proc = self._proc
        assert proc and proc.stdout
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                rid = msg.get("id")
                if rid is None:
                    continue
                fut = self._pending.get(rid)
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(str(msg["error"])))
                    else:
                        fut.set_result(msg.get("result"))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("mcp read loop died")
        finally:
            log.warning("aside mcp stdout closed")

    # ------------------------------------------------------------------ repl
    async def _raw_repl(self, code: str, title: str, timeout: float) -> str:
        result = await self._request(
            "tools/call",
            {"name": "repl", "arguments": {"title": title, "code": code}},
            timeout=timeout,
        )
        parts = [c.get("text", "") for c in (result or {}).get("content", []) if c.get("type") == "text"]
        text = "\n".join(p for p in parts if p)
        if (result or {}).get("isError"):
            raise ReplError(text or "repl error")
        return text

    async def repl(self, code: str, *, title: str = "Bridge", timeout: float | None = None,
                   wrap: bool = True) -> str:
        """JS 실행 후 console.log 출력을 문자열로 반환. 프로세스가 죽었으면 1회 재시도."""
        timeout = timeout or config.MCP_CALL_TIMEOUT
        body = _WRAP % code if wrap else code
        async with self._call_lock:
            await self.ensure()
            try:
                out = await self._raw_repl(body, title, timeout)
            except (ConnectionError, BrokenPipeError, TimeoutError, RuntimeError) as exc:
                if isinstance(exc, ReplError):
                    raise
                log.warning("repl call failed (%s) — respawning", exc)
                self.restarts += 1
                await self._spawn()
                out = await self._raw_repl(body, title, timeout)
            self.last_ok = time.time()
            return out

    async def repl_json(self, code: str, *, title: str = "Bridge",
                        timeout: float | None = None) -> Any:
        """마지막 줄을 JSON으로 파싱. JS 쪽에서 console.log(JSON.stringify(...)) 할 것."""
        out = await self.repl(code, title=title, timeout=timeout)
        for line in reversed(out.strip().splitlines()):
            line = line.strip()
            if line.startswith(("{", "[")):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        raise ReplError(f"no JSON in repl output: {out[:400]}")

    # ------------------------------------------------------------------ keepalive
    async def _keepalive_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(config.MCP_KEEPALIVE_SEC)
                if time.time() - self.last_ok < config.MCP_KEEPALIVE_SEC:
                    continue
                await self.repl("console.log('ka');", title="Keepalive", timeout=30)
                log.debug("mcp keepalive ok")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("keepalive failed")


mcp = MCPClient()
