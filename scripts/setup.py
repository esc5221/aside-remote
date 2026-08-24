#!/usr/bin/env python3
"""aside-remote guided setup.

Interactive:      python3 scripts/setup.py
Non-interactive:  python3 scripts/setup.py --yes            (defaults, local-only)
Service install:  python3 scripts/setup.py --install-service
Uninstall:        python3 scripts/setup.py --uninstall-service

Everything the wizard writes can also be done by hand — see README "Manual setup".
It writes exactly three things, all outside the repo:
  ~/.aside-remote/token   bearer token (0600)
  ~/.aside-remote/env     KEY=VALUE config (0600)
  ~/Library/LaunchAgents/com.aside-remote.plist   (only if you opt in)
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HOME = Path.home()
REPO = Path(__file__).resolve().parent.parent
TOKEN_FILE = HOME / ".aside-remote/token"
ENV_FILE = HOME / ".aside-remote/env"
PLIST = HOME / "Library/LaunchAgents/com.aside-remote.plist"

OK, WARN, BAD = "\033[32m✓\033[0m", "\033[33m!\033[0m", "\033[31m✗\033[0m"


def say(mark: str, msg: str) -> None:
    print(f"  {mark} {msg}")


def ask(prompt: str, default: str = "", assume_yes: bool = False) -> str:
    if assume_yes:
        return default
    tail = f" [{default}]" if default else ""
    try:
        v = input(f"  ? {prompt}{tail}: ").strip()
    except EOFError:
        return default
    return v or default


def yesno(prompt: str, default: bool, assume_yes: bool = False) -> bool:
    if assume_yes:
        return default
    d = "Y/n" if default else "y/N"
    v = ask(f"{prompt} ({d})")
    if not v:
        return default
    return v.lower().startswith("y")


# ---------------------------------------------------------------- checks
def check_prereqs() -> bool:
    print("\n[1/5] Prerequisites")
    ok = True

    if sys.version_info < (3, 10):
        say(BAD, f"Python ≥3.10 required (you have {sys.version.split()[0]})")
        ok = False
    else:
        say(OK, f"Python {sys.version.split()[0]}")

    aside = os.environ.get("ASIDE_BIN") or shutil.which("aside") or str(HOME / ".local/bin/aside")
    if Path(aside).exists():
        say(OK, f"aside CLI: {aside}")
    else:
        say(BAD, "aside CLI not found — install the Aside browser first, "
                 "then set ASIDE_BIN if it lives somewhere unusual")
        ok = False

    daemon = os.environ.get("ASIDE_DAEMON_URL", "http://127.0.0.1:21420")
    try:
        with urllib.request.urlopen(f"{daemon}/health", timeout=3) as r:
            say(OK, f"Aside daemon reachable at {daemon}" if r.status == 200
                else f"daemon answered HTTP {r.status}")
    except Exception:
        say(WARN, f"Aside daemon not reachable at {daemon} — "
                  "launch the Aside app once, then re-run (not fatal)")

    try:
        import fastapi, httpx, uvicorn, cryptography  # noqa: F401
        say(OK, "python deps present")
    except ImportError as e:
        say(BAD, f"missing python package: {e.name} — run: pip install -r requirements.txt")
        ok = False
    return ok


# ---------------------------------------------------------------- token
def ensure_token() -> None:
    print("\n[2/5] Bearer token")
    if TOKEN_FILE.exists() and TOKEN_FILE.read_text().strip():
        say(OK, f"exists: {TOKEN_FILE}")
        return
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(secrets.token_urlsafe(32) + "\n")
    TOKEN_FILE.chmod(0o600)
    say(OK, f"generated: {TOKEN_FILE} (0600)")


# ---------------------------------------------------------------- env file
def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def save_env(env: dict[str, str]) -> None:
    lines = ["# aside-remote config — see README for every key", ""]
    lines += [f"{k}={v}" for k, v in sorted(env.items()) if v]
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENV_FILE.write_text("\n".join(lines) + "\n")
    ENV_FILE.chmod(0o600)
    say(OK, f"wrote {ENV_FILE} (0600)")


def configure(assume_yes: bool) -> None:
    env = load_env()

    print("\n[3/5] Remote access (optional)")
    print("      Local-only use needs nothing here. For phone/remote access the")
    print("      recommended front is Cloudflare Tunnel + Access — see README.")
    if yesno("Configure Cloudflare Access verification now?", False, assume_yes):
        env["ASIDE_REMOTE_ACCESS_TEAM"] = ask(
            "Access team domain (e.g. yourteam.cloudflareaccess.com)",
            env.get("ASIDE_REMOTE_ACCESS_TEAM", ""))
        env["ASIDE_REMOTE_ACCESS_AUD"] = ask(
            "Access application AUD tag",
            env.get("ASIDE_REMOTE_ACCESS_AUD", ""))
        env["ASIDE_REMOTE_ACCESS_EMAILS"] = ask(
            "allowed emails (comma-separated)",
            env.get("ASIDE_REMOTE_ACCESS_EMAILS", ""))
    else:
        say(OK, "skipped — bridge stays loopback-only until you front it yourself")

    print("\n[4/5] Push notifications (optional)")
    if yesno("Send a push (ntfy protocol) when a run finishes?", False, assume_yes):
        env["ASIDE_REMOTE_NTFY"] = ask("ntfy server URL (e.g. https://ntfy.sh)",
                                      env.get("ASIDE_REMOTE_NTFY", "https://ntfy.sh"))
        env["ASIDE_REMOTE_NTFY_TOPIC"] = ask("topic", env.get("ASIDE_REMOTE_NTFY_TOPIC",
                                            "aside-" + secrets.token_hex(4)))
    save_env(env)


# ---------------------------------------------------------------- service
def install_service() -> None:
    (REPO / "logs").mkdir(exist_ok=True)      # plist 가 로그를 여기 쓴다
    tmpl = (REPO / "deploy/com.aside-remote.plist.template").read_text()
    plist = (tmpl.replace("__PYTHON__", sys.executable)
                 .replace("__REPO__", str(REPO))
                 .replace("__HOME__", str(HOME)))
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_text(plist)
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(PLIST)],
                   capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)],
                       capture_output=True, text=True)
    if r.returncode == 0:
        say(OK, f"service installed & started ({PLIST.name})")
        say(OK, "logs: <repo>/logs/bridge.err.log")
    else:
        say(BAD, f"launchctl bootstrap failed: {r.stderr.strip()}")


def uninstall_service() -> None:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(PLIST)], capture_output=True)
    if PLIST.exists():
        PLIST.unlink()
    say(OK, "service removed")


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yes", action="store_true", help="accept defaults, no prompts")
    ap.add_argument("--install-service", action="store_true", help="install launchd service and exit")
    ap.add_argument("--uninstall-service", action="store_true", help="remove launchd service and exit")
    a = ap.parse_args()

    if a.uninstall_service:
        uninstall_service(); return 0
    if a.install_service:
        install_service(); return 0

    print("aside-remote setup")
    if not check_prereqs():
        print("\nfix the ✗ items above, then re-run.")
        return 1
    ensure_token()
    configure(a.yes)

    print("\n[5/5] Run it")
    if sys.platform == "darwin" and yesno("Install as a launchd service (auto-start)?",
                                          False, a.yes):
        install_service()
    else:
        say(OK, f"manual start:  python3 {REPO / 'server.py'}")
    print(f"\nDone. Open http://127.0.0.1:8799/ — on localhost the token is picked up "
          f"automatically.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
