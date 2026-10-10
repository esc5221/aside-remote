"""`aside exec` 실행 관리.

실측 사실:
  - 파이프로 실행하면 stdout 0바이트. TTY 가 있어야 동작한다 → pty 필수.
  - PTY 를 주면 최종 답변만 깔끔하게 나온다. 중간 과정(thinking/tool)은 안 나온다.
  - 중간 과정은 messages.jsonl 에 실시간으로 쌓인다 → 스트리밍은 sessions.tail_messages 담당.
  - Final-answer text deltas come from the CLI's hidden --log-dump raw-event stream.
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
import json
import logging
import os
import pty
import re
import shutil
import signal
import struct
import tempfile
import termios
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import config
from daemon import repair_browser_binding
import sessions

log = logging.getLogger("aside-remote.runner")
SESSION_NOT_FOUND_MESSAGE = "Conversation not found"
RUN_ALREADY_RUNNING_MESSAGE = "This conversation is already running"
RUN_FAILED_MESSAGE = "The response could not start. Please try again."
BROWSER_DISCONNECTED_MESSAGE = "Connect the Aside browser on your Mac, then try again."
_STREAM_POLL_SEC = 0.05
_BROWSER_START_RETRY_DELAYS = (1, 2)

session_lock = asyncio.Lock()


@dataclass
class Run:
    session_id: str | None
    prompt: str
    proc: asyncio.subprocess.Process
    master_fd: int
    stream_log_path: str
    stream_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    exit_code: int | None = None
    output: str = ""
    error: str | None = None
    is_aborted: bool = False
    canonical_start_seq: int = 0
    stream_snapshot: dict | None = None
    stream_complete: bool = False
    stream_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=256))

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
    if run.exit_code:
        run.error = safe_run_error(run.output)
        log.error("run failed session=%s exit=%s output=%s",
                  run.session_id, run.exit_code, run.output)
    log.info("run finished session=%s exit=%s len=%d",
             run.session_id, run.exit_code, len(run.output))


def safe_run_error(error: object = None) -> str:
    detail = _strip_ansi(str(error or "")).lower()
    if detail == BROWSER_DISCONNECTED_MESSAGE.lower():
        return BROWSER_DISCONNECTED_MESSAGE
    if detail == RUN_FAILED_MESSAGE.lower():
        return RUN_FAILED_MESSAGE
    if (("browser profile" in detail or "chrome extension" in detail) and
            ("not connected" in detail or "disconnected" in detail)):
        return BROWSER_DISCONNECTED_MESSAGE
    return RUN_FAILED_MESSAGE


def _assistant_text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    return "".join(
        block.get("text", "")
        for block in message.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def _publish_stream(run: Run, snapshot: dict) -> None:
    run.stream_snapshot = snapshot
    while run.stream_queue.full():
        try:
            run.stream_queue.get_nowait()
        except asyncio.QueueEmpty:
            break
    run.stream_queue.put_nowait(snapshot)


async def _tail_stream_log(run: Run) -> None:
    """Read the CLI's hidden raw-event dump and retain only final-answer text deltas."""
    offset, buf = 0, b""
    assistant_index = 0
    current: dict | None = None
    stable_after_finish = 0
    try:
        while run.running or stable_after_finish < 3:
            changed = False
            try:
                size = os.path.getsize(run.stream_log_path)
                if size < offset:
                    offset, buf = 0, b""
                if size > offset:
                    with open(run.stream_log_path, "rb") as fh:
                        fh.seek(offset)
                        chunk = fh.read(size - offset)
                    offset = size
                    buf += chunk
                    changed = True
                    *lines, buf = buf.split(b"\n")
                    for raw in lines:
                        try:
                            event = json.loads(raw)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
                        event_type = event.get("type")
                        message = event.get("message")
                        if (event_type == "message_start" and isinstance(message, dict)
                                and message.get("role") == "assistant"):
                            assistant_index += 1
                            run.stream_snapshot = None
                            current = {
                                "runId": run.stream_id,
                                "streamId": f"{run.stream_id}:{assistant_index}",
                                "revision": 0,
                                "text": "",
                                "done": False,
                            }
                            if isinstance(message.get("timestamp"), (int, float)):
                                current["messageTs"] = message["timestamp"]
                            if isinstance(message.get("responseId"), str):
                                current["responseId"] = message["responseId"]
                            continue
                        if event_type == "message_update" and current is not None:
                            update = event.get("assistantMessageEvent")
                            if not isinstance(update, dict) or update.get("type") != "text_delta":
                                continue
                            delta = update.get("delta")
                            if not isinstance(delta, str) or not delta:
                                continue
                            current = {**current, "revision": current["revision"] + 1,
                                       "text": current["text"] + delta}
                            _publish_stream(run, current)
                            continue
                        if (event_type == "message_end" and current is not None
                                and isinstance(message, dict) and message.get("role") == "assistant"):
                            text = _assistant_text(message)
                            current = {**current, "revision": current["revision"] + 1,
                                       "text": text or current["text"], "done": True}
                            if isinstance(message.get("timestamp"), (int, float)):
                                current["messageTs"] = message["timestamp"]
                            if isinstance(message.get("responseId"), str):
                                current["responseId"] = message["responseId"]
                            _publish_stream(run, current)
                            current = None
            except OSError:
                pass
            if run.running:
                await asyncio.sleep(_STREAM_POLL_SEC)
                continue
            stable_after_finish = 0 if changed else stable_after_finish + 1
            await asyncio.sleep(_STREAM_POLL_SEC)
        if current is not None and current["text"] and not current["done"]:
            current = {**current, "revision": current["revision"] + 1, "done": True}
            _publish_stream(run, current)
    finally:
        run.stream_complete = True
        _remove_stream_log(run.stream_log_path)


