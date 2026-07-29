#!/usr/bin/env python3
"""
Bootstraps local server — static files + job-link fetch (CORS-safe).

  python3 scripts/bootstraps_server.py --port 8792

POST /api/job-fetch  JSON: { "url": "https://..." }
GET  /api/job-fetch?url=...
GET  /health
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = (
    "BootstrapsJobFetch/1.0 (+local personal job hunt; https://github.com/otterlyfrank/bootstraps)"
)
TIMEOUT = 14
MAX_BYTES = 2_000_000


def fetch_bytes(url: str, timeout: int = TIMEOUT) -> tuple[bytes, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type") or "text/html"
        data = resp.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            data = data[:MAX_BYTES]
        return data, ctype


def meta_content(html: str, *props: str) -> str:
    for prop in props:
        # property="og:title" content="..."
        m = re.search(
            rf'<meta[^>]+(?:property|name)=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)["\']',
            html,
            re.I,
        )
        if m:
            return html_lib.unescape(m.group(1)).strip()
        m = re.search(
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{re.escape(prop)}["\']',
            html,
            re.I,
        )
        if m:
            return html_lib.unescape(m.group(1)).strip()
    return ""


def strip_tags(html: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?is)<noscript[^>]*>.*?</noscript>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = re.sub(r"(?i)</(div|h[1-6]|li|tr)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def company_from_url(url: str) -> str:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""
    host = host.lower().removeprefix("www.")
    # ATS hosts — company often in path
    # jobs.lever.co/acme/...
    m = re.match(r"jobs\.lever\.co/([^/]+)", host + urllib.parse.urlparse(url).path)
    if "lever.co" in host:
        parts = urllib.parse.urlparse(url).path.strip("/").split("/")
        if parts and parts[0]:
            return parts[0].replace("-", " ").title()
    if "greenhouse.io" in host:
        parts = urllib.parse.urlparse(url).path.strip("/").split("/")
        if parts and parts[0] and parts[0] != "embed":
            return parts[0].replace("-", " ").title()
    if "ashbyhq.com" in host:
        parts = urllib.parse.urlparse(url).path.strip("/").split("/")
        if parts and parts[0]:
            return parts[0].replace("-", " ").title()
    if "workable.com" in host:
        parts = urllib.parse.urlparse(url).path.strip("/").split("/")
        if parts and parts[0] not in ("jobs", "view"):
            return parts[0].replace("-", " ").title()
    # generic: strip TLD
    base = host.split(".")[0]
    if base in ("www", "jobs", "careers", "boards", "apply"):
        bits = host.split(".")
        base = bits[-2] if len(bits) >= 2 else base
    if base in ("com", "io", "co", "org", "net"):
        return ""
    return base.replace("-", " ").title()


def guess_source(url: str) -> str:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if "remotive" in host:
        return "remotive-link"
    if "lever.co" in host:
        return "lever"
    if "greenhouse" in host:
        return "greenhouse"
    if "ashbyhq" in host:
        return "ashby"
    if "workable" in host:
        return "workable"
    if "linkedin" in host:
        return "linkedin"
    if "weworkremotely" in host or "wwr" in host:
        return "wwr"
    if "indeed" in host:
        return "indeed"
    if "wellfound" in host or "angel.co" in host:
        return "wellfound"
    return "link"


def extract_job(html: str, url: str) -> dict[str, Any]:
    title = meta_content(html, "og:title", "twitter:title")
    if not title:
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
        if m:
            title = html_lib.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
    # Clean common suffixes
    if title:
        title = re.split(r"\s+[|\-–—]\s+", title)[0].strip() or title

    company = meta_content(html, "og:site_name", "application-name") or company_from_url(url)
    if company and title and company.lower() in title.lower():
        # "Role at Company" patterns
        title2 = re.sub(rf"\s+at\s+{re.escape(company)}\s*$", "", title, flags=re.I).strip()
        if title2:
            title = title2

    description = meta_content(html, "og:description", "description", "twitter:description")
    body = strip_tags(html)
    # Prefer a main/article slice if present
    main_m = re.search(r"(?is)<(main|article)[^>]*>(.*?)</\1>", html)
    if main_m:
        body_main = strip_tags(main_m.group(2))
        if len(body_main) > 200:
            body = body_main

    if len(body) > 12000:
        body = body[:12000] + "…"

    if description and body:
        # merge: meta first then body if meta is short
        if len(description) < 280:
            description = (description + "\n\n" + body).strip()
        else:
            description = body if len(body) > len(description) else description
    elif body:
        description = body
    description = (description or "").strip()

    if not title:
        # last resort: path slug
        path = urllib.parse.urlparse(url).path.strip("/").split("/")
        slug = path[-1] if path else "Job"
        title = slug.replace("-", " ").replace("_", " ").title() or "Untitled role"

    return {
        "ok": True,
        "url": url,
        "title": title[:240],
        "company": (company or "")[:160],
        "description": description[:14000],
        "source": guess_source(url),
        "externalId": url.rstrip("/"),
        "fetchNote": "fetched via local Bootstraps server",
    }


def job_from_url(url: str) -> dict[str, Any]:
    url = (url or "").strip()
    if not url:
        return {"ok": False, "error": "url required"}
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        data, ctype = fetch_bytes(url)
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}", "url": url}
    except Exception as e:
        return {"ok": False, "error": str(e) or e.__class__.__name__, "url": url}

    if "html" not in ctype.lower() and not data[:200].lstrip().startswith(b"<"):
        # still try decode
        pass
    try:
        html = data.decode("utf-8", errors="replace")
    except Exception:
        html = data.decode("latin-1", errors="replace")

    try:
        return extract_job(html, url)
    except Exception as e:
        return {
            "ok": False,
            "error": f"parse failed: {e}",
            "url": url,
            "title": company_from_url(url) or "Untitled",
            "company": company_from_url(url),
            "description": "",
            "source": guess_source(url),
            "externalId": url.rstrip("/"),
        }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self._json(200, {"ok": True, "service": "bootstraps", "jobFetch": True})
            return
        if path == "/api/job-fetch":
            qs = urllib.parse.parse_qs(parsed.query or "")
            url = (qs.get("url") or [""])[0]
            self._json(200, job_from_url(url))
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/job-fetch":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            url = data.get("url") or ""
            self._json(200, job_from_url(url))
        except Exception as e:
            self._json(400, {"ok": False, "error": str(e), "trace": traceback.format_exc()[-400:]})


def main() -> None:
    ap = argparse.ArgumentParser(description="Bootstraps local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8792)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Bootstraps → http://{args.host}:{args.port}", flush=True)
    print("  job fetch: POST /api/job-fetch {\"url\":\"…\"}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
