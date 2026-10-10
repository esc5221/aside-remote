"""Authenticated local daemon access through the installed, signed Aside CLI."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import time

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

import config

ACCOUNT_ID = int(config.ASIDE_ACCOUNT.lstrip("u") or "0")
AUTH_CHALLENGE_PATH = "/auth/daemon/challenge"
AUTH_SESSION_PATH = "/auth/daemon/session"


class DaemonClient:
    def __init__(self):
        self._token = ""
        self._expires = 0.0
        self._auth_lock = asyncio.Lock()

    async def _authorize(self):
        async with self._auth_lock:
            if self._token and time.monotonic() < self._expires:
                return
            relay = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
            is_ready = asyncio.Event()
            challenge_id = None

            @relay.get(AUTH_CHALLENGE_PATH)
            async def challenge():
                nonlocal challenge_id
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.get(config.DAEMON_URL + AUTH_CHALLENGE_PATH,
                                                params={"clientKind": "cli"})
                response.raise_for_status()
                value = response.json()
                challenge_id = value["challengeId"]
                return value

            @relay.post(AUTH_SESSION_PATH)
            async def authorize(request: Request):
                value = await request.json()
                if not isinstance(value, dict) or not challenge_id or value.get("challengeId") != challenge_id:
                    raise HTTPException(401)
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.post(config.DAEMON_URL + AUTH_SESSION_PATH, json=value)
                if response.is_success:
                    credentials = response.json()
                    self._token = credentials["access_token"]
                    self._expires = time.monotonic() + credentials["expiresInSeconds"] - 10
                    is_ready.set()
                return JSONResponse(response.json(), status_code=response.status_code)

            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            sock.setblocking(False)
            server = uvicorn.Server(uvicorn.Config(relay, log_level="critical", access_log=False))
            task = asyncio.create_task(server.serve(sockets=[sock]))
            proc = None
            try:
                async with asyncio.timeout(20):
                    while not server.started:
                        if task.done():
                            await task
                            raise ConnectionError("Daemon authorization unavailable.")
                        await asyncio.sleep(.01)
                    proc = await asyncio.create_subprocess_exec(
                        config.ASIDE_BIN, "--host", "local", "session", "list",
                        *(["--account", config.ASIDE_ACCOUNT] if config.ASIDE_ACCOUNT else []),
                        env={**os.environ, "DAEMON_BASE_URL": f"http://127.0.0.1:{sock.getsockname()[1]}"},
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    )
                    await is_ready.wait()
            finally:
                if proc and proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        proc.terminate()
                if proc:
                    await proc.wait()
                server.should_exit = True
                await task
                sock.close()

    async def request(self, path: str, value: dict, *, mutation: bool = False):
        await self._authorize()
        async with httpx.AsyncClient(timeout=45) as client:
            for attempt in range(2):
                response = await client.request(
                    "POST" if mutation else "GET", config.DAEMON_URL + path,
                    headers={"Authorization": "AsideDaemonSessionToken " + self._token},
                    **({"json": value} if mutation else {"params": {"input": json.dumps(value)}}),
                )
                if response.status_code != 401 or attempt:
                    response.raise_for_status()
                    return response.json()
                self._token = ""
                await self._authorize()

    async def call(self, procedure: str, value: dict, *, mutation: bool = False):
        return (await self.request("/trpc/" + procedure, value, mutation=mutation))["result"]["data"]

    async def extension(self, method: str, params: dict, binding: dict):
        return await self.request("/extension-bridge/command", {
            "command": {"method": method, "params": params},
            "route": {"accountId": ACCOUNT_ID, **{key: binding[key] for key in
                     ("profileId", "browserMode", "windowId") if key in binding}},
        }, mutation=True)


daemon = DaemonClient()


async def repair_browser_binding(session_id: str):
    session = await daemon.call("sessions.get", {"accountId": ACCOUNT_ID, "sessionId": session_id})
    binding = session.get("browserBinding")
    if not binding:
        resolver = await daemon.call("cli.replStart", {"accountId": ACCOUNT_ID}, mutation=True)
        try:
            value = await daemon.call("cli.replRun", {"accountId": ACCOUNT_ID, "id": resolver["id"],
                "code": "console.log(JSON.stringify(aside.sessions.current().id));"}, mutation=True)
            resolver_id = json.loads(next(block["text"] for block in value["content"] if block.get("type") == "text"))
            current = await daemon.call("sessions.get", {"accountId": ACCOUNT_ID, "sessionId": resolver_id})
            binding = current["browserBinding"]
        finally:
            await daemon.call("cli.replClose", {"accountId": ACCOUNT_ID, "id": resolver["id"]}, mutation=True)
    if binding.get("browserMode") != "default":
        return
    route = {key: binding[key] for key in ("profileId", "browserMode")}
    windows = await daemon.extension("Aside.callExtensionMV3Api", {"method": "chrome.windows.getAll", "args": [{}]}, route)
    if session.get("browserBinding") and any(window["id"] == binding.get("windowId") and not window.get("incognito") for window in windows):
        return
    current = await daemon.extension("Aside.resolveBindingWindow", {}, route)
    if current.get("status") != "ok":
        raise ConnectionError("No browser window is available for this conversation.")
    candidate = {**route, "windowId": current["windowId"]}
    if current.get("anchorTargetId"):
        candidate["anchorTargetId"] = current["anchorTargetId"]
    await daemon.call("sessions.update", {"accountId": ACCOUNT_ID, "sessionId": session_id,
                                          "browserBinding": candidate}, mutation=True)
