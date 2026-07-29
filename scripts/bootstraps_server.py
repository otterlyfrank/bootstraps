#!/usr/bin/env python3
"""
Bootstraps local server — static UI + robust job discovery.

  python3 scripts/bootstraps_server.py --port 8792

Endpoints:
  GET  /health
  POST /api/job-fetch     { "url": "https://..." }   — single page / ATS resolve
  POST /api/job-fetch-batch { "urls": ["…"] }        — parallel-ish sequential fetch
  POST /api/discover      { "sources": ["remotive",…], "search": "", "limit": 40 }
  GET  /api/sources                                 — catalog of discovery sources
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
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = (
    "BootstrapsDiscover/1.2 (+local personal job hunt; https://github.com/otterlyfrank/bootstraps)"
)
TIMEOUT = 16
MAX_BYTES = 2_500_000

# ── HTTP helpers ────────────────────────────────────────────


def fetch_bytes(url: str, timeout: int = TIMEOUT, accept: str | None = None) -> tuple[bytes, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": accept
        or "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type") or "text/html"
        data = resp.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            data = data[:MAX_BYTES]
        return data, ctype


def fetch_json(url: str, timeout: int = TIMEOUT) -> Any:
    data, _ = fetch_bytes(url, timeout=timeout, accept="application/json, text/plain, */*")
    return json.loads(data.decode("utf-8", errors="replace"))


def strip_html(html: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?is)<noscript[^>]*>.*?</noscript>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = re.sub(r"(?i)</(div|h[1-6]|li|tr|section)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def meta_content(html: str, *props: str) -> str:
    for prop in props:
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


def company_from_host_path(url: str) -> str:
    try:
        u = urllib.parse.urlparse(url)
        host = (u.hostname or "").lower().removeprefix("www.")
        path = u.path.strip("/").split("/")
    except Exception:
        return ""
    if "lever.co" in host and path:
        return path[0].replace("-", " ").title()
    if "greenhouse.io" in host and path:
        return path[0].replace("-", " ").title()
    if "ashbyhq.com" in host and path:
        return path[0].replace("-", " ").title()
    if "workable.com" in host and path and path[0] not in ("jobs", "view", "j"):
        return path[0].replace("-", " ").title()
    base = host.split(".")[0]
    if base in ("www", "jobs", "careers", "boards", "apply", "job"):
        bits = host.split(".")
        base = bits[-2] if len(bits) >= 2 else base
    if base in ("com", "io", "co", "org", "net"):
        return ""
    return base.replace("-", " ").title()


def guess_source(url: str) -> str:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    rules = [
        ("remotive", "remotive"),
        ("remoteok", "remoteok"),
        ("arbeitnow", "arbeitnow"),
        ("jobicy", "jobicy"),
        ("lever.co", "lever"),
        ("greenhouse", "greenhouse"),
        ("ashbyhq", "ashby"),
        ("workable", "workable"),
        ("linkedin", "linkedin"),
        ("weworkremotely", "wwr"),
        ("indeed", "indeed"),
        ("wellfound", "wellfound"),
        ("angel.co", "wellfound"),
        ("otta.com", "otta"),
        ("himalayas", "himalayas"),
        ("//www.google.com/about/careers", "google-careers"),
    ]
    for needle, src in rules:
        if needle in host or needle in url.lower():
            return src
    return "link"


# ── ATS resolvers (structured JSON) ─────────────────────────


def resolve_lever(url: str) -> dict[str, Any] | None:
    # https://jobs.lever.co/{company}/{id}
    m = re.search(r"jobs\.lever\.co/([^/]+)/([a-f0-9-]+)", url, re.I)
    if not m:
        return None
    company, jid = m.group(1), m.group(2)
    api = f"https://api.lever.co/v0/postings/{company}/{jid}?mode=json"
    try:
        j = fetch_json(api)
    except Exception:
        return None
    desc = j.get("descriptionPlain") or strip_html(j.get("description") or "")
    lists = j.get("lists") or []
    extra = []
    for block in lists:
        t = block.get("text") or ""
        c = strip_html(block.get("content") or "")
        if t or c:
            extra.append(f"{t}\n{c}".strip())
    if extra:
        desc = (desc + "\n\n" + "\n\n".join(extra)).strip()
    cats = j.get("categories") or {}
    return {
        "ok": True,
        "url": j.get("hostedUrl") or url,
        "title": j.get("text") or "Untitled",
        "company": company.replace("-", " ").title(),
        "description": desc[:14000],
        "source": "lever",
        "externalId": f"lever:{company}:{jid}",
        "salaryText": "",
        "tags": [x for x in [cats.get("commitment"), cats.get("location"), cats.get("team")] if x],
        "category": cats.get("team") or "",
        "fetchNote": "lever API",
    }


def resolve_greenhouse(url: str) -> dict[str, Any] | None:
    # boards.greenhouse.io/{token}/jobs/{id}
    m = re.search(r"greenhouse\.io/([^/]+)/jobs/(\d+)", url, re.I)
    if not m:
        # job-boards.greenhouse.io/{token}/jobs/{id}
        m = re.search(r"job-boards\.greenhouse\.io/([^/]+)/jobs/(\d+)", url, re.I)
    if not m:
        return None
    token, jid = m.group(1), m.group(2)
    api = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{jid}?questions=false"
    try:
        j = fetch_json(api)
    except Exception:
        return None
    desc = strip_html(j.get("content") or "")
    loc = ""
    if isinstance(j.get("location"), dict):
        loc = j["location"].get("name") or ""
    return {
        "ok": True,
        "url": j.get("absolute_url") or url,
        "title": j.get("title") or "Untitled",
        "company": token.replace("-", " ").title(),
        "description": desc[:14000],
        "source": "greenhouse",
        "externalId": f"greenhouse:{token}:{jid}",
        "salaryText": "",
        "tags": [loc] if loc else [],
        "category": "",
        "fetchNote": "greenhouse API",
    }


def resolve_ashby(url: str) -> dict[str, Any] | None:
    # jobs.ashbyhq.com/{org}/{jobPostingId}
    m = re.search(r"ashbyhq\.com/([^/]+)/([a-f0-9-]+)", url, re.I)
    if not m:
        return None
    org, jid = m.group(1), m.group(2)
    # Public posting API
    api = f"https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true"
    try:
        board = fetch_json(api)
    except Exception:
        return None
    jobs = board.get("jobs") or []
    hit = None
    for j in jobs:
        if str(j.get("id")) == jid or j.get("jobUrl", "").endswith(jid):
            hit = j
            break
        if jid in str(j.get("jobUrl") or ""):
            hit = j
            break
    if not hit:
        # try single-job page scrape fallback
        return None
    desc = strip_html(hit.get("descriptionHtml") or hit.get("descriptionPlain") or "")
    return {
        "ok": True,
        "url": hit.get("jobUrl") or url,
        "title": hit.get("title") or "Untitled",
        "company": org.replace("-", " ").title(),
        "description": desc[:14000],
        "source": "ashby",
        "externalId": f"ashby:{org}:{jid}",
        "salaryText": "",
        "tags": [hit.get("location")] if hit.get("location") else [],
        "category": hit.get("department") or "",
        "fetchNote": "ashby board API",
    }


def extract_from_html(html: str, url: str) -> dict[str, Any]:
    title = meta_content(html, "og:title", "twitter:title")
    if not title:
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
        if m:
            title = html_lib.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
    if title:
        title = re.split(r"\s+[|\-–—]\s+", title)[0].strip() or title

    company = meta_content(html, "og:site_name", "application-name") or company_from_host_path(url)
    if company and title:
        title2 = re.sub(rf"\s+at\s+{re.escape(company)}\s*$", "", title, flags=re.I).strip()
        if title2:
            title = title2

    description = meta_content(html, "og:description", "description", "twitter:description")
    body = strip_html(html)
    main_m = re.search(r"(?is)<(main|article)[^>]*>(.*?)</\1>", html)
    if main_m:
        body_main = strip_html(main_m.group(2))
        if len(body_main) > 200:
            body = body_main
    if len(body) > 12000:
        body = body[:12000] + "…"
    if description and body:
        description = (description + "\n\n" + body).strip() if len(description) < 280 else (
            body if len(body) > len(description) else description
        )
    elif body:
        description = body

    if not title:
        path = urllib.parse.urlparse(url).path.strip("/").split("/")
        slug = path[-1] if path else "Job"
        title = slug.replace("-", " ").replace("_", " ").title() or "Untitled role"

    return {
        "ok": True,
        "url": url,
        "title": title[:240],
        "company": (company or "")[:160],
        "description": (description or "")[:14000],
        "source": guess_source(url),
        "externalId": url.rstrip("/"),
        "salaryText": "",
        "tags": [],
        "category": "",
        "fetchNote": "html extract",
    }


def job_from_url(url: str) -> dict[str, Any]:
    url = (url or "").strip()
    if not url:
        return {"ok": False, "error": "url required"}
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url

    # Prefer structured ATS APIs
    for resolver in (resolve_lever, resolve_greenhouse, resolve_ashby):
        try:
            hit = resolver(url)
            if hit and hit.get("ok"):
                return hit
        except Exception:
            pass

    try:
        data, ctype = fetch_bytes(url)
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}", "url": url}
    except Exception as e:
        return {"ok": False, "error": str(e) or e.__class__.__name__, "url": url}

    # JSON posting pages
    if "json" in ctype.lower() or data[:1] in (b"{", b"["):
        try:
            j = json.loads(data.decode("utf-8", errors="replace"))
            if isinstance(j, dict) and (j.get("title") or j.get("text")):
                return {
                    "ok": True,
                    "url": j.get("url") or j.get("absolute_url") or url,
                    "title": j.get("title") or j.get("text") or "Untitled",
                    "company": j.get("company") or j.get("company_name") or company_from_host_path(url),
                    "description": strip_html(
                        j.get("description") or j.get("descriptionPlain") or j.get("content") or ""
                    )[:14000],
                    "source": guess_source(url),
                    "externalId": str(j.get("id") or url.rstrip("/")),
                    "fetchNote": "json body",
                }
        except Exception:
            pass

    html = data.decode("utf-8", errors="replace")
    try:
        return extract_from_html(html, url)
    except Exception as e:
        return {"ok": False, "error": f"parse failed: {e}", "url": url}


# ── Board sources ───────────────────────────────────────────


def _norm(
    *,
    title: str,
    company: str,
    url: str,
    description: str,
    source: str,
    external_id: str,
    salary: str = "",
    tags: list | None = None,
    category: str = "",
    remote: bool = True,
) -> dict[str, Any]:
    return {
        "title": (title or "Untitled")[:240],
        "company": (company or "")[:160],
        "url": url or "",
        "description": (description or "")[:14000],
        "source": source,
        "externalId": str(external_id or url or ""),
        "salaryText": salary or "",
        "tags": tags or [],
        "category": category or "",
        "remote": remote,
    }


def source_remotive(search: str = "", limit: int = 40) -> list[dict]:
    params = urllib.parse.urlencode({k: v for k, v in {"search": search, "limit": str(limit)}.items() if v})
    url = f"https://remotive.com/api/remote-jobs?{params}" if params else "https://remotive.com/api/remote-jobs?limit=40"
    data = fetch_json(url)
    out = []
    for j in (data.get("jobs") or [])[:limit]:
        out.append(
            _norm(
                title=j.get("title") or "",
                company=j.get("company_name") or "",
                url=j.get("url") or "",
                description=strip_html(j.get("description") or ""),
                source="remotive",
                external_id=f"remotive:{j.get('id')}",
                salary=j.get("salary") or "",
                tags=j.get("tags") or [],
                category=j.get("category") or "",
            )
        )
    return out


def source_remoteok(search: str = "", limit: int = 40) -> list[dict]:
    # Full feed; filter client-side by search
    data = fetch_json("https://remoteok.com/api")
    out = []
    q = (search or "").lower()
    for j in data:
        if not isinstance(j, dict) or not j.get("id") or j.get("id") == "legal":
            continue
        title = j.get("position") or j.get("title") or ""
        company = j.get("company") or ""
        tags = j.get("tags") or []
        blob = f"{title} {company} {' '.join(tags)} {j.get('description') or ''}".lower()
        if q and q not in blob:
            continue
        desc = strip_html(j.get("description") or "")
        out.append(
            _norm(
                title=title,
                company=company,
                url=j.get("url") or j.get("apply_url") or f"https://remoteok.com/remote-jobs/{j.get('id')}",
                description=desc,
                source="remoteok",
                external_id=f"remoteok:{j.get('id')}",
                salary=j.get("salary") or "",
                tags=tags if isinstance(tags, list) else [],
                category=(tags[0] if tags else "") if isinstance(tags, list) else "",
            )
        )
        if len(out) >= limit:
            break
    return out


def source_arbeitnow(search: str = "", limit: int = 40) -> list[dict]:
    # https://www.arbeitnow.com/api/job-board-api
    pages = max(1, min(3, (limit + 99) // 100))
    out: list[dict] = []
    q = (search or "").lower()
    for page in range(1, pages + 1):
        data = fetch_json(f"https://www.arbeitnow.com/api/job-board-api?page={page}")
        for j in data.get("data") or []:
            title = j.get("title") or ""
            company = j.get("company_name") or ""
            tags = j.get("tags") or []
            blob = f"{title} {company} {' '.join(tags)} {j.get('description') or ''}".lower()
            if q and q not in blob:
                continue
            out.append(
                _norm(
                    title=title,
                    company=company,
                    url=j.get("url") or "",
                    description=strip_html(j.get("description") or ""),
                    source="arbeitnow",
                    external_id=f"arbeitnow:{j.get('slug') or j.get('url')}",
                    tags=tags if isinstance(tags, list) else [],
                    category=(tags[0] if isinstance(tags, list) and tags else ""),
                    remote=bool(j.get("remote")),
                )
            )
            if len(out) >= limit:
                return out
    return out


def source_jobicy(search: str = "", limit: int = 40) -> list[dict]:
    # https://jobicy.com/api/v2/remote-jobs
    params = {"count": min(limit, 50)}
    if search:
        params["tag"] = search.split()[0]
    url = "https://jobicy.com/api/v2/remote-jobs?" + urllib.parse.urlencode(params)
    data = fetch_json(url)
    out = []
    q = (search or "").lower()
    for j in data.get("jobs") or []:
        title = j.get("jobTitle") or ""
        company = j.get("companyName") or ""
        blob = f"{title} {company} {j.get('jobDescription') or ''} {j.get('jobIndustry') or ''}".lower()
        if q and q not in blob and not search:
            pass
        elif q and q not in blob:
            continue
        out.append(
            _norm(
                title=title,
                company=company,
                url=j.get("url") or j.get("jobGeo") or "",
                description=strip_html(j.get("jobDescription") or ""),
                source="jobicy",
                external_id=f"jobicy:{j.get('id')}",
                salary=j.get("annualSalaryMin")
                and f"{j.get('annualSalaryMin')}-{j.get('annualSalaryMax') or ''} {j.get('salaryCurrency') or ''}"
                or "",
                tags=[j.get("jobIndustry"), j.get("jobType")] if j.get("jobIndustry") else [],
                category=j.get("jobIndustry") or "",
            )
        )
        if len(out) >= limit:
            break
    return out


def source_himalayas(search: str = "", limit: int = 40) -> list[dict]:
    # Public-ish JSON feed
    url = "https://himalayas.app/jobs/api?limit=" + str(min(limit, 50))
    if search:
        url += "&q=" + urllib.parse.quote(search)
    try:
        data = fetch_json(url)
    except Exception:
        # alternate path used by some scrapers
        data = fetch_json("https://himalayas.app/jobs/api")
    jobs = data if isinstance(data, list) else data.get("jobs") or data.get("data") or []
    out = []
    q = (search or "").lower()
    for j in jobs:
        if not isinstance(j, dict):
            continue
        title = j.get("title") or j.get("name") or ""
        company = (
            (j.get("companyName") or j.get("company") or {}).get("name")
            if isinstance(j.get("company"), dict)
            else (j.get("companyName") or j.get("company") or "")
        )
        if isinstance(company, dict):
            company = company.get("name") or ""
        desc = strip_html(j.get("description") or j.get("excerpt") or "")
        link = j.get("applicationLink") or j.get("url") or j.get("permalink") or ""
        blob = f"{title} {company} {desc}".lower()
        if q and q not in blob:
            continue
        out.append(
            _norm(
                title=title,
                company=str(company),
                url=link,
                description=desc,
                source="himalayas",
                external_id=f"himalayas:{j.get('id') or link}",
                tags=j.get("categories") or j.get("tags") or [],
            )
        )
        if len(out) >= limit:
            break
    return out


SOURCE_CATALOG = [
    {
        "id": "remotive",
        "name": "Remotive",
        "blurb": "Curated remote roles (public API)",
        "default": True,
    },
    {
        "id": "remoteok",
        "name": "Remote OK",
        "blurb": "Large remote feed (public JSON)",
        "default": True,
    },
    {
        "id": "arbeitnow",
        "name": "Arbeitnow",
        "blurb": "EU-friendly + remote board API",
        "default": True,
    },
    {
        "id": "jobicy",
        "name": "Jobicy",
        "blurb": "Remote jobs API",
        "default": True,
    },
    {
        "id": "himalayas",
        "name": "Himalayas",
        "blurb": "Remote-first board (best-effort API)",
        "default": False,
    },
]

SOURCE_FN = {
    "remotive": source_remotive,
    "remoteok": source_remoteok,
    "arbeitnow": source_arbeitnow,
    "jobicy": source_jobicy,
    "himalayas": source_himalayas,
}


def extract_resume_pdf_bytes(data: bytes) -> dict[str, Any]:
    """Best-effort PDF text via pypdf if installed."""
    try:
        from pypdf import PdfReader  # type: ignore
        import io

        reader = PdfReader(io.BytesIO(data))
        parts = []
        for page in reader.pages:
            parts.append(page.extract_text() or "")
        text = "\n\n".join(parts).strip()
        return {"ok": True, "text": text, "engine": "pypdf", "pages": len(reader.pages)}
    except ImportError:
        return {
            "ok": False,
            "error": "pypdf not installed (optional). Client-side pdf.js is primary.",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def run_discover(sources: list[str], search: str = "", limit: int = 40) -> dict[str, Any]:
    if not sources:
        sources = [s["id"] for s in SOURCE_CATALOG if s.get("default")]
    per = max(8, limit // max(1, len(sources)) + 5)
    jobs: list[dict] = []
    errors: dict[str, str] = {}
    counts: dict[str, int] = {}

    def run_one(sid: str) -> tuple[str, list[dict] | None, str | None]:
        fn = SOURCE_FN.get(sid)
        if not fn:
            return sid, None, "unknown source"
        try:
            return sid, fn(search=search, limit=per), None
        except Exception as e:
            return sid, None, str(e) or e.__class__.__name__

    with ThreadPoolExecutor(max_workers=min(6, len(sources) or 1)) as pool:
        futs = [pool.submit(run_one, s) for s in sources]
        for fut in as_completed(futs):
            sid, batch, err = fut.result()
            if err:
                errors[sid] = err
                counts[sid] = 0
            else:
                counts[sid] = len(batch or [])
                jobs.extend(batch or [])

    # dedupe by url / externalId
    seen: set[str] = set()
    deduped = []
    for j in jobs:
        key = (j.get("externalId") or j.get("url") or "").lower().rstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        # optional search re-filter across sources
        if search:
            blob = f"{j.get('title')} {j.get('company')} {j.get('description')}".lower()
            if search.lower() not in blob:
                continue
        deduped.append(j)

    return {
        "ok": True,
        "jobs": deduped[: limit * 2],
        "counts": counts,
        "errors": errors,
        "search": search,
        "sources": sources,
    }


# ── HTTP handler ────────────────────────────────────────────


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict | list) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "service": "bootstraps",
                    "jobFetch": True,
                    "discover": True,
                    "sources": [s["id"] for s in SOURCE_CATALOG],
                },
            )
            return
        if path == "/api/sources":
            self._json(200, {"ok": True, "sources": SOURCE_CATALOG})
            return
        if path == "/api/job-fetch":
            qs = urllib.parse.parse_qs(parsed.query or "")
            url = (qs.get("url") or [""])[0]
            self._json(200, job_from_url(url))
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/job-fetch":
                data = self._read_json()
                self._json(200, job_from_url(data.get("url") or ""))
                return
            if path == "/api/job-fetch-batch":
                data = self._read_json()
                urls = data.get("urls") or []
                if not isinstance(urls, list):
                    self._json(400, {"ok": False, "error": "urls must be array"})
                    return
                urls = [str(u).strip() for u in urls if str(u).strip()][:40]
                results = []
                # sequential is friendlier to remote sites; still parallel light
                with ThreadPoolExecutor(max_workers=4) as pool:
                    futs = {pool.submit(job_from_url, u): u for u in urls}
                    for fut in as_completed(futs):
                        results.append(fut.result())
                # preserve input order
                by_url = {r.get("url"): r for r in results if r.get("url")}
                ordered = [by_url.get(u) or job_from_url(u) for u in urls]
                # fix order using original list matching
                ordered = []
                for u in urls:
                    hit = next((r for r in results if (r.get("url") or "").rstrip("/") == u.rstrip("/")), None)
                    ordered.append(hit or {"ok": False, "url": u, "error": "missing"})
                self._json(200, {"ok": True, "results": ordered})
                return
            if path == "/api/discover":
                data = self._read_json()
                sources = data.get("sources") or []
                search = (data.get("search") or "").strip()
                limit = int(data.get("limit") or 40)
                limit = max(5, min(limit, 80))
                self._json(200, run_discover(sources, search=search, limit=limit))
                return
            if path == "/api/extract-resume":
                # multipart/form-data file field "file"
                ctype = self.headers.get("Content-Type") or ""
                if "multipart/form-data" not in ctype:
                    self._json(400, {"ok": False, "error": "expected multipart form with file"})
                    return
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                # crude boundary parse
                m = re.search(r"boundary=(.+)", ctype)
                if not m:
                    self._json(400, {"ok": False, "error": "no boundary"})
                    return
                boundary = m.group(1).strip().encode()
                parts = body.split(b"--" + boundary)
                file_bytes = b""
                filename = ""
                for part in parts:
                    if b"Content-Disposition" not in part:
                        continue
                    if b'name="file"' not in part and b"name=file" not in part:
                        continue
                    fm = re.search(br'filename="([^"]+)"', part)
                    if fm:
                        filename = fm.group(1).decode("utf-8", errors="replace")
                    idx = part.find(b"\r\n\r\n")
                    if idx < 0:
                        continue
                    file_bytes = part[idx + 4 :].rstrip(b"\r\n-")
                    break
                if not file_bytes:
                    self._json(400, {"ok": False, "error": "file field missing"})
                    return
                if filename.lower().endswith(".pdf") or file_bytes[:4] == b"%PDF":
                    self._json(200, extract_resume_pdf_bytes(file_bytes))
                    return
                # plain text
                try:
                    text = file_bytes.decode("utf-8", errors="replace")
                    self._json(200, {"ok": True, "text": text, "engine": "utf-8"})
                except Exception as e:
                    self._json(400, {"ok": False, "error": str(e)})
                return
            self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            self._json(
                400,
                {"ok": False, "error": str(e), "trace": traceback.format_exc()[-500:]},
            )


def main() -> None:
    ap = argparse.ArgumentParser(description="Bootstraps local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8792)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Bootstraps → http://{args.host}:{args.port}", flush=True)
    print("  discover: POST /api/discover  |  fetch: POST /api/job-fetch", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