async def stream_events(run: Run):
    while not run.stream_complete or not run.stream_queue.empty():
        try:
            yield await asyncio.wait_for(run.stream_queue.get(), timeout=0.2)
        except TimeoutError:
            continue


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
    try:
        proc = await asyncio.create_subprocess_exec(
            config.ASIDE_BIN, *args,
            stdin=slave, stdout=slave, stderr=slave,
            env=env, start_new_session=True,
        )
    except BaseException:
        os.close(master)
        raise
    finally:
        os.close(slave)
    return proc, master


def _stream_log() -> str:
    fd, path = tempfile.mkstemp(prefix="aside-remote-stream-", suffix=".jsonl")
    os.close(fd)
    return path


def _remove_stream_log(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        log.exception("stream log deletion failed path=%s", path)


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
    options = dict(model=model, effort=effort, speed=speed, provider=provider,
                   permission=permission, host=host)
    async with session_lock:
        run = await _start_run(prompt, **options)
        if host not in (None, "local") or not _can_recover_browser_start(run):
            return run
        if not await _reopen_browser_profile():
            return run
        for delay in _BROWSER_START_RETRY_DELAYS:
            await asyncio.sleep(delay)
            log.info("retrying conversation start after reopening browser profile")
            run = await _start_run(prompt, **options)
            if not _can_recover_browser_start(run):
                break
        return run


def _can_recover_browser_start(run: Run) -> bool:
    if run.session_id or run.running or not run.exit_code or run.stream_snapshot:
        return False
    detail = "\n".join(line for line in _strip_ansi(run.output).lower().splitlines()
                       if not line.startswith("aside cli ")).strip()
    return ((detail.startswith("aside browser profile for account ") and
             "is not connected to the daemon." in detail) or
            detail == "chrome extension not connected for the requested browser profile" or
            detail.startswith("no browser window is open for account ") or
            (detail.startswith("aside browser reports ") and
             "tabs may be parked in a background window after a profile switch" in detail))


async def _reopen_browser_profile() -> bool:
    try:
        registry = json.loads((Path.home() / ".aside/accounts.json").read_text())
        if not isinstance(registry, dict):
            return False
        account = config.ASIDE_ACCOUNT
        account_id = int(account.removeprefix("u")) if account else registry["currentAccountId"]
        profile_bindings = registry.get("profileAccountBindings", {})
        if not isinstance(profile_bindings, dict):
            return False
        bindings = [binding for binding in profile_bindings.values()
                    if isinstance(binding, dict) and binding.get("accountId") == account_id]
        if len(bindings) != 1:
            return False
        profile_path = Path(bindings[0]["profilePath"])
        if not profile_path.is_absolute() or not profile_path.is_dir():
            return False
        preferences = json.loads((profile_path / "Preferences").read_text())
        if not isinstance(preferences, dict):
            return False
        aside = preferences.get("aside", {})
        if not isinstance(aside, dict) or aside.get("profile_id") != bindings[0]["profileId"]:
            return False
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/open", "-g", "-n", "-a", "Aside", "--args",
            f"--user-data-dir={profile_path.parent}",
            f"--profile-directory={profile_path.name}", "chrome://newtab/",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        return await proc.wait() == 0
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("could not reopen the account's existing browser profile", exc_info=True)
        return False


async def _start_run(prompt: str, *, model: str | None = None, effort: str | None = None,
                     speed: str | None = None, provider: str | None = None,
                     permission: str | None = None, host: str | None = None) -> Run:
    """새 세션 실행. 세션 id 가 확정될 때까지 기다렸다가 Run 을 돌려준다.

    id 확정은 `aside session list` 의 diff 가 1순위다. 디렉토리 diff 는 데몬이
    5~6 초마다 만드는 빈 세션 디렉토리 때문에 단독으로는 못 믿는다.
    """
    stream_log_path = _stream_log()
    args = ["--log-dump", stream_log_path, "exec",
            *_exec_opts(model=model, effort=effort, speed=speed,
                        provider=provider, permission=permission, host=host), prompt]

    before_ids = set(await list_session_ids())
    before_dirs = sessions.snapshot_dirs()
    try:
        proc, master = await _spawn(args)
    except Exception:
        _remove_stream_log(stream_log_path)
        raise
    run = Run(session_id=None, prompt=prompt, proc=proc, master_fd=master,
              stream_log_path=stream_log_path)
    _orphans.append(run)
    asyncio.create_task(_drain(run))
    asyncio.create_task(_tail_stream_log(run))

    deadline = time.time() + config.RUN_SESSION_DETECT_SEC
    sid = None
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        if not run.running and run.exit_code:
            break
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

    if run in _orphans:
        _orphans.remove(run)
    run.error = run.error or safe_run_error(run.output)
    log.error("conversation start failed · exit=%s output=%s", run.exit_code, run.output)
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

    stream_log_path = _stream_log()
    args = ["--log-dump", stream_log_path,
            "session", "resume", *_account_args(), session_id, prompt]
    async with session_lock:
        if sessions.session_dir(session_id) is None:
            _remove_stream_log(stream_log_path)
            raise FileNotFoundError(SESSION_NOT_FOUND_MESSAGE)
        existing = _runs.get(session_id)
        if existing and existing.running:
            _remove_stream_log(stream_log_path)
            raise FileExistsError(RUN_ALREADY_RUNNING_MESSAGE)
        try:
            await repair_browser_binding(session_id)
            messages, _offset = await asyncio.to_thread(sessions.read_messages, session_id)
            next_seq = messages[-1]["seq"] + 1 if messages else 0
            proc, master = await _spawn(args)
        except Exception:
            _remove_stream_log(stream_log_path)
            raise
        run = Run(session_id=session_id, prompt=prompt, proc=proc, master_fd=master,
                  stream_log_path=stream_log_path, canonical_start_seq=next_seq)
        _runs[session_id] = run
        asyncio.create_task(_drain(run))
        asyncio.create_task(_tail_stream_log(run))
    log.info("run continued session=%s", session_id)
    return run


async def abort(session_id: str) -> bool:
    """세션을 실제로 중단한다.

    2026-08-24 실측 당시엔 로컬 CLI 프로세스를 죽여도 데몬 쪽 에이전트 루프가 살아 있어서
    진짜 중단은 앱 UI 에서만 가능했다. 지금 CLI 에는 `aside session stop <id>` 가 있고
    데몬에 중단을 시킨다 → 그걸 먼저 부르고, 그 다음 붙어 있던 로컬 PTY 클라이언트를 정리한다.
    stop 은 이미 끝난 세션에도 안전하다(상태 문자열만 찍고 exit 0).
    """
    run = _runs.get(session_id)
    if run and run.running:
        run.is_aborted = True
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
        out, _ = await _communicate(proc, timeout=15)
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
    out, _ = await _communicate(proc, timeout=30)
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


async def _communicate(proc: asyncio.subprocess.Process, *, timeout: float) -> tuple[bytes, bytes | None]:
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (TimeoutError, asyncio.CancelledError):
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.communicate()
        raise


async def steer(session_id: str, prompt: str) -> bool:
    """진행 중인 스텝을 끊고 새 지시를 넣는다 (`aside session steer`)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            config.ASIDE_BIN, "session", "steer", *_account_args(), session_id, prompt,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await _communicate(proc, timeout=15)
    except Exception:
        log.warning("session steer failed session=%s", session_id, exc_info=True)
        return False
    log.info("session steer session=%s rc=%s out=%s", session_id, proc.returncode,
             _strip_ansi(out.decode("utf-8", "replace")).strip()[:120])
    return proc.returncode == 0
