"""데몬 세션 레지스트리(state.db) 직접 개입.

문제의 뿌리 (2026-08-25 실측):
  · 데몬 레지스트리 = ~/.aside/u/0/state.db 의 sessions 테이블 (SQLite/WAL)
  · exec 로 만든 세션은 ephemeral=1 → 데몬 재시작 때 행이 퍼지된다
  · 행이 없으면 `aside session resume` 이 "Session not found" (exit 0!)
    (2026-09-09 CLI 개편 전 이름은 `aside exec --session` 이었다)
  · 대화 원본(messages.jsonl)은 디스크에 멀쩡히 남아 있다

개입 두 가지 (둘 다 best-effort — 실패해도 실행을 막지 않는다):
  persist(sid)    새 세션의 ephemeral 을 0 으로 → 다음 재시작을 살아남는다
  resurrect(sid)  행이 없고 디스크 디렉토리가 있으면 기존 행을 본떠 재삽입
                  → 데몬은 요청마다 DB 를 읽으므로 재시작 없이 즉시 이어쓰기 가능

주의: tool_state 를 빼먹으면 기본 '{}' 이 되는데, 데몬이 toolState.skills.loaded
를 읽다가 "Cannot read properties of undefined (reading 'loaded')" 로 죽는다.
그리고 깨진 행으로 한 번 continue 를 시도하면 그 객체가 데몬 메모리에 캐시돼
행을 고쳐도 재시작 전까지 계속 실패한다 — 반드시 처음부터 완전한 행을 넣을 것.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time

import config

log = logging.getLogger("aside-remote.daemondb")

DB = config.ASIDE_USER_DIR / "state.db"

_TOOL_STATE = json.dumps({
    "todo": {"todos": []},
    "execution": {"totalRunMs": 0},
    "bash": {"cwd": str(config.ASIDE_USER_DIR)},
    "skills": {"delivered": [], "loaded": []},
})


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=3.0)
    c.execute("PRAGMA busy_timeout=3000")
    return c


def has_row(session_id: str) -> bool | None:
    """행 존재 여부. DB 를 못 열면 None (판단 보류)."""
    try:
        with _conn() as c:
            return c.execute("SELECT 1 FROM sessions WHERE id=?",
                             (session_id,)).fetchone() is not None
    except Exception:
        return None


def browser_targets(session_id: str) -> tuple[set[str], str | None]:
    with _conn() as connection:
        row = connection.execute("SELECT active_tab_target_id FROM sessions WHERE id=?", (session_id,)).fetchone()
        targets = {item[0] for item in connection.execute(
            "SELECT target_id FROM session_tabs WHERE session_id=?", (session_id,)) if item[0]}
    if row and row[0]:
        targets.add(row[0])
    return targets, row[0] if row else None


def persist(session_id: str) -> None:
    """ephemeral=1 → 0. 데몬 재시작 후에도 이어쓰기가 되게 한다."""
    try:
        with _conn() as c:
            n = c.execute("UPDATE sessions SET ephemeral=0 WHERE id=? AND ephemeral=1",
                          (session_id,)).rowcount
        if n:
            log.info("persisted session=%s (ephemeral 0)", session_id)
    except Exception:
        log.warning("persist failed session=%s", session_id, exc_info=True)


def resurrect(session_id: str) -> bool:
    """퍼지된 세션 행을 재삽입. 성공하면 True.

    템플릿은 기존 아무 행이나 쓴다 (system_prompt·model·runtime_config 재사용).
    대화 컨텍스트는 데몬이 messages.jsonl 에서 읽으므로 행은 뼈대만 맞으면 된다.
    """
    import sessions as _sessions
    d = _sessions.session_dir(session_id)
    if d is None or not (d / "messages.jsonl").exists():
        return False                        # 디스크에도 없으면 진짜 죽은 세션
    title = ""
    try:
        f = str(d / "messages.jsonl")
        title = _sessions._clean(_sessions._head_user_text(f))[:80]
    except Exception:
        pass
    now = int(time.time())
    try:
        st = d.stat()
        created = int(st.st_mtime)
    except OSError:
        created = now
    try:
        with _conn() as c:
            if c.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone():
                return True                 # 그새 생겼으면 할 일 없음
            n = c.execute(
                """INSERT INTO sessions (id, project_id, title, trigger, status,
                     system_prompt, model, permission_mode, permission, context_window,
                     queued_messages, steering_messages, cwd, tool_state, incognito,
                     ephemeral, runtime_config, read_at,
                     latest_compaction_message_offset, created_at, updated_at)
                   SELECT ?, project_id, ?, trigger, 'idle',
                     system_prompt, model, permission_mode, permission,
                     '{"usedTokens":50000,"totalTokens":272000}',
                     '[]', '[]', cwd, ?, 0,
                     0, runtime_config, ?, 0, ?, ?
                   FROM sessions ORDER BY updated_at DESC LIMIT 1""",
                (session_id, title or "복원된 대화", _TOOL_STATE, now, created, created),
            ).rowcount
        if n:
            log.info("resurrected session=%s (%s)", session_id, title[:30])
            return True
        return False
    except Exception:
        log.warning("resurrect failed session=%s", session_id, exc_info=True)
        return False


def ensure_alive(session_id: str) -> None:
    """continue 직전 호출. 행이 없으면 부활시킨다. 어떤 실패도 삼킨다."""
    if has_row(session_id) is False:
        resurrect(session_id)
