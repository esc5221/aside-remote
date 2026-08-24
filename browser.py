"""브라우저(탭) 조작 — mcp repl 위에 얹은 얇은 레이어.

실측으로 확인한 제약 (설계가 여기에 맞춰져 있다):
  · 열린 탭 177개 중 **126개가 `status: "unloaded"`** (크롬이 메모리 회수한 잠든 탭).
    잠든 탭에 attachBrowserTab 하면 `CDP command timeout: Page.enable` 로 30초 넘게 매달리고,
    그걸 연달아 하면 확장↔데몬 브리지까지 흔들린다. → 잠든 탭은 아예 건드리지 않는다.
  · 깨우는 API 는 막혀 있다:
      "chrome.tabs.reload/update is unavailable in the REPL because it can modify
       the user's tab or window session. Use openTab(url) and closeTab(page)"
    → 잠든 탭은 `openTab(url)` 로 새로 여는 것이 유일한 경로다.
  · `chrome.tabs.query({})` 는 허용된다. status/id 를 여기서 얻어 listBrowserTabs 와 합친다.
  · attach 는 항상 타임아웃 레이스로 감싼다. repl 이 통째로 잠기는 걸 막는 유일한 방법.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path

import config
from mcp_client import ReplError, mcp

log = logging.getLogger("aside-remote.browser")

ATTACH_TIMEOUT_MS = 12000

# 캡처는 REPL 락 하나를 다른 모든 호출과 공유한다.
# 살아있는 탭이 48개라 썸네일 요청이 한꺼번에 몰리면 탭 목록 조회까지 뒤에 밀려 타임아웃난다.
# → 동시 2개로 제한하고, 대기열이 깊으면 기다리지 말고 503 으로 즉시 돌려보낸다.
SHOT_CONCURRENCY = 2
SHOT_QUEUE_MAX = 6
_shot_sem = asyncio.Semaphore(SHOT_CONCURRENCY)
_shot_waiting = 0

_tabs_cache: tuple[float, list[dict]] | None = None
_tabs_lock = asyncio.Lock()
_shot_locks: dict[str, asyncio.Lock] = {}


class TooBusy(RuntimeError):
    """캡처 대기열이 꽉 참. 클라이언트는 파비콘으로 폴백하면 된다."""


class TabAsleep(RuntimeError):
    """잠든 탭이라 조작 불가. 앱은 '열어서 보기'로 유도해야 한다."""

    def __init__(self, tab: dict) -> None:
        super().__init__("tab is unloaded")
        self.tab = tab


class TabNotFound(RuntimeError):
    pass


def _jsq(value) -> str:
    return json.dumps(str(value))


# JS 조각: targetId 로 안전하게 attach (타임아웃 레이스)
_ATTACH = """
  const __attach = async (tid) => {
    let timer;
    try {
      return await Promise.race([
        attachBrowserTab(tid),
        new Promise((_, rj) => { timer = setTimeout(() => rj(new Error('ATTACH_TIMEOUT')), %d); }),
      ]);
    } finally { clearTimeout(timer); }
  };
""" % ATTACH_TIMEOUT_MS


# --------------------------------------------------------------------- 목록
async def list_tabs(force: bool = False) -> list[dict]:
    global _tabs_cache
    async with _tabs_lock:
        now = time.time()
        if not force and _tabs_cache and now - _tabs_cache[0] < config.TAB_CACHE_TTL:
            return _tabs_cache[1]
        code = """
  const bt = await listBrowserTabs();
  let ct = [];
  try { ct = await chrome.tabs.query({}); } catch (e) { ct = []; }
  const byUrl = new Map();
  for (const t of ct) if (!byUrl.has(t.url)) byUrl.set(t.url, t);
  const merged = bt.map(t => {
    const c = byUrl.get(t.url);
    return {
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      favicon: t.faviconUrl || null,
      active: !!t.active,
      windowId: t.windowId,
      chromeId: c ? c.id : null,
      loaded: c ? (c.status === 'complete') : null,
      status: c ? c.status : null,
      lastAccessed: c ? (c.lastAccessed || null) : null,   // 마지막 활성 시각(ms) — 최근 사용 정렬용
    };
  });
  console.log(JSON.stringify(merged));
