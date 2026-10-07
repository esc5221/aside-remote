"""`aside exec` 실행 관리.

실측 사실:
  - 파이프로 실행하면 stdout 0바이트. TTY 가 있어야 동작한다 → pty 필수.
  - PTY 를 주면 최종 답변만 깔끔하게 나온다. 중간 과정(thinking/tool)은 안 나온다.
  - 중간 과정은 messages.jsonl 에 실시간으로 쌓인다 → 스트리밍은 sessions.tail_messages 담당.
  - exec 는 자기 session id 를 출력하지 않는다. 새로 생긴 세션 디렉토리로 역추적해야 한다.
    그래서 신규 실행은 뮤텍스로 직렬화한다. (데스크탑에서 동시에 Aside 를 쓰면 오탐 가능 —
    이 설계의 유일한 취약점이라 로그를 남긴다.)

CLI 인터페이스(2026-09-09 실측, `aside --help`):
  - 새 실행:  aside exec [--account/--host/-m/-p/-s/--effort/--permission] <prompt>
  - 이어하기: aside session resume <id> [prompt]      ← `exec --session` 은 삭제됐다
  - 중단:     aside session stop <id>                  ← 데몬 쪽 에이전트를 실제로 멈춘다
  - 그 외:    session list/steer/queue/archive/delete
  resume/stop 계열은 --account 만 받는다. 모델·effort·speed 옵션은 exec 에만 있다.
"""
from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import pty
import re
import shutil
import signal
import struct
import termios
import time
from dataclasses import dataclass, field

import config
import sessions

log = logging.getLogger("aside-remote.runner")
SESSION_NOT_FOUND_MESSAGE = "대화를 찾을 수 없습니다"

session_lock = asyncio.Lock()


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


def _account_args() -> list[str]:
    return ["--account", config.ASIDE_ACCOUNT] if config.ASIDE_ACCOUNT else []


def _exec_opts(*, model: str | None = None, effort: str | None = None,
               speed: str | None = None, provider: str | None = None,
               permission: str | None = None, host: str | None = None) -> list[str]:
    """`aside exec` 전용 옵션. resume/stop 은 이걸 못 받는다."""
    args = _account_args()
    if host:
        args += ["--host", host]
    if model:
        args += ["-m", model]
    if provider:
        args += ["-p", provider]
    if speed:
        args += ["-s", speed]
    if effort:
        args += ["--effort", effort]
    if permission:
        args += ["--permission", permission]
    return args


async def list_session_ids() -> list[str]:
    """`aside session list` 의 id 목록(최신순). 실패하면 빈 리스트."""
    try:
        return [s["id"] for s in await sessions.live_sessions()]
    except Exception:
        log.warning("session list failed", exc_info=True)
        return []


def _newest_real_dir(names: set[str]) -> str | None:
    """디렉토리 fallback. messages.jsonl 이 있는 것만 진짜 세션으로 친다.

    데몬이 5~6초마다 빈 세션 디렉토리를 만들어 두는 게 관측된다(2026-09-09).
    빈 껍데기를 잡으면 존재하지 않는 세션 id 를 물게 되므로 반드시 걸러야 한다.
    """
    real = [n for n in names if (config.SESSIONS_DIR / n / "messages.jsonl").exists()]
    if not real:
        return None
    return max(real, key=lambda n: (config.SESSIONS_DIR / n).stat().st_mtime)


async def start_run(prompt: str, *, model: str | None = None, effort: str | None = None,
                    speed: str | None = None, provider: str | None = None,
                    permission: str | None = None, host: str | None = None) -> Run:
    """새 세션 실행. 세션 id 가 확정될 때까지 기다렸다가 Run 을 돌려준다.

    id 확정은 `aside session list` 의 diff 가 1순위다. 디렉토리 diff 는 데몬이
    5~6 초마다 만드는 빈 세션 디렉토리 때문에 단독으로는 못 믿는다.
    """
    args = ["exec", *_exec_opts(model=model, effort=effort, speed=speed,
                                provider=provider, permission=permission, host=host),
            prompt]

    async with session_lock:
        before_ids = set(await list_session_ids())
        before_dirs = sessions.snapshot_dirs()
        proc, master = await _spawn(args)
        run = Run(session_id=None, prompt=prompt, proc=proc, master_fd=master)
        _orphans.append(run)
        asyncio.create_task(_drain(run))

        deadline = time.time() + config.RUN_SESSION_DETECT_SEC
        sid = None
        while time.time() < deadline:
            await asyncio.sleep(0.5)
            for cand in await list_session_ids():      # 최신순
                if cand not in before_ids:
                    sid = cand
                    break
            if sid:
                break
            new_dirs = sessions.snapshot_dirs() - before_dirs
            hit = _newest_real_dir(new_dirs) if new_dirs else None
            if hit:
                sid = hit.split("_", 1)[1]
                log.info("session id resolved by dir fallback: %s", sid)
                break
            if not run.running:
                break

        if sid:
            run.session_id = sid
            # exec 세션은 ephemeral=1 로 태어나 데몬 재시작 때 퍼지된다.
            # 태어나자마자 영속화해 두면 재시작 후에도 이어쓰기가 된다.
            try:
                import daemondb
                await asyncio.to_thread(daemondb.persist, sid)
            except Exception:
                pass
            sessions._reindex()
            _orphans.remove(run)
            _runs[sid] = run
            log.info("run started session=%s", sid)
            return run

        run.error = "세션 id 를 확인하지 못했습니다 (exec 가 즉시 종료됐거나 Aside 가 응답하지 않음)"
        log.error("%s · exit=%s output=%s", run.error, run.exit_code, run.output[:300])
        return run


