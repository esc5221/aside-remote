"""`aside exec` 실행 관리.

실측 사실:
  - 파이프로 실행하면 stdout 0바이트. TTY 가 있어야 동작한다 → pty 필수.
  - PTY 를 주면 최종 답변만 깔끔하게 나온다. 중간 과정(thinking/tool)은 안 나온다.
  - 중간 과정은 messages.jsonl 에 실시간으로 쌓인다 → 스트리밍은 sessions.tail_messages 담당.
  - exec 는 자기 session id 를 출력하지 않는다. 새로 생긴 세션 디렉토리로 역추적해야 한다.
    그래서 신규 실행은 뮤텍스로 직렬화한다. (데스크탑에서 동시에 Aside 를 쓰면 오탐 가능 —
    이 설계의 유일한 취약점이라 로그를 남긴다.)
"""
from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import pty
import signal
import struct
import termios
import time
from dataclasses import dataclass, field

import config
import sessions

log = logging.getLogger("aside-remote.runner")

_spawn_lock = asyncio.Lock()


@dataclass
class Run:
    session_id: str | None
    prompt: str
    proc: asyncio.subprocess.Process
    master_fd: int
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    exit_code: int | None = None
    output: str = ""
    error: str | None = None

    @property
    def running(self) -> bool:
        return self.finished_at is None


_runs: dict[str, Run] = {}          # session_id -> Run
_orphans: list[Run] = []            # session_id 미확정 상태의 실행


def get_run(session_id: str) -> Run | None:
    return _runs.get(session_id)


def running_ids() -> list[str]:
    return [sid for sid, r in _runs.items() if r.running]


def _open_pty() -> tuple[int, int]:
    master, slave = pty.openpty()
    # TUI 가 좁은 폭으로 줄바꿈하지 않도록 넉넉히
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    except OSError:
        pass
    return master, slave


async def _drain(run: Run) -> None:
    """PTY master 를 끝까지 읽어 최종 답변을 모은다."""
    loop = asyncio.get_running_loop()
    chunks: list[bytes] = []
    fd = run.master_fd

    def _read() -> bytes | None:
        try:
            return os.read(fd, 65536)
        except OSError:
            return None

    while True:
        data = await loop.run_in_executor(None, _read)
        if not data:
            break
        chunks.append(data)
    raw = b"".join(chunks).decode("utf-8", "replace")
    run.output = _strip_ansi(raw).strip()
    try:
        os.close(fd)
    except OSError:
        pass
    run.exit_code = await run.proc.wait()
    run.finished_at = time.time()
    log.info("run finished session=%s exit=%s len=%d",
             run.session_id, run.exit_code, len(run.output))


def _strip_ansi(s: str) -> str:
    import re
    s = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", s)
    s = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", s)
    s = re.sub(r"\x1b[=>()][A-Za-z0-9]?", "", s)
    return s.replace("\r\n", "\n").replace("\r", "\n")


async def _spawn(args: list[str]) -> tuple[asyncio.subprocess.Process, int]:
    master, slave = _open_pty()
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    proc = await asyncio.create_subprocess_exec(
        config.ASIDE_BIN, *args,
        stdin=slave, stdout=slave, stderr=slave,
        env=env, start_new_session=True,
    )
    os.close(slave)
    return proc, master


async def start_run(prompt: str, *, model: str | None = None, effort: str | None = None,
                    speed: str | None = None) -> Run:
    """새 세션 실행. 세션 id 가 확정될 때까지 기다렸다가 Run 을 돌려준다."""
    args = ["exec"]
    if model:
        args += ["-m", model]
    if effort:
        args += ["--effort", effort]
    if speed:
        args += ["-s", speed]
    args.append(prompt)

    async with _spawn_lock:
        before = sessions.snapshot_dirs()
        proc, master = await _spawn(args)
        run = Run(session_id=None, prompt=prompt, proc=proc, master_fd=master)
        _orphans.append(run)
        asyncio.create_task(_drain(run))

        deadline = time.time() + config.RUN_SESSION_DETECT_SEC
        while time.time() < deadline:
            await asyncio.sleep(0.2)
            new = sessions.snapshot_dirs() - before
            if new:
                if len(new) > 1:
                    log.warning("multiple new session dirs detected: %s — picking newest", new)
                newest = max(new, key=lambda n: (config.SESSIONS_DIR / n).stat().st_mtime)
                run.session_id = newest.split("_", 1)[1]
                sessions._reindex()
                _orphans.remove(run)
                _runs[run.session_id] = run
                log.info("run started session=%s", run.session_id)
                return run
            if not run.running:
                break

        run.error = "세션 디렉토리를 찾지 못했습니다 (exec 가 즉시 종료됐거나 Aside 가 응답하지 않음)"
        log.error("%s · exit=%s output=%s", run.error, run.exit_code, run.output[:300])
        return run


async def continue_run(session_id: str, prompt: str, *, model: str | None = None,
                       effort: str | None = None, speed: str | None = None) -> Run:
    """기존 세션 이어하기. 디렉토리를 이미 아니까 탐지 과정이 없다 = 안전하다."""
    args = ["exec", "--session", session_id]
    if model:
        args += ["-m", model]
    if effort:
        args += ["--effort", effort]
    if speed:
        args += ["-s", speed]
    args.append(prompt)
    proc, master = await _spawn(args)
    run = Run(session_id=session_id, prompt=prompt, proc=proc, master_fd=master)
    _runs[session_id] = run
    asyncio.create_task(_drain(run))
    log.info("run continued session=%s", session_id)
    return run


def abort(session_id: str) -> bool:
    """로컬 CLI 프로세스만 죽인다. **에이전트 실행 자체는 안 멈춘다.**

    실측(2026-08-24): SIGTERM/SIGINT 어느 쪽을 보내도 데몬은 `status=running` 을 유지하고
    messages.jsonl 도 계속 자란다. `aside exec` 은 데몬에 붙은 얇은 클라이언트일 뿐이라
    프로세스를 죽여도 데몬 쪽 에이전트 루프는 살아있다.
    데몬의 중단 경로(`/agent`)는 설치키 서명 인증 뒤에 있고, REPL 의 `aside.sessions` 에도
    abort/stop/cancel 계열 메서드가 없다(current/list/get/messages/update/archive/… 뿐).
    → 진짜 중단은 Aside 앱 UI 에서만 가능하다.
    """
    run = _runs.get(session_id)
    if not run or not run.running:
        return False
    try:
        os.killpg(os.getpgid(run.proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            run.proc.terminate()
        except ProcessLookupError:
            return False
    log.info("run aborted session=%s", session_id)
    return True
