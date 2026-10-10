"""웹폰트 프록시 + 로컬 캐시.

왜 프록시하나:
  · 윈도우에는 쓸 만한 한글 세리프가 없다. Georgia 에 한글 글리프가 없어서
    한글만 시스템 세리프(바탕체)로 떨어진다 — 이게 "윈도우에서 세리프가 별로"의 정체다.
    해결책은 웹폰트뿐인데,
  · 브라우저가 직접 fonts.googleapis.com 을 때리면 서드파티로 요청이 새어나간다.
    브리지가 대신 받아서 캐시하면 브라우저는 같은 오리진만 보고, 한 번 받은 뒤엔 오프라인에서도 뜬다.

구글 CSS 는 unicode-range 로 쪼갠 @font-face 를 수백 개 담고 있다(Noto Serif KR = 248개).
브라우저는 화면에 실제로 쓰인 글자 범위의 조각(25~42KB)만 내려받는다. 그래서 전부 미러링할 필요가 없다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from urllib.parse import urljoin

import httpx

import config

log = logging.getLogger("aside-remote.fonts")

CACHE = config.CACHE_DIR / "fonts"
CACHE.mkdir(parents=True, exist_ok=True)

# 구글이 woff2(가장 작은 포맷)를 주도록 최신 크롬 UA 를 쓴다. UA 를 안 주면 ttf 를 준다.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 화이트리스트 — 임의 URL 프록시가 되지 않게 정확히 아는 것만 허용한다.
FAMILIES: dict[str, dict] = {
    "wanted-sans": {
        "label": "Wanted Sans",
        "kind": "sans",
        "css": ("https://cdn.jsdelivr.net/gh/wanteddev/wanted-sans@v1.0.3/packages/wanted-sans/"
                "fonts/webfonts/variable/split/WantedSansVariable.min.css"),
        "stack": '"Wanted Sans Variable", "Wanted Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    "noto-serif-kr": {
        "label": "Noto Serif KR",
        "kind": "serif",
        "css": "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700&display=swap",
        "stack": '"Noto Serif KR", ui-serif, Georgia, serif',
    },
    "gowun-batang": {
        "label": "Gowun Batang",
        "kind": "serif",
        "css": "https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap",
        "stack": '"Gowun Batang", ui-serif, Georgia, serif',
    },
    "nanum-myeongjo": {
        "label": "나눔명조",
        "kind": "serif",
        "css": "https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800&display=swap",
        "stack": '"Nanum Myeongjo", ui-serif, Georgia, serif',
    },
    "pretendard": {
        "label": "Pretendard",
        "kind": "sans",
        "css": ("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/"
                "variable/pretendardvariable-dynamic-subset.css"),
        "stack": '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, sans-serif',
    },
    "noto-sans-kr": {
        "label": "Noto Sans KR",
        "kind": "sans",
        "css": "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap",
        "stack": '"Noto Sans KR", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    # 웹폰트 없이 시스템 폰트만 — 요청 0회
    "system-serif": {
        "label": "시스템 세리프",
        "kind": "serif",
        "css": None,
        "stack": 'ui-serif, Georgia, "Apple SD Gothic Neo", "Noto Serif KR", serif',
    },
    "system-sans": {
        "label": "시스템 산세리프",
        "kind": "sans",
        "css": None,
        "stack": ('-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", '
                  '"Malgun Gothic", "Segoe UI", Roboto, sans-serif'),
    },
}

_ALLOWED_HOSTS = ("fonts.gstatic.com", "cdn.jsdelivr.net")
_URL_RE = re.compile(r"url\((https://[^)]+)\)")


def catalog() -> list[dict]:
    return [{"id": k, "label": v["label"], "kind": v["kind"],
             "webfont": bool(v["css"]), "stack": v["stack"]}
            for k, v in FAMILIES.items()]


def stack(font_id: str) -> str | None:
    f = FAMILIES.get(font_id)
    return f["stack"] if f else None


def _key(url: str, ext: str) -> Path:
    return CACHE / (hashlib.sha256(url.encode()).hexdigest()[:32] + ext)


# 짧은 id -> 원본 URL. 재기동 후에도 /api/font/file/<id> 가 살아있어야 하므로 디스크에 남긴다.
_INDEX_FILE = CACHE / "index.json"
try:
    _index: dict[str, str] = json.loads(_INDEX_FILE.read_text())
except Exception:
    _index = {}


async def css(client: httpx.AsyncClient, font_id: str) -> str:
    """폰트 CSS 를 받아 폰트 파일 URL 을 브리지 경유 경로로 바꿔서 돌려준다."""
    f = FAMILIES.get(font_id)
    if not f or not f["css"]:
        return "/* system font — no webfont */"
    cached = _key(f["css"], ".css")
    if cached.exists():
        text = cached.read_text()
    else:
        r = await client.get(f["css"], headers={"User-Agent": UA}, timeout=20,
                             follow_redirects=True)
        r.raise_for_status()
        text = r.text
        cached.write_text(text)

    base = f["css"]

    def sub(m: re.Match) -> str:
        url = m.group(1)
        return f"url(/api/font/file/{_register(url)})"

    # jsDelivr 쪽은 `../../../` 같은 상대경로를 쓴다. 문자열로 이어붙이면 깨지므로 urljoin 으로 푼다.
    text = re.sub(r"""url\((?!https?:|data:)['"]?([^)'"]+)['"]?\)""",
                  lambda m: f"url({urljoin(base, m.group(1))})", text)
    return _URL_RE.sub(sub, text)


def _register(url: str) -> str:
    fid = hashlib.sha256(url.encode()).hexdigest()[:24]
    if _index.get(fid) != url:
        _index[fid] = url
        try:
            _INDEX_FILE.write_text(json.dumps(_index))
        except OSError:
            log.warning("font index write failed")
    return fid


async def file(client: httpx.AsyncClient, fid: str) -> tuple[bytes, str] | None:
    url = _index.get(fid)
    if not url:
        return None
    host = url.split("/")[2]
    if not any(host.endswith(h) for h in _ALLOWED_HOSTS):
        return None
    ext = ".woff2" if url.endswith(".woff2") else ".bin"
    cached = _key(url, ext)
    if cached.exists():
        return cached.read_bytes(), "font/woff2"
    r = await client.get(url, headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    r.raise_for_status()
    cached.write_bytes(r.content)
    log.info("font cached %s (%dB)", url.rsplit("/", 1)[-1][:24], len(r.content))
    return r.content, r.headers.get("content-type", "font/woff2")
