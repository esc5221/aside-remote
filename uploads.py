"""첨부 이미지 저장/조회.

핵심 제약(실측):
  · `aside exec` 에는 첨부 옵션이 없다. 이미지를 프롬프트에 실어 보낼 방법이 없다.
  · repl 의 fs 는 "Project and session roots" 밖을 거부한다.
    ~/aside-remote/cache 에 두면 에이전트가 못 읽는다.
  · 반면 Aside 유저 루트(~/.aside/u/0) 안은 읽힌다. 세션 디렉토리가 생기기 전에도 쓸 수 있어
    새 대화의 경쟁 상태도 없다.
→ 그래서 업로드는 ~/.aside/u/0/uploads/ 에 두고, 프롬프트에 그 경로를 적어
  에이전트가 fs.readFile + display() 로 직접 보게 한다.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

import config

log = logging.getLogger("aside-remote.uploads")

# 매직 바이트로 판별한다. 확장자나 클라이언트가 보낸 content-type 을 믿지 않는다.
_MAGIC = [
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"GIF8", "image/gif", "gif"),
    (b"RIFF", "image/webp", "webp"),
]


def sniff(raw: bytes) -> tuple[str, str] | None:
    for magic, mime, ext in _MAGIC:
        if raw.startswith(magic):
            if ext == "webp" and raw[8:12] != b"WEBP":
                continue
            return mime, ext
    return None


def save(raw: bytes, name: str | None = None) -> dict:
    kind = sniff(raw)
    if not kind:
        raise ValueError("Choose a JPEG, PNG, GIF, or WebP image")
    mime, ext = kind
    digest = hashlib.sha256(raw).hexdigest()[:16]
    fid = f"{digest}.{ext}"
    path = config.UPLOAD_DIR / fid
    if not path.exists():
        path.write_bytes(raw)
    return {
        "id": fid,
        "path": str(path),        # 에이전트가 읽을 절대경로
        "name": (name or fid)[:120],
        "mime": mime,
        "bytes": len(raw),
        "url": f"/api/upload/{fid}",
    }


def path_of(fid: str) -> Path | None:
    if "/" in fid or ".." in fid:
        return None
    p = config.UPLOAD_DIR / fid
    return p if p.is_file() else None


# 프롬프트 앞에 붙는 첨부 블록. 사람이 읽어도 자연스럽고, UI 가 파싱하기도 쉽게.
MARK = "[첨부 이미지]"


def prompt_prefix(atts: list[dict]) -> str:
    if not atts:
        return ""
    lines = [MARK]
    for a in atts:
        lines.append(f"- {a['name']} → {a['path']}")
    lines.append("위 이미지를 repl 에서 fs.readFile 로 읽고 display() 로 먼저 확인한 뒤 답해줘.")
    lines.append("")
    return "\n".join(lines)


def sweep(max_age_days: int = 30) -> int:
    """오래된 업로드 정리. 세션 로그에 경로가 남아 있으므로 너무 짧게 잡지 않는다."""
    cutoff = time.time() - max_age_days * 86400
    n = 0
    for f in config.UPLOAD_DIR.glob("*"):
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink(); n += 1
        except OSError:
            pass
    return n