"""
        tabs = await mcp.repl_json(code, title="Listing browser tabs", timeout=45)
        tabs = tabs if isinstance(tabs, list) else []
        _tabs_cache = (now, tabs)
        return tabs


async def find_tab(target_id: str, *, force: bool = False) -> dict:
    for tab in await list_tabs(force=force):
        if tab.get("targetId") == target_id:
            return tab
    for tab in await list_tabs(force=True):
        if tab.get("targetId") == target_id:
            return tab
    raise TabNotFound(target_id)


async def _require_awake(target_id: str) -> dict:
    tab = await find_tab(target_id)
    # loaded 가 None 이면 chrome.tabs 매칭 실패(중복 URL 등) — 판단 불가라 시도는 해본다.
    if tab.get("loaded") is False:
        raise TabAsleep(tab)
    return tab


# --------------------------------------------------------------------- 캡처
def _shot_path(target_id: str, full: bool) -> Path:
    key = hashlib.sha1(f"{target_id}:{int(full)}".encode()).hexdigest()[:20]
    return config.SHOT_DIR / f"{key}.jpg"


async def screenshot(target_id: str, *, full: bool = False, quality: int = 62,
                     max_age: float | None = None) -> tuple[Path, dict]:
    """탭 스크린샷을 브리지 캐시로 가져온다.

    repl 샌드박스는 세션 디렉토리 밖으로 못 쓴다. 세션 artifacts/ 에 저장시킨 뒤
    브리지(제약 없음)가 그 경로를 직접 읽어 캐시로 옮긴다.
    """
    global _shot_waiting
    max_age = config.SHOT_CACHE_TTL if max_age is None else max_age
    dest = _shot_path(target_id, full)

    # 캐시 히트는 큐를 타지 않는다.
    if dest.exists() and time.time() - dest.stat().st_mtime < max_age:
        return dest, {"cached": True}
    if _shot_waiting >= SHOT_QUEUE_MAX:
        raise TooBusy(target_id)

    lock = _shot_locks.setdefault(target_id, asyncio.Lock())
    _shot_waiting += 1
    try:
        async with _shot_sem, lock:
            if dest.exists() and time.time() - dest.stat().st_mtime < max_age:
                return dest, {"cached": True}
            return await _capture(target_id, dest, full, quality)
    finally:
        _shot_waiting -= 1


async def _capture(target_id: str, dest: Path, full: bool, quality: int) -> tuple[Path, dict]:
    tab = await _require_awake(target_id)
    code = _ATTACH + f"""
  const dir = pwd + '/artifacts';
  await fs.mkdir(dir, {{ recursive: true }});
  const pg = await __attach({_jsq(target_id)});
  const buf = await pg.screenshot({{ type: 'jpeg', quality: {int(quality)}, fullPage: {str(bool(full)).lower()} }});
  const fp = dir + '/shot-' + Date.now() + '.jpg';
  await fs.writeFile(fp, buf);
  console.log(JSON.stringify({{ path: fp, bytes: buf.length, url: pg.url() }}));
"""
    info = await mcp.repl_json(code, title="Capturing tab", timeout=40)
    src = Path(info["path"])
    dest.write_bytes(src.read_bytes())
    try:
        src.unlink()
    except OSError:
        pass
    return dest, {
        "cached": False,
        "bytes": info.get("bytes"),
        "url": info.get("url"),
        "title": tab.get("title"),
    }


# --------------------------------------------------------------------- 읽기
async def tab_text(target_id: str, *, interactive: bool = False) -> dict:
    """snapshot(a11y tree) 우선, 비면 innerText 폴백.

    Angular 계열 SPA 는 a11y 트리가 비어서 나오는 경우가 실제로 있다 → 폴백 필수.
    """
    await _require_awake(target_id)
    code = _ATTACH + f"""
  const pg = await __attach({_jsq(target_id)});
  let tree = '';
  try {{
    const s = await snapshot(pg, {{ interactive: {str(bool(interactive)).lower()} }});
    tree = s.tree || '';
  }} catch (e) {{ tree = ''; }}
  let text = '';
  if (tree.trim().length < 80) {{
    try {{ text = await pg.evaluate(() => document.body ? document.body.innerText : ''); }} catch (e) {{}}
  }}
  const useTree = tree.trim().length >= 80;
  console.log(JSON.stringify({{
    url: pg.url(), title: await pg.title(),
    mode: useTree ? 'snapshot' : 'innerText',
    content: (useTree ? tree : text).slice(0, 200000),
  }}));
"""
    return await mcp.repl_json(code, title="Reading page", timeout=90)


# --------------------------------------------------------------------- 수명주기
async def open_tab(url: str) -> dict:
    """잠든 탭을 되살리는 유일한 경로이기도 하다 (chrome.tabs.update 가 막혀 있어서)."""
    code = f"""
  const pg = await openTab({_jsq(url)});
  const u = pg.url();
  const bt = await listBrowserTabs();
  const me = bt.find(t => t.url === u) || bt.find(t => t.active) || null;
  console.log(JSON.stringify({{ url: u, title: await pg.title(), targetId: me ? me.targetId : null }}));
"""
    out = await mcp.repl_json(code, title="Opening tab", timeout=90)
    await list_tabs(force=True)
    return out


async def close_tab(target_id: str) -> dict:
    await _require_awake(target_id)
    code = _ATTACH + f"""
  const pg = await __attach({_jsq(target_id)});
  await closeTab(pg);
  console.log(JSON.stringify({{ ok: true }}));
"""
    out = await mcp.repl_json(code, title="Closing tab", timeout=60)
    await list_tabs(force=True)
    return out


async def focus_tab(target_id: str) -> dict:
    """포커스. bringToFront 가 막히면 attach 만 하고 솔직하게 focused:false 로 알린다."""
    await _require_awake(target_id)
    code = _ATTACH + f"""
  const pg = await __attach({_jsq(target_id)});
  let focused = false;
  try {{ await pg.bringToFront(); focused = true; }} catch (e) {{}}
  console.log(JSON.stringify({{ ok: true, focused, url: pg.url() }}));
"""
    out = await mcp.repl_json(code, title="Focusing tab", timeout=60)
    await list_tabs(force=True)
    return out
