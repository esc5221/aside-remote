"""Encrypted completion notifications for registered browser installations."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

log = logging.getLogger("aside-remote.web-push")
FOCUS_LEASE_SEC = 25
PUSH_TTL_SEC = 60 * 60
PUSH_TIMEOUT_SEC = 10
MAX_PUSH_PAYLOAD_BYTES = 4096 - 103  # AES128GCM header, authentication tag and delimiter.
SUBSCRIPTION_LIMIT = 64
PUSH_HOSTS = ("web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com")
INVALID_SUBSCRIPTION = "Invalid notification subscription."


def _decode_key(value: object, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 4 * ((length + 2) // 3):
        raise ValueError(INVALID_SUBSCRIPTION)
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except ValueError:
        raise ValueError(INVALID_SUBSCRIPTION) from None
    if len(decoded) != length:
        raise ValueError(INVALID_SUBSCRIPTION)
    return decoded


def validate_subscription(payload: dict) -> dict:
    subscription = payload.get("subscription")
    origin = payload.get("origin")
    if not isinstance(subscription, dict) or not isinstance(origin, str) or len(origin) > 512:
        raise ValueError(INVALID_SUBSCRIPTION)
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > 4096 or not isinstance(keys, dict):
        raise ValueError(INVALID_SUBSCRIPTION)
    try:
        push_url = urlsplit(endpoint)
        app_url = urlsplit(origin)
        is_push_host = push_url.hostname in PUSH_HOSTS or bool(
            push_url.hostname and push_url.hostname.endswith(".notify.windows.com")
        )
        is_local_origin = app_url.scheme == "http" and app_url.hostname in ("localhost", "127.0.0.1", "::1")
        if (push_url.scheme != "https" or not is_push_host or push_url.port not in (None, 443)
                or push_url.username or push_url.password or push_url.fragment
                or (app_url.scheme != "https" and not is_local_origin)
                or not app_url.hostname or app_url.username or app_url.password
                or app_url.path not in ("", "/") or app_url.query or app_url.fragment):
            raise ValueError
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _decode_key(keys.get("p256dh"), 65))
        _decode_key(keys.get("auth"), 16)
    except ValueError:
        raise ValueError(INVALID_SUBSCRIPTION) from None
    return {
        "subscription": {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}},
        "origin": origin.rstrip("/"),
    }


class WebPushStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.key_path = directory / "vapid.pem"
        self.subscriptions_path = directory / "subscriptions.json"
        self.subscriptions: dict[str, dict] = {}
        self._presence: dict[tuple[str, str], tuple[int, float, bool]] = {}
        self._send_slots = asyncio.Semaphore(4)
        try:
            raw = json.loads(self.subscriptions_path.read_text())
            if isinstance(raw, dict):
                for item in raw.values():
                    if isinstance(item, dict):
                        record = validate_subscription(item)
                        self.subscriptions[self._id(record)] = record
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            log.error("Could not read saved notification subscriptions.")

    @staticmethod
    def _id(record: dict) -> str:
        return hashlib.sha256(record["subscription"]["endpoint"].encode()).hexdigest()

    def public_key(self) -> str:
        self.directory.mkdir(parents=True, exist_ok=True)
        if not self.key_path.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption())
            fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(data)
        key = serialization.load_pem_private_key(self.key_path.read_bytes(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("Invalid notification signing key.")
        data = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return base64.urlsafe_b64encode(data).decode().rstrip("=")

    def _save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.subscriptions_path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(self.subscriptions, output, ensure_ascii=False)
        temporary.replace(self.subscriptions_path)

    def subscribe(self, record: dict) -> str:
        subscription_id = self._id(record)
        if subscription_id not in self.subscriptions and len(self.subscriptions) >= SUBSCRIPTION_LIMIT:
            raise ValueError("Too many notification subscriptions.")
        self.public_key()
        self.subscriptions[subscription_id] = record
        self._save()
        return subscription_id

    def unsubscribe(self, subscription_id: str) -> None:
        if self.subscriptions.pop(subscription_id, None) is not None:
            self._save()
        self._presence = {key: value for key, value in self._presence.items() if key[0] != subscription_id}

    def presence(self, subscription_id: str, client_id: str, revision: int, is_focused: bool) -> None:
        now = time.monotonic()
        self._presence = {key: value for key, value in self._presence.items() if value[1] > now}
        key = (subscription_id, client_id)
        previous = self._presence.get(key)
        if subscription_id in self.subscriptions and (previous is None or revision > previous[0]):
            self._presence[key] = (revision, now + FOCUS_LEASE_SEC, is_focused)

    def is_focused(self, subscription_id: str) -> bool:
        now = time.monotonic()
        return any(key[0] == subscription_id and value[1] > now and value[2]
                   for key, value in self._presence.items())

    async def complete(self, session_id: str, run_id: str, *, text: str, has_error: bool) -> None:
        body = re.sub(r"</?citation\b[^>]*>", "", text, flags=re.IGNORECASE).strip()
        if has_error:
            body = "Your response could not finish. Tap to open the conversation."
        elif not body:
            body = "Your response is ready. Tap to open the conversation."

        async def send(subscription_id: str, record: dict) -> None:
            async with self._send_slots:
                if self.is_focused(subscription_id) or subscription_id not in self.subscriptions:
                    return
                origin = record["origin"]
                notification = {
                    "title": "Aside",
                    "body": body,
                    "navigate": f"{origin}/c/{session_id}",
                    "tag": f"aside:{run_id}",
                    "icon": f"{origin}/icons/icon-192.png",
                    "silent": False,
                }
                def payload() -> str:
                    return json.dumps({"web_push": 8030, "notification": notification},
                                      ensure_ascii=False, separators=(",", ":"))

                data = payload()
                if len(data.encode("utf-8")) > MAX_PUSH_PAYLOAD_BYTES:
                    low, high = 0, len(body)
                    while low < high:
                        middle = (low + high + 1) // 2
                        notification["body"] = body[:middle] + "…"
                        if len(payload().encode("utf-8")) <= MAX_PUSH_PAYLOAD_BYTES:
                            low = middle
                        else:
                            high = middle - 1
                    notification["body"] = body[:low] + "…"
                    data = payload()
                try:
                    await asyncio.to_thread(
                        webpush, subscription_info=record["subscription"], data=data,
                        vapid_private_key=str(self.key_path),
                        vapid_claims={"sub": origin if origin.startswith("https:") else "https://aside.dev"},
                        ttl=PUSH_TTL_SEC, timeout=PUSH_TIMEOUT_SEC, headers={"Urgency": "high"},
                    )
                except WebPushException as error:
                    status = error.response.status_code if error.response is not None else None
                    if status in (404, 410) and self.subscriptions.get(subscription_id) == record:
                        self.unsubscribe(subscription_id)
                    log.warning("Notification delivery failed (status=%s).", status)
                except Exception:
                    log.error("Notification delivery failed.")
        await asyncio.gather(*(send(subscription_id, record) for subscription_id, record in list(self.subscriptions.items())))