async def continue_run(session_id: str, prompt: str, *, model: str | None = None,
                       effort: str | None = None, speed: str | None = None,
                       provider: str | None = None, permission: str | None = None,
                       host: str | None = None) -> Run:
    """기존 세션 이어하기. 디렉토리를 이미 아니까 탐지 과정이 없다 = 안전하다.

    `aside session resume <id> <prompt>` 를 쓴다. 이 서브커맨드는 --account 외의
    옵션(-m/--effort/-s/--permission/--host)을 받지 않는다 — 넘기면 unknown option 으로
    죽는다. 세션이 만들어질 때의 설정을 그대로 이어간다. 호출부 호환을 위해 인자는
    받되 무시하고 로그만 남긴다.
    """
    ignored = {k: v for k, v in (("model", model), ("effort", effort), ("speed", speed),
                                 ("provider", provider), ("permission", permission),
                                 ("host", host)) if v}
    if ignored:
        log.info("resume ignores exec-only options %s (session=%s)", ignored, session_id)

    args = ["session", "resume", *_account_args(), session_id, prompt]
    async with session_lock:
        if sessions.session_dir(session_id) is None:
            raise FileNotFoundError(SESSION_NOT_FOUND_MESSAGE)
        existing = _runs.get(session_id)
        if existing and existing.running:
            raise FileExistsError("이미 실행 중입니다")
        proc, master = await _spawn(args)
        run = Run(session_id=session_id, prompt=prompt, proc=proc, master_fd=master)
        _runs[session_id] = run
        asyncio.create_task(_drain(run))
    log.info("run continued session=%s", session_id)
    return run


async def abort(session_id: str) -> bool:
    """세션을 실제로 중단한다.

    2026-08-24 실측 당시엔 로컬 CLI 프로세스를 죽여도 데몬 쪽 에이전트 루프가 살아 있어서
    진짜 중단은 앱 UI 에서만 가능했다. 지금 CLI 에는 `aside session stop <id>` 가 있고
    데몬에 중단을 시킨다 → 그걸 먼저 부르고, 그 다음 붙어 있던 로컬 PTY 클라이언트를 정리한다.
    stop 은 이미 끝난 세션에도 안전하다(상태 문자열만 찍고 exit 0).
    """
    stopped = await stop_session(session_id)

    run = _runs.get(session_id)
    if run and run.running:
        try:
            os.killpg(os.getpgid(run.proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                run.proc.terminate()
            except ProcessLookupError:
                pass
        log.info("run aborted session=%s", session_id)
        return True
    return stopped


async def stop_session(session_id: str) -> bool:
    """`aside session stop` 로 데몬 쪽 에이전트를 멈춘다."""
    try:
        proc = await asyncio.create_subprocess_exec(
            config.ASIDE_BIN, "session", "stop", *_account_args(), session_id,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
    except Exception:
        log.warning("session stop failed session=%s", session_id, exc_info=True)
        return False
    text = _strip_ansi(out.decode("utf-8", "replace")).strip()
    log.info("session stop session=%s rc=%s out=%s", session_id, proc.returncode, text[:120])
    return proc.returncode == 0


async def delete_session(session_id: str) -> bool:
    directory = sessions.session_dir(session_id)
    if directory is None or directory.resolve().parent != config.SESSIONS_DIR.resolve():
        return False
    proc = await asyncio.create_subprocess_exec(
        config.ASIDE_BIN, "session", "delete", *_account_args(), session_id,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except (TimeoutError, asyncio.CancelledError):
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.communicate()
        raise
    text = _strip_ansi(out.decode("utf-8", "replace")).strip()
    log.info("session delete session=%s rc=%s out=%s", session_id, proc.returncode, text[:120])
    if proc.returncode != 0 and text != "Session not found":
        return False
    try:
        await asyncio.to_thread(shutil.rmtree, directory)
    except OSError:
        log.exception("session files deletion failed session=%s", session_id)
        return False
    _runs.pop(session_id, None)
    sessions.invalidate_index()
    return True


async def steer(session_id: str, prompt: str) -> bool:
    """진행 중인 스텝을 끊고 새 지시를 넣는다 (`aside session steer`)."""
    return await _session_prompt_cmd("steer", session_id, prompt)


async def queue(session_id: str, prompt: str) -> bool:
    """현재 스텝이 끝난 뒤 이어서 실행할 지시를 넣는다 (`aside session queue`)."""
    return await _session_prompt_cmd("queue", session_id, prompt)


async def _session_prompt_cmd(cmd: str, session_id: str, prompt: str) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            config.ASIDE_BIN, "session", cmd, *_account_args(), session_id, prompt,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
    except Exception:
        log.warning("session %s failed session=%s", cmd, session_id, exc_info=True)
        return False
    log.info("session %s session=%s rc=%s out=%s", cmd, session_id, proc.returncode,
             _strip_ansi(out.decode("utf-8", "replace")).strip()[:120])
    return proc.returncode == 0
