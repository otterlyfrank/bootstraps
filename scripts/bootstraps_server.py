#!/usr/bin/env python3
"""
Bootstraps local server — static UI + robust job discovery.

  python3 scripts/bootstraps_server.py --port 8792

Endpoints:
  GET  /health
  POST /api/job-fetch     { "url": "https://..." }   — single page / ATS resolve
  POST /api/job-fetch-batch { "urls": ["…"] }        — parallel-ish sequential fetch
  POST /api/discover      { "sources": ["remotive",…], "search": "", "limit": 40 }
  GET  /api/sources                                 — catalog (public + research + custom)
  GET  /api/custom-sources                          — uploaded scrape pack + example
  POST /api/custom-sources                          — replace custom pack { sources: [...] }
  POST /api/custom-sources/clear                    — delete local custom pack
"""

from __future__ import annotations

import argparse
import html as html_lib
import ipaddress
import json
import re
import socket
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]


def app_version_info() -> dict:
    version = ""
    pkg = ROOT / "package.json"
    if pkg.is_file():
        try:
            version = str(json.loads(pkg.read_text(encoding="utf-8")).get("version") or "")
        except Exception:
            version = ""
    git = ""
    try:
        git = (
            subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=ROOT,
                timeout=1.5,
                stderr=subprocess.DEVNULL,
            )
            .decode("ascii", "replace")
            .strip()
        )
    except Exception:
        git = ""
    return {"ok": True, "name": "bootstraps", "version": version, "git": git}


DATA_DIR = ROOT / "data"
CUSTOM_SOURCES_PATH = DATA_DIR / "custom_sources.json"
CUSTOM_SOURCES_EXAMPLE = DATA_DIR / "custom_sources.example.json"
# Personal research boards (gitignored) — e.g. HU-only scrapes for the maintainer
LOCAL_SOURCES_PATH = DATA_DIR / "local_sources.json"
USER_AGENT = (
    "BootstrapsDiscover/1.3 (+local personal job hunt; https://github.com/otterlyfrank/bootstraps)"
)
TIMEOUT = 16
MAX_BYTES = 2_500_000
MAX_JSON_BODY = 2_000_000
MAX_CUSTOM_SOURCES = 40
MAX_SITEMAP_PROBE = 80  # detail pages fetched per sitemap discover

# Hostnames that must never be fetched via the open job-fetch proxy
_BLOCKED_HOSTS = {
    "localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
}


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        return True
    if ip.is_multicast or ip.is_unspecified:
        return True
    # Cloud metadata / link-local specials
    if str(ip) in ("169.254.169.254", "0.0.0.0", "::", "::1"):
        return True
    return False


def validate_fetch_url(url: str) -> tuple[bool, str]:
    """
    SSRF guard for user-supplied URLs (job-fetch).
    Allows only http(s) to public internet hosts.
    """
    url = (url or "").strip()
    if not url:
        return False, "url required"
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False, "invalid url"
    if parsed.scheme not in ("http", "https"):
        return False, "only http/https allowed"
    host = (parsed.hostname or "").lower().strip(".")
    if not host:
        return False, "missing host"
    if host in _BLOCKED_HOSTS or host.endswith(".localhost") or host.endswith(".local"):
        return False, "host blocked"
    # Literal IP in URL
    try:
        ip = ipaddress.ip_address(host)
        if _is_blocked_ip(ip):
            return False, "private or reserved address blocked"
    except ValueError:
        # Hostname — resolve and check all addresses
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror:
            return False, "could not resolve host"
        if not infos:
            return False, "could not resolve host"
        for info in infos:
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if _is_blocked_ip(ip):
                return False, "host resolves to private/reserved address"
    return True, ""


def _origin_ok(origin: str) -> bool:
    """Only loopback browser origins may call the API cross-origin."""
    if not origin:
        return True  # curl / same-origin-less
    if origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:"):
        return True
    if origin.startswith("https://127.0.0.1:") or origin.startswith("https://localhost:"):
        return True
    return False


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


def fetch_json_post(
    url: str,
    payload: dict,
    timeout: int = TIMEOUT,
    *,
    origin: str | None = None,
    referer: str | None = None,
) -> Any:
    body = json.dumps(payload).encode("utf-8")
    # Getro returns 406 if Accept includes */* — keep Accept: application/json only
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if origin:
        headers["Origin"] = origin
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            data = data[:MAX_BYTES]
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

    ok, reason = validate_fetch_url(url)
    if not ok:
        return {"ok": False, "error": reason or "url blocked", "url": url}

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


# ── Generic adapters (public: custom upload; local research boards use same code) ──


def _local_name(tag: str) -> str:
    if not tag:
        return ""
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _rss_child_text(item: ET.Element, *names: str) -> str:
    """Return text for the first matching child, preferring earlier *names*."""
    by_local: dict[str, str] = {}
    for child in item:
        key = _local_name(child.tag).lower()
        if key not in by_local:
            by_local[key] = (child.text or "").strip()
    for n in names:
        val = by_local.get(n.lower())
        if val:
            return val
    return ""


def source_from_rss(feed_url: str, source_id: str, search: str = "", limit: int = 40) -> list[dict]:
    """Parse a public job RSS/Atom feed (WP Job Manager style works well)."""
    ok, reason = validate_fetch_url(feed_url)
    if not ok:
        raise ValueError(f"feed url blocked: {reason}")
    data, _ = fetch_bytes(feed_url, accept="application/rss+xml, application/xml, text/xml, */*")
    root = ET.fromstring(data)
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out: list[dict] = []
    q = (search or "").lower()
    for it in items:
        title = _rss_child_text(it, "title")
        link = _rss_child_text(it, "link", "guid")
        if not link:
            # Atom link href
            for child in it:
                if _local_name(child.tag).lower() == "link":
                    link = (child.get("href") or child.text or "").strip()
                    if link:
                        break
        company = _rss_child_text(it, "company", "company_name", "author", "creator")
        location = _rss_child_text(it, "location")
        job_type = _rss_child_text(it, "job_type", "jobtype")
        category = _rss_child_text(it, "job_category", "category")
        desc = strip_html(
            _rss_child_text(it, "description", "summary", "content")
            or _rss_child_text(it, "content:encoded")
        )
        # content:encoded may use namespaced tag
        if not desc:
            for child in it:
                if _local_name(child.tag).lower() in ("encoded", "content", "summary"):
                    desc = strip_html(child.text or "")
                    if desc:
                        break
        blob = f"{title} {company} {desc} {location} {job_type} {category}".lower()
        if q and q not in blob and not _matches_query(
            {"title": title, "company": company, "description": desc}, search
        ):
            continue
        tags = [t for t in [job_type, category, location] if t]
        out.append(
            _norm(
                title=title,
                company=company or company_from_host_path(link),
                url=link,
                description=desc,
                source=source_id,
                external_id=f"{source_id}:{link or title}",
                tags=tags,
                category=category or job_type or "",
                remote="remote" in (location or "").lower() or "remote" in blob,
            )
        )
        if len(out) >= limit:
            break
    return out


def source_from_getro(
    collection_id: str, source_id: str, search: str = "", limit: int = 40
) -> list[dict]:
    """Getro ecosystem board search (e.g. Solana jobs.solana.com → collection 858)."""
    cid = str(collection_id or "").strip()
    if not re.fullmatch(r"[0-9]+", cid):
        raise ValueError("getro collectionId must be a numeric id")
    out: list[dict] = []
    page = 0
    q = (search or "").strip()
    while len(out) < limit and page < 6:
        data = fetch_json_post(
            f"https://api.getro.com/api/v2/collections/{cid}/search/jobs",
            {
                "hitsPerPage": min(40, max(10, limit)),
                "page": page,
                "query": q,
            },
        )
        results = data.get("results") if isinstance(data, dict) else None
        jobs = (results or {}).get("jobs") if isinstance(results, dict) else None
        if jobs is None and isinstance(data, dict):
            jobs = data.get("jobs") or []
        jobs = jobs or []
        if not jobs:
            break
        for j in jobs:
            if not isinstance(j, dict):
                continue
            title = j.get("title") or ""
            org = j.get("organization") or {}
            company = org.get("name") if isinstance(org, dict) else ""
            url = j.get("url") or ""
            if not url and j.get("slug"):
                url = f"https://jobs.solana.com/jobs/{j.get('slug')}"
            skills = j.get("skills") or []
            locs = j.get("locations") or j.get("searchable_locations") or []
            work_mode = (j.get("work_mode") or "").lower()
            remote = work_mode in ("remote", "hybrid", "flexible") or any(
                "remote" in str(x).lower() for x in locs
            )
            desc_bits = [
                title,
                company,
                work_mode,
                " ".join(str(x) for x in locs),
                " ".join(str(x) for x in skills),
                j.get("seniority") or "",
            ]
            desc = " · ".join(b for b in desc_bits if b)
            blob = f"{title} {company} {desc}".lower()
            if q and q.lower() not in blob and not _matches_query(
                {"title": title, "company": company, "description": desc}, search
            ):
                continue
            salary = ""
            lo = j.get("compensation_amount_min_cents")
            hi = j.get("compensation_amount_max_cents")
            cur = j.get("compensation_currency") or ""
            if lo or hi:
                def _amt(cents: Any) -> str:
                    try:
                        return f"{int(cents) / 100:.0f}"
                    except Exception:
                        return ""

                salary = f"{_amt(lo)}-{_amt(hi)} {cur}".strip()
            out.append(
                _norm(
                    title=title,
                    company=str(company or ""),
                    url=url,
                    description=desc,
                    source=source_id,
                    external_id=f"{source_id}:{j.get('id') or url or title}",
                    salary=salary,
                    tags=[str(s) for s in skills[:12]] if isinstance(skills, list) else [],
                    category=j.get("seniority") or work_mode or "",
                    remote=remote,
                )
            )
            if len(out) >= limit:
                break
        page += 1
        if len(jobs) < 5:
            break
    return out[:limit]


def _parse_jobposting_ld(html: str) -> dict[str, Any] | None:
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    ):
        raw = m.group(1).strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        for node in stack:
            if not isinstance(node, dict):
                continue
            t = node.get("@type") or node.get("type")
            types = t if isinstance(t, list) else [t]
            types_l = [str(x).lower() for x in types if x]
            if "jobposting" not in types_l:
                # @graph
                graph = node.get("@graph")
                if isinstance(graph, list):
                    for g in graph:
                        if isinstance(g, dict):
                            gt = g.get("@type")
                            gtypes = gt if isinstance(gt, list) else [gt]
                            if any(str(x).lower() == "jobposting" for x in gtypes if x):
                                return g
                continue
            return node
    return None


def _jobposting_to_norm(node: dict, page_url: str, source_id: str) -> dict[str, Any]:
    title = str(node.get("title") or "").strip()
    org = node.get("hiringOrganization") or {}
    if isinstance(org, dict):
        company = org.get("name") or ""
    else:
        company = str(org or "")
    desc = strip_html(node.get("description") or "")
    url = node.get("url") or page_url
    remote = False
    loc = node.get("jobLocationType") or ""
    if "TELECOMMUTE" in str(loc).upper() or "remote" in str(loc).lower():
        remote = True
    if not remote:
        # applicantLocationRequirements / description hints
        blob = f"{desc} {json.dumps(node.get('jobLocation') or '')}".lower()
        remote = "remote" in blob or "work from anywhere" in blob or "worldwide" in blob
    salary = ""
    base = node.get("baseSalary") or {}
    if isinstance(base, dict):
        val = base.get("value") or {}
        if isinstance(val, dict):
            mn = val.get("minValue") or val.get("value")
            mx = val.get("maxValue")
            cur = base.get("currency") or val.get("currency") or ""
            if mn or mx:
                salary = f"{mn or ''}-{mx or ''} {cur}".strip()
        elif val:
            salary = str(val)
    tags: list[str] = []
    for key in ("occupationalCategory", "employmentType", "industry"):
        v = node.get(key)
        if isinstance(v, list):
            tags.extend(str(x) for x in v if x)
        elif v:
            tags.append(str(v))
    return _norm(
        title=str(title),
        company=str(company),
        url=str(url),
        description=desc,
        source=source_id,
        external_id=f"{source_id}:{url}",
        salary=salary,
        tags=tags[:12],
        category=tags[0] if tags else "",
        remote=remote,
    )


def source_from_sitemap_jsonld(
    sitemap_url: str,
    source_id: str,
    search: str = "",
    limit: int = 40,
    job_path_prefix: str = "/jobs/",
) -> list[dict]:
    """
    Sitemap of job detail URLs → fetch pages → schema.org JobPosting JSON-LD.
    Used by Real Work From Anywhere-style boards (no public list API).
    """
    ok, reason = validate_fetch_url(sitemap_url)
    if not ok:
        raise ValueError(f"sitemap url blocked: {reason}")
    data, _ = fetch_bytes(sitemap_url, accept="application/xml, text/xml, */*")
    text = data.decode("utf-8", errors="replace")
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text, re.I)
    prefix = (job_path_prefix or "/jobs/").rstrip("/") + "/"
    job_urls: list[str] = []
    q = (search or "").lower().strip()
    for loc in locs:
        loc = html_lib.unescape(loc.strip())
        try:
            path = urllib.parse.urlparse(loc).path or ""
        except Exception:
            continue
        if prefix not in path and not path.startswith(prefix.rstrip("/")):
            # also accept exact /jobs/slug
            if "/jobs/" not in path:
                continue
        # skip category landing pages without trailing slug digits/hyphen patterns if needed
        slug = path.rstrip("/").split("/")[-1]
        if not slug or slug in ("jobs", "job"):
            continue
        if q:
            # cheap prefilter on slug
            slug_blob = slug.replace("-", " ").lower()
            tokens = [t for t in re.split(r"\s+", q) if len(t) >= 3]
            if tokens and not any(t in slug_blob for t in tokens) and q not in slug_blob:
                continue
        job_urls.append(loc)
        if len(job_urls) >= max(limit * 3, MAX_SITEMAP_PROBE):
            break

    out: list[dict] = []

    def fetch_one(u: str) -> dict | None:
        try:
            ok_u, reason_u = validate_fetch_url(u)
            if not ok_u:
                return None
            raw, _ = fetch_bytes(u)
            html = raw.decode("utf-8", errors="replace")
            node = _parse_jobposting_ld(html)
            if node:
                job = _jobposting_to_norm(node, u, source_id)
            else:
                # fallback: og tags
                title = meta_content(html, "og:title", "twitter:title") or ""
                desc = meta_content(html, "og:description", "description") or ""
                company = ""
                if " at " in title:
                    parts = title.rsplit(" at ", 1)
                    title, company = parts[0].strip(), parts[1].strip()
                job = _norm(
                    title=title or slug_from_url(u),
                    company=company,
                    url=u,
                    description=strip_html(desc),
                    source=source_id,
                    external_id=f"{source_id}:{u}",
                    remote=True,
                )
            if search and not _matches_query(job, search):
                return None
            return job
        except Exception:
            return None

    def slug_from_url(u: str) -> str:
        try:
            return urllib.parse.urlparse(u).path.rstrip("/").split("/")[-1].replace("-", " ")
        except Exception:
            return "Untitled"

    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(fetch_one, u) for u in job_urls[:MAX_SITEMAP_PROBE]]
        for fut in as_completed(futs):
            job = fut.result()
            if job and job.get("title"):
                out.append(job)
            if len(out) >= limit:
                break
    return out[:limit]


def source_workew(search: str = "", limit: int = 40) -> list[dict]:
    """Research board: Workew remote jobs via public RSS."""
    return source_from_rss("https://workew.com/job_feed/", "workew", search=search, limit=limit)


def source_rwfa(search: str = "", limit: int = 40) -> list[dict]:
    """Research board: Real Work From Anywhere via sitemap + JobPosting JSON-LD."""
    return source_from_sitemap_jsonld(
        "https://www.realworkfromanywhere.com/sitemap.xml",
        "rwfa",
        search=search,
        limit=limit,
        job_path_prefix="/jobs/",
    )


def source_solana(search: str = "", limit: int = 40) -> list[dict]:
    """Research board: Solana Network Opportunities (Getro collection 858)."""
    return source_from_getro("858", "solana", search=search, limit=limit)


def _talentbrew_resolve_location(
    base: str, location: str
) -> tuple[str, str]:
    """Return (locationId, display) for a TalentBrew site via /search-jobs/locations."""
    loc = (location or "").strip()
    if not loc:
        raise ValueError("talentbrew location required")
    url = base.rstrip("/") + "/search-jobs/locations?" + urllib.parse.urlencode({"term": loc})
    ok, reason = validate_fetch_url(url)
    if not ok:
        raise ValueError(f"talentbrew locations blocked: {reason}")
    data, _ = fetch_bytes(url, accept="application/json, text/plain, */*")
    items = json.loads(data.decode("utf-8", errors="replace"))
    if not isinstance(items, list) or not items:
        raise ValueError(f"no TalentBrew location match for {loc!r}")
    # Prefer exact-ish city/country matches first
    loc_l = loc.lower()
    best = items[0]
    for it in items:
        if not isinstance(it, dict):
            continue
        val = str(it.get("value") or "").lower()
        if val == loc_l or loc_l in val:
            best = it
            break
    lid = str(best.get("id") or "").strip()
    display = str(best.get("value") or loc).strip()
    if not lid:
        raise ValueError(f"TalentBrew location missing id for {loc!r}")
    return lid, display


def _parse_talentbrew_results_html(results_html: str, base: str) -> list[dict[str, str]]:
    """Parse TMPN search-results HTML fragment into stub dicts."""
    stubs: list[dict[str, str]] = []
    # Prefer full cards
    cards = re.findall(
        r'<a class="[^"]*search-results-a[^"]*" href="(/job/[^"]+)" data-job-id="(\d+)">(.*?)</a>',
        results_html,
        re.I | re.S,
    )
    if not cards:
        cards = re.findall(
            r'href="(/job/[^"]+)"[^>]*data-job-id="(\d+)"[^>]*>(.*?)</a>',
            results_html,
            re.I | re.S,
        )
    for href, jid, body in cards:
        title_m = re.search(r'class="[^"]*job-title[^"]*"[^>]*>(.*?)</', body, re.I | re.S)
        title = strip_html(title_m.group(1)) if title_m else ""
        if not title:
            # slug fallback
            parts = href.strip("/").split("/")
            title = parts[2].replace("-", " ").title() if len(parts) >= 3 else "Untitled"
        locs = [
            strip_html(x)
            for x in re.findall(r'class="[^"]*job-info[^"]*"[^>]*>(.*?)</span>', body, re.I | re.S)
        ]
        cats = [
            strip_html(x)
            for x in re.findall(
                r'class="[^"]*job-category[^"]*"[^>]*>.*?<span class="[^"]*job-info[^"]*"[^>]*>(.*?)</span>',
                body,
                re.I | re.S,
            )
        ]
        path_city = ""
        bits = href.strip("/").split("/")
        if len(bits) >= 2 and bits[0] == "job":
            path_city = bits[1]
        abs_url = urllib.parse.urljoin(base.rstrip("/") + "/", href.lstrip("/"))
        stubs.append(
            {
                "id": jid,
                "title": title,
                "url": abs_url,
                "location": "; ".join(locs[:3]),
                "category": cats[0] if cats else "",
                "pathCity": path_city,
            }
        )
    return stubs


def source_from_talentbrew(
    base_url: str,
    source_id: str,
    *,
    location: str = "",
    location_id: str = "",
    location_display: str = "",
    company: str = "",
    search: str = "",
    limit: int = 40,
    enrich: bool = True,
) -> list[dict]:
    """
    TMPN / TalentBrew career sites (e.g. careers.blackrock.com).

    Uses /search-jobs/results with a location facet. Note: bare paths like
    /job/budapest/ are not listing pages (404) — location search is required.
    """
    base = (base_url or "").strip().rstrip("/")
    ok, reason = validate_fetch_url(base + "/")
    if not ok:
        raise ValueError(f"talentbrew base url blocked: {reason}")

    lid = (location_id or "").strip()
    display = (location_display or location or "").strip()
    if not lid and location:
        lid, display = _talentbrew_resolve_location(base, location)
    if not lid:
        raise ValueError("talentbrew requires location or locationId")

    out: list[dict] = []
    page = 1
    company_name = (company or company_from_host_path(base) or "Employer").strip()
    q = (search or "").strip()

    while len(out) < limit and page <= 8:
        params = {
            "ActiveFacetID": "0",
            "CurrentPage": str(page),
            "RecordsPerPage": str(min(50, max(limit, 15))),
            "Distance": "50",
            "RadiusUnitType": "0",
            "Keywords": q,
            "Location": display,
            "ShowRadius": "False",
            "IsPagination": "False" if page == 1 else "True",
            "CustomFacetName": "",
            "FacetTerm": "",
            "FacetType": "0",
            "SearchResultsModuleName": "Search Results",
            "SearchFiltersModuleName": "Search Filters",
            "SortCriteria": "0",
            "SortDirection": "0",
            "SearchType": "5",
            "PostalCode": "",
            "ResultsType": "0",
            "FacetFilters[0].ID": lid,
            "FacetFilters[0].FacetType": "2",
            "FacetFilters[0].Count": "10",
            "FacetFilters[0].Display": display,
            "FacetFilters[0].IsApplied": "true",
            "FacetFilters[0].FieldName": "",
        }
        api = base + "/search-jobs/results?" + urllib.parse.urlencode(params)
        data, _ = fetch_bytes(
            api,
            accept="application/json, text/javascript, */*; q=0.01",
        )
        try:
            payload = json.loads(data.decode("utf-8", errors="replace"))
        except Exception as e:
            raise ValueError(f"talentbrew results not JSON: {e}") from e
        results_html = payload.get("results") or ""
        if not results_html:
            break
        stubs = _parse_talentbrew_results_html(results_html, base)
        if not stubs:
            break

        def enrich_one(stub: dict) -> dict:
            title = stub.get("title") or ""
            url = stub.get("url") or ""
            loc = stub.get("location") or ""
            cat = stub.get("category") or ""
            desc = f"Location: {loc}\nCategory: {cat}".strip()
            remote = "remote" in f"{title} {loc} {cat}".lower()
            if enrich and url:
                try:
                    ok_u, _ = validate_fetch_url(url)
                    if ok_u:
                        raw, _ = fetch_bytes(url)
                        html = raw.decode("utf-8", errors="replace")
                        node = _parse_jobposting_ld(html)
                        if node:
                            job = _jobposting_to_norm(node, url, source_id)
                            # force company + location tags for filtering
                            if not job.get("company"):
                                job["company"] = company_name
                            tags = list(job.get("tags") or [])
                            if loc and loc not in tags:
                                tags = [loc] + tags
                            job["tags"] = tags[:12]
                            job["source"] = source_id
                            job["externalId"] = f"{source_id}:{stub.get('id') or url}"
                            if cat and not job.get("category"):
                                job["category"] = cat
                            return job
                except Exception:
                    pass
            return _norm(
                title=title,
                company=company_name,
                url=url,
                description=desc,
                source=source_id,
                external_id=f"{source_id}:{stub.get('id') or url}",
                tags=[t for t in [loc, cat] if t],
                category=cat,
                remote=remote,
            )

        with ThreadPoolExecutor(max_workers=5) as pool:
            futs = [pool.submit(enrich_one, s) for s in stubs]
            for fut in as_completed(futs):
                job = fut.result()
                if search and not _matches_query(job, search):
                    continue
                out.append(job)
                if len(out) >= limit:
                    break
        if len(stubs) < 5:
            break
        page += 1

    # Dedup by externalId/url
    seen: set[str] = set()
    deduped: list[dict] = []
    for j in out:
        key = (j.get("externalId") or j.get("url") or "").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(j)
    return deduped[:limit]


def source_blackrock(search: str = "", limit: int = 40) -> list[dict]:
    """
    Research board: BlackRock careers in Budapest.

    Note: https://careers.blackrock.com/job/budapest/ is not a listing page (404).
    Jobs are pulled via TalentBrew location search (Budapest, HU).
    """
    return source_from_talentbrew(
        "https://careers.blackrock.com",
        "blackrock",
        location="Budapest, HU",
        location_id="3054638",
        location_display="Budapest, HU",
        company="BlackRock",
        search=search,
        limit=limit,
        enrich=True,
    )


# ── Hungarian research boards ────────────────────────────────


# Profession.hu public RSS (partner category packs + curated category pages).
# Keyword query params do not filter the main ?rss feed reliably — we fan out
# category feeds and apply _matches_query client-side.
PROFESSION_RSS_FEEDS = (
    "https://www.profession.hu/partner/files/rss-it.rss",
    "https://www.profession.hu/partner/files/rss-marketing.rss",
    "https://www.profession.hu/partner/files/rss-hr.rss",
    "https://www.profession.hu/partner/files/rss-szamvitel.rss",
    "https://www.profession.hu/partner/files/rss-mernok.rss",
    "https://www.profession.hu/partner/files/rss-ertekesites.rss",
    "https://www.profession.hu/partner/files/rss-adminisztracio.rss",
    "https://www.profession.hu/partner/files/rss-jog.rss",
    "https://www.profession.hu/partner/files/rss-ugyfelszolgalat.rss",
    "https://www.profession.hu/allasok/it-programozas-fejlesztes/1,10?rss",
    "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/1,25?rss",
    "https://www.profession.hu/allasok/uzleti-tamogato-kozpontok/1,27?rss",
    "https://www.profession.hu/allasok/marketing-media-pr/1,12?rss",
    "https://www.profession.hu/allasok/penzugy-konyveles/1,17?rss",
    "https://www.profession.hu/allasok/budapest/1,0,23?rss",
    "https://www.profession.hu/allasok?rss",
)


def _profession_company_from_desc(desc: str, title: str) -> str:
    """Parse 'Hirdető cég: Foo Kft.' from Profession RSS descriptions."""
    m = re.search(r"Hirdet[oő]\s+c[eé]g\s*:\s*(.+?)(?:\n|$)", desc or "", re.I)
    if m:
        return m.group(1).strip()[:160]
    # Partner feed often embeds company after a comma/newline under the title line
    for line in (desc or "").splitlines():
        line = line.strip()
        if line.lower().startswith("hirdető cég:") or line.lower().startswith("hirdeto ceg:"):
            return line.split(":", 1)[-1].strip()[:160]
    return ""


def _profession_clean_url(url: str) -> str:
    """Strip tracking (/p/NNN, utm_*) from Profession job links."""
    u = (url or "").strip()
    if not u:
        return u
    try:
        p = urllib.parse.urlparse(u)
        # drop /p/569 partner suffix
        path = re.sub(r"/p/\d+/?$", "", p.path or "")
        q = urllib.parse.parse_qs(p.query, keep_blank_values=False)
        q = {k: v for k, v in q.items() if not k.lower().startswith("utm_")}
        return urllib.parse.urlunparse(
            (p.scheme, p.netloc, path, "", urllib.parse.urlencode({k: v[0] for k, v in q.items()}), "")
        )
    except Exception:
        return u.split("?")[0]


def source_profession(search: str = "", limit: int = 40) -> list[dict]:
    """
    Research board: Profession.hu (Hungary's largest job portal) via public RSS.

    Fans out partner category feeds + Budapest + IT/SSC pages, dedupes, filters
    by search tokens. Not a full-site crawl — capped per-feed for speed.
    """
    per_feed = max(8, min(25, limit))
    q = (search or "").strip()

    def pull(feed_url: str) -> list[dict]:
        try:
            batch = source_from_rss(feed_url, "profession", search="", limit=per_feed)
        except Exception as e:
            sys.stderr.write(f"profession feed skip {feed_url}: {e}\n")
            return []
        local: list[dict] = []
        for j in batch:
            url = _profession_clean_url(j.get("url") or "")
            title = j.get("title") or ""
            desc = j.get("description") or ""
            company = j.get("company") or ""
            # RSS adapter may set company from host ("profession") — replace with real employer
            if not company or company.lower() in ("profession", "profession.hu", "www.profession.hu"):
                company = _profession_company_from_desc(desc, title) or company
            # Location hint from URL slug (…-budapest-1234567)
            loc = ""
            m = re.search(
                r"-(budapest|debrecen|szeged|pecs|p[eé]cs|gyor|gy[oö]r|miskolc|sz[eé]kesfeh[eé]rv[aá]r|"
                r"ny[ií]regyh[aá]za|kecskem[eé]t|szombathely|veszpr[eé]m|remote|home-office)(?:-\d+)?$",
                (urllib.parse.urlparse(url).path or "").rstrip("/"),
                re.I,
            )
            if m:
                loc = m.group(1).replace("-", " ").title()
            tags = list(j.get("tags") or [])
            if loc and loc not in tags:
                tags = [loc] + tags
            tags = (tags + ["Hungary", "profession.hu"])[:12]
            remote = bool(j.get("remote")) or bool(
                re.search(r"remote|home\s*office|t[aá]vmunka|homeoffice", f"{title} {desc}", re.I)
            )
            job = _norm(
                title=title,
                company=company,
                url=url or j.get("url") or "",
                description=desc,
                source="profession",
                external_id=f"profession:{url or j.get('externalId') or title}",
                tags=tags,
                category=j.get("category") or "",
                remote=remote,
            )
            if q and not _matches_query(job, q):
                continue
            local.append(job)
        return local

    merged: list[dict] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(pull, u) for u in PROFESSION_RSS_FEEDS]
        for fut in as_completed(futs):
            try:
                merged.extend(fut.result() or [])
            except Exception as e:
                sys.stderr.write(f"profession feed err: {e}\n")

    out: list[dict] = []
    seen: set[str] = set()
    for job in merged:
        key = (job.get("externalId") or job.get("url") or "").lower().rstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(job)
        if len(out) >= limit:
            break
    return out


def _telekom_detail_text(detail: dict) -> str:
    """Flatten content1..content20 (+ type/deadline) into a JD-ish blob."""
    parts: list[str] = []
    for key in ("type", "deadline", "location", "company"):
        v = detail.get(key)
        if v:
            parts.append(f"{key}: {v}")
    areas = detail.get("areas") or []
    if areas:
        parts.append("Areas: " + ", ".join(str(a) for a in areas if a))
    for i in range(1, 21):
        v = detail.get(f"content{i}")
        if v is None or v == "" or v == []:
            continue
        if isinstance(v, list):
            block = "\n".join(strip_html(str(x)) for x in v if x)
        else:
            block = strip_html(str(v))
        if block.strip():
            parts.append(block.strip())
    return "\n\n".join(parts)[:14000]


def source_telekom(search: str = "", limit: int = 40, enrich: bool = True) -> list[dict]:
    """
    Research board: Magyar Telekom careers (telekom.hu/karrier).

    List: GET https://www.telekom.hu/karrier/api/jobs → jobList
    Detail: GET …/api/jobs/{id} (optional enrich for full JD + English signals)
    Public page: https://www.telekom.hu/karrier/jobs?jobId={id}
    """
    data = fetch_json("https://www.telekom.hu/karrier/api/jobs")
    if not isinstance(data, dict):
        raise ValueError("telekom jobs API returned non-object")
    rows = data.get("jobList") or []
    if not isinstance(rows, list):
        raise ValueError("telekom jobList missing")
    q = (search or "").strip()
    stubs: list[dict] = []
    for j in rows:
        if not isinstance(j, dict):
            continue
        jid = str(j.get("id") or "").strip()
        title = str(j.get("title") or "").strip()
        if not title:
            continue
        company = str(j.get("company") or "Magyar Telekom").strip()
        loc = str(j.get("location") or "").strip()
        labels = j.get("labels") or []
        if not isinstance(labels, list):
            labels = []
        page_url = (
            f"https://www.telekom.hu/karrier/jobs?jobId={urllib.parse.quote(jid)}"
            if jid
            else "https://www.telekom.hu/karrier/jobs"
        )
        tags = [str(x) for x in labels if x] + ([loc] if loc else []) + ["Hungary", "Telekom"]
        desc = f"Location: {loc}\nLabels: {', '.join(str(x) for x in labels if x)}".strip()
        stubs.append(
            {
                "id": jid,
                "title": title,
                "company": company,
                "url": page_url,
                "location": loc,
                "tags": tags[:12],
                "description": desc,
            }
        )

    def enrich_one(stub: dict) -> dict:
        title = stub["title"]
        company = stub["company"]
        url = stub["url"]
        tags = list(stub.get("tags") or [])
        desc = stub.get("description") or ""
        jid = stub.get("id") or ""
        remote = bool(re.search(r"remote|home\s*office|hybrid|t[aá]vmunka", f"{title} {desc}", re.I))
        apply_url = ""
        if enrich and jid:
            try:
                ok_u, _ = validate_fetch_url(
                    f"https://www.telekom.hu/karrier/api/jobs/{urllib.parse.quote(jid)}"
                )
                if ok_u:
                    detail = fetch_json(
                        f"https://www.telekom.hu/karrier/api/jobs/{urllib.parse.quote(jid)}"
                    )
                    if isinstance(detail, dict):
                        desc = _telekom_detail_text(detail) or desc
                        apply_url = str(detail.get("applyUrl") or "").strip()
                        if detail.get("type") and str(detail.get("type")) not in tags:
                            tags.append(str(detail.get("type"))[:40])
                        remote = remote or bool(
                            re.search(
                                r"remote|home\s*office|hybrid|home office|t[aá]vmunka|partial home",
                                desc,
                                re.I,
                            )
                        )
            except Exception:
                pass
        # Prefer careers page; note apply URL in description when present
        if apply_url and apply_url not in desc:
            desc = (desc + f"\n\nApply: {apply_url}").strip()
        job = _norm(
            title=title,
            company=company,
            url=url,
            description=desc,
            source="telekom",
            external_id=f"telekom:{jid or url}",
            tags=tags[:12],
            category=(tags[0] if tags else ""),
            remote=remote,
        )
        return job

    # Cap enrichment work
    work = stubs[: max(limit * 2, limit)]
    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futs = [pool.submit(enrich_one, s) for s in work]
        for fut in as_completed(futs):
            try:
                job = fut.result()
            except Exception:
                continue
            if q and not _matches_query(job, q):
                continue
            out.append(job)
            if len(out) >= limit:
                break
    return out[:limit]


def _custom_source_fn(cfg: dict) -> Callable[..., list[dict]]:
    kind = (cfg.get("kind") or "").strip().lower()
    sid = (cfg.get("id") or "custom").strip()
    url = (cfg.get("url") or "").strip()
    collection_id = str(cfg.get("collectionId") or cfg.get("collection_id") or "").strip()
    job_prefix = (cfg.get("jobPathPrefix") or cfg.get("job_path_prefix") or "/jobs/").strip()
    location = str(cfg.get("location") or "").strip()
    location_id = str(cfg.get("locationId") or cfg.get("location_id") or "").strip()
    company = str(cfg.get("company") or "").strip()

    def runner(search: str = "", limit: int = 40) -> list[dict]:
        if kind == "rss":
            if not url:
                raise ValueError(f"{sid}: rss requires url")
            return source_from_rss(url, sid, search=search, limit=limit)
        if kind in ("sitemap_jsonld", "sitemap", "jsonld"):
            if not url:
                raise ValueError(f"{sid}: sitemap_jsonld requires url")
            return source_from_sitemap_jsonld(
                url, sid, search=search, limit=limit, job_path_prefix=job_prefix or "/jobs/"
            )
        if kind == "getro":
            if not collection_id:
                raise ValueError(f"{sid}: getro requires collectionId")
            return source_from_getro(collection_id, sid, search=search, limit=limit)
        if kind in ("talentbrew", "tmpn"):
            base = url or str(cfg.get("baseUrl") or cfg.get("base_url") or "").strip()
            if not base:
                raise ValueError(f"{sid}: talentbrew requires url (site root)")
            return source_from_talentbrew(
                base,
                sid,
                location=location,
                location_id=location_id,
                location_display=str(cfg.get("locationDisplay") or location).strip(),
                company=company,
                search=search,
                limit=limit,
                enrich=bool(cfg.get("enrich", True)),
            )
        raise ValueError(
            f"{sid}: unknown kind {kind!r} (use rss | sitemap_jsonld | getro | talentbrew)"
        )

    return runner


def _validate_custom_entry(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("each custom source must be an object")
    sid = re.sub(r"[^a-z0-9_-]+", "-", str(raw.get("id") or "").strip().lower()).strip("-")
    if not sid or len(sid) < 2:
        raise ValueError("custom source id required (letters, numbers, - _)")
    if sid in BUILTIN_SOURCE_IDS:
        raise ValueError(f"id {sid!r} is reserved for a built-in board — pick another id")
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in ("rss", "sitemap_jsonld", "sitemap", "jsonld", "getro", "talentbrew", "tmpn"):
        raise ValueError(f"{sid}: kind must be rss | sitemap_jsonld | getro | talentbrew")
    kind = "talentbrew" if kind == "tmpn" else ("sitemap_jsonld" if kind in ("sitemap", "jsonld") else kind)
    url = str(raw.get("url") or raw.get("baseUrl") or raw.get("base_url") or "").strip()
    collection_id = str(raw.get("collectionId") or raw.get("collection_id") or "").strip()
    location = str(raw.get("location") or "").strip()
    location_id = str(raw.get("locationId") or raw.get("location_id") or "").strip()
    if kind == "getro":
        if not re.fullmatch(r"[0-9]+", collection_id):
            raise ValueError(f"{sid}: getro collectionId must be numeric")
    elif kind == "talentbrew":
        ok, reason = validate_fetch_url(url if url.endswith("/") else url + "/")
        if not ok:
            raise ValueError(f"{sid}: url invalid — {reason}")
        if not location and not location_id:
            raise ValueError(f"{sid}: talentbrew requires location or locationId")
    else:
        ok, reason = validate_fetch_url(url)
        if not ok:
            raise ValueError(f"{sid}: url invalid — {reason}")
    name = str(raw.get("name") or sid).strip()[:80]
    blurb = str(raw.get("blurb") or f"Custom {kind} source").strip()[:160]
    default = bool(raw.get("default")) if "default" in raw else False
    entry = {
        "id": sid,
        "name": name,
        "blurb": blurb,
        "kind": kind,
        "default": default,
        "custom": True,
        "tier": "custom",
    }
    if entry["kind"] == "getro":
        entry["collectionId"] = collection_id
    else:
        entry["url"] = url
    if entry["kind"] == "sitemap_jsonld":
        entry["jobPathPrefix"] = str(
            raw.get("jobPathPrefix") or raw.get("job_path_prefix") or "/jobs/"
        ).strip() or "/jobs/"
    if entry["kind"] == "talentbrew":
        if location:
            entry["location"] = location
        if location_id:
            entry["locationId"] = location_id
        if raw.get("locationDisplay"):
            entry["locationDisplay"] = str(raw.get("locationDisplay")).strip()
        if raw.get("company"):
            entry["company"] = str(raw.get("company")).strip()[:80]
        entry["enrich"] = bool(raw.get("enrich", True))
    return entry


def load_custom_sources() -> list[dict[str, Any]]:
    path = CUSTOM_SOURCES_PATH
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        sys.stderr.write(f"custom_sources.json read error: {e}\n")
        return []
    items = data.get("sources") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for raw in items[:MAX_CUSTOM_SOURCES]:
        try:
            out.append(_validate_custom_entry(raw))
        except Exception as e:
            sys.stderr.write(f"skip custom source: {e}\n")
    return out


def save_custom_sources(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    validated: list[dict] = []
    seen: set[str] = set()
    for raw in entries[:MAX_CUSTOM_SOURCES]:
        e = _validate_custom_entry(raw)
        if e["id"] in seen:
            raise ValueError(f"duplicate custom source id {e['id']!r}")
        seen.add(e["id"])
        validated.append(e)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "note": "User-uploaded scrape sources for Bootstraps discover. Local only — not synced.",
        "sources": validated,
    }
    CUSTOM_SOURCES_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return validated


def example_custom_sources() -> dict[str, Any]:
    if CUSTOM_SOURCES_EXAMPLE.is_file():
        try:
            return json.loads(CUSTOM_SOURCES_EXAMPLE.read_text(encoding="utf-8"))
        except Exception:
            pass
    # Fallback inline example mirrors research boards (GitHub users can upload this)
    return {
        "version": 1,
        "note": "Example custom scrape sources. Copy to data/custom_sources.json or upload via the UI.",
        "sources": [
            {
                "id": "workew-rss",
                "name": "Workew (upload example)",
                "blurb": "RSS — remote jobs",
                "kind": "rss",
                "url": "https://workew.com/job_feed/",
                "default": False,
            },
            {
                "id": "rwfa-sitemap",
                "name": "Real Work From Anywhere (upload example)",
                "blurb": "Sitemap + JobPosting JSON-LD",
                "kind": "sitemap_jsonld",
                "url": "https://www.realworkfromanywhere.com/sitemap.xml",
                "jobPathPrefix": "/jobs/",
                "default": False,
            },
            {
                "id": "solana-getro",
                "name": "Solana jobs (upload example)",
                "blurb": "Getro collection 858",
                "kind": "getro",
                "collectionId": "858",
                "default": False,
            },
            {
                "id": "blackrock-budapest",
                "name": "BlackRock Budapest (upload example)",
                "blurb": "TalentBrew location search — not /job/budapest/ (404)",
                "kind": "talentbrew",
                "url": "https://careers.blackrock.com",
                "location": "Budapest, HU",
                "locationId": "3054638",
                "company": "BlackRock",
                "default": False,
            },
        ],
    }


BUILTIN_SOURCE_CATALOG = [
    {
        "id": "remotive",
        "name": "Remotive",
        "blurb": "Curated remote roles (public API)",
        "default": True,
        "tier": "public",
    },
    {
        "id": "remoteok",
        "name": "Remote OK",
        "blurb": "Large remote feed (public JSON)",
        "default": True,
        "tier": "public",
    },
    {
        "id": "arbeitnow",
        "name": "Arbeitnow",
        "blurb": "EU-friendly + remote board API",
        "default": True,
        "tier": "public",
    },
    {
        "id": "jobicy",
        "name": "Jobicy",
        "blurb": "Remote jobs API",
        "default": True,
        "tier": "public",
    },
    {
        "id": "himalayas",
        "name": "Himalayas",
        "blurb": "Remote-first board (best-effort API)",
        "default": False,
        "tier": "public",
    },
    # Local research boards — optional (unchecked by default). Same adapters power custom upload.
    {
        "id": "workew",
        "name": "Workew",
        "blurb": "Research: remote board via public RSS",
        "default": False,
        "tier": "research",
    },
    {
        "id": "rwfa",
        "name": "Real Work From Anywhere",
        "blurb": "Research: worldwide remote via sitemap + JSON-LD",
        "default": False,
        "tier": "research",
    },
    {
        "id": "solana",
        "name": "Solana Jobs",
        "blurb": "Research: Solana ecosystem (Getro) — many crypto roles",
        "default": False,
        "tier": "research",
    },
    {
        "id": "blackrock",
        "name": "BlackRock (Budapest)",
        "blurb": "Research: BlackRock TalentBrew · Budapest location facet",
        "default": False,
        "tier": "research",
    },
]

BUILTIN_SOURCE_IDS = {s["id"] for s in BUILTIN_SOURCE_CATALOG}

BUILTIN_SOURCE_FN: dict[str, Callable[..., list[dict]]] = {
    "remotive": source_remotive,
    "remoteok": source_remoteok,
    "arbeitnow": source_arbeitnow,
    "jobicy": source_jobicy,
    "himalayas": source_himalayas,
    "workew": source_workew,
    "rwfa": source_rwfa,
    "solana": source_solana,
    "blackrock": source_blackrock,
}

# Adapters only exposed when data/local_sources.json enables them (local machine).
LOCAL_RESEARCH_ADAPTERS: dict[str, Callable[..., list[dict]]] = {
    "profession": source_profession,
    "telekom": source_telekom,
}


def load_local_research_sources() -> list[dict[str, Any]]:
    """
    Personal research boards from data/local_sources.json (gitignored).

    Shape:
      { "sources": [ { "id", "name", "blurb", "adapter": "profession"|"telekom", "default": false } ] }
    """
    path = LOCAL_SOURCES_PATH
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        sys.stderr.write(f"local_sources.json read error: {e}\n")
        return []
    items = data.get("sources") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items[:MAX_CUSTOM_SOURCES]:
        if not isinstance(raw, dict):
            continue
        adapter = str(raw.get("adapter") or raw.get("id") or "").strip().lower()
        if adapter not in LOCAL_RESEARCH_ADAPTERS:
            sys.stderr.write(f"skip local source: unknown adapter {adapter!r}\n")
            continue
        sid = re.sub(r"[^a-z0-9_-]+", "-", str(raw.get("id") or adapter).strip().lower()).strip("-")
        if not sid or sid in BUILTIN_SOURCE_IDS or sid in seen:
            sys.stderr.write(f"skip local source: bad/reserved/duplicate id {sid!r}\n")
            continue
        # Do not collide with custom upload ids
        seen.add(sid)
        out.append(
            {
                "id": sid,
                "name": str(raw.get("name") or sid).strip()[:80],
                "blurb": str(raw.get("blurb") or f"Local research: {adapter}").strip()[:160],
                "default": bool(raw.get("default")),
                "tier": "research",
                "local": True,
                "adapter": adapter,
            }
        )
    return out


def merged_source_catalog() -> list[dict[str, Any]]:
    custom = load_custom_sources()
    local = load_local_research_sources()
    # Catalog entries for UI (no functions)
    out = [dict(s) for s in BUILTIN_SOURCE_CATALOG]
    for loc in local:
        out.append(
            {
                "id": loc["id"],
                "name": loc["name"],
                "blurb": loc.get("blurb") or "",
                "default": bool(loc.get("default")),
                "tier": "research",
                "local": True,
            }
        )
    for c in custom:
        out.append(
            {
                "id": c["id"],
                "name": c["name"],
                "blurb": c.get("blurb") or "",
                "default": bool(c.get("default")),
                "tier": "custom",
                "custom": True,
                "kind": c.get("kind"),
            }
        )
    return out


def resolve_source_fn(sid: str) -> Callable[..., list[dict]] | None:
    if sid in BUILTIN_SOURCE_FN:
        return BUILTIN_SOURCE_FN[sid]
    for loc in load_local_research_sources():
        if loc["id"] == sid:
            return LOCAL_RESEARCH_ADAPTERS.get(loc.get("adapter") or sid)
    for c in load_custom_sources():
        if c["id"] == sid:
            return _custom_source_fn(c)
    return None


# Back-compat names used elsewhere in this file
SOURCE_CATALOG = BUILTIN_SOURCE_CATALOG  # updated at runtime via merged_source_catalog
SOURCE_FN = BUILTIN_SOURCE_FN


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


def _matches_query(job: dict, query: str) -> bool:
    """Loose match: all significant tokens should appear OR full phrase."""
    q = (query or "").strip().lower()
    if not q:
        return True
    blob = f"{job.get('title') or ''} {job.get('company') or ''} {job.get('description') or ''}".lower()
    if q in blob:
        return True
    tokens = [t for t in re.split(r"\s+", q) if len(t) >= 3]
    if not tokens:
        return True
    # require majority of tokens (handles multi-skill queries)
    hits = sum(1 for t in tokens if t in blob)
    return hits >= max(1, (len(tokens) + 1) // 2)


def run_discover(
    sources: list[str],
    search: str = "",
    limit: int = 40,
    queries: list[str] | None = None,
) -> dict[str, Any]:
    """
    Pull from public job boards. Supports a single search string or multiple
    queries (OR'd results) so resume-driven hunts can fan out by title/skill.
    """
    catalog = merged_source_catalog()
    if not sources:
        sources = [s["id"] for s in catalog if s.get("default")]

    qlist: list[str] = []
    if queries and isinstance(queries, list):
        qlist = [str(q).strip() for q in queries if str(q).strip()]
    if search and search.strip() and search.strip() not in qlist:
        qlist.insert(0, search.strip())
    if not qlist:
        qlist = [""]  # broad pull

    # Cap query fan-out
    qlist = qlist[:6]
    per = max(8, min(40, (limit // max(1, len(sources))) + 8))
    jobs: list[dict] = []
    errors: dict[str, str] = {}
    counts: dict[str, int] = {}
    query_hits: dict[str, int] = {q or "(broad)": 0 for q in qlist}

    tasks: list[tuple[str, str]] = []  # (source_id, query)
    for sid in sources:
        for q in qlist:
            tasks.append((sid, q))

    def run_one(sid: str, q: str) -> tuple[str, str, list[dict] | None, str | None]:
        fn = resolve_source_fn(sid)
        if not fn:
            return sid, q, None, "unknown source"
        try:
            return sid, q, fn(search=q, limit=per), None
        except Exception as e:
            return sid, q, None, str(e) or e.__class__.__name__

    with ThreadPoolExecutor(max_workers=min(8, max(2, len(tasks)))) as pool:
        futs = [pool.submit(run_one, sid, q) for sid, q in tasks]
        for fut in as_completed(futs):
            sid, q, batch, err = fut.result()
            label = q or "(broad)"
            if err:
                # only record first error per source
                errors.setdefault(sid, err)
                counts.setdefault(sid, 0)
            else:
                counts[sid] = counts.get(sid, 0) + len(batch or [])
                query_hits[label] = query_hits.get(label, 0) + len(batch or [])
                jobs.extend(batch or [])

    # dedupe by url / externalId
    seen: set[str] = set()
    deduped = []
    for j in jobs:
        key = (j.get("externalId") or j.get("url") or "").lower().rstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        # Keep if matches ANY query (OR). Empty query = keep all.
        if any(_matches_query(j, q) for q in qlist):
            deduped.append(j)

    return {
        "ok": True,
        "jobs": deduped[: max(limit * 3, limit)],
        "counts": counts,
        "errors": errors,
        "search": search,
        "queries": qlist,
        "queryHits": query_hits,
        "sources": sources,
    }


# ── HTTP handler ────────────────────────────────────────────


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or ""
        if _origin_ok(origin):
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            else:
                self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8792")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _check_origin(self) -> bool:
        return _origin_ok(self.headers.get("Origin") or "")

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
        if n > MAX_JSON_BODY:
            raise ValueError(f"request body too large (max {MAX_JSON_BODY} bytes)")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._check_origin():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._check_origin():
            self._json(403, {"ok": False, "error": "origin not allowed"})
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/api/version",):
            self._json(200, app_version_info())
            return
        if path == "/health":
            catalog = merged_source_catalog()
            ver = app_version_info()
            self._json(
                200,
                {
                    "ok": True,
                    "service": "bootstraps",
                    "jobFetch": True,
                    "discover": True,
                    "customSources": True,
                    "sources": [s["id"] for s in catalog],
                    "version": ver.get("version") or "",
                    "git": ver.get("git") or "",
                },
            )
            return
        if path == "/api/sources":
            self._json(200, {"ok": True, "sources": merged_source_catalog()})
            return
        if path == "/api/custom-sources":
            self._json(
                200,
                {
                    "ok": True,
                    "sources": load_custom_sources(),
                    "path": str(CUSTOM_SOURCES_PATH.relative_to(ROOT))
                    if CUSTOM_SOURCES_PATH.is_file()
                    else "data/custom_sources.json",
                    "example": example_custom_sources(),
                },
            )
            return
        if path == "/api/custom-sources/example":
            self._json(200, {"ok": True, **example_custom_sources()})
            return
        if path == "/api/source-health":
            # Quick probe: 1–2 jobs per source. Skip heavy sitemap_jsonld (too slow for health).
            health: dict[str, Any] = {}
            catalog = merged_source_catalog()
            custom_by_id = {c["id"]: c for c in load_custom_sources()}
            slow_ids = {"rwfa"}  # built-in sitemap research
            for c in custom_by_id.values():
                if c.get("kind") in ("sitemap_jsonld", "sitemap", "jsonld"):
                    slow_ids.add(c["id"])

            def probe(sid: str) -> tuple[str, dict]:
                if sid in slow_ids:
                    return sid, {
                        "ok": True,
                        "count": None,
                        "error": None,
                        "note": "sitemap source — probed on hunt only",
                    }
                fn = resolve_source_fn(sid)
                if not fn:
                    return sid, {"ok": False, "error": "unknown", "count": 0}
                try:
                    batch = fn(search="", limit=2)
                    return sid, {"ok": True, "count": len(batch or []), "error": None}
                except Exception as e:
                    return sid, {"ok": False, "count": 0, "error": str(e) or e.__class__.__name__}

            sids = [s["id"] for s in catalog]
            with ThreadPoolExecutor(max_workers=min(8, max(2, len(sids)))) as pool:
                futs = [pool.submit(probe, sid) for sid in sids]
                for fut in as_completed(futs):
                    sid, info = fut.result()
                    health[sid] = info
            self._json(200, {"ok": True, "health": health, "at": __import__("time").time()})
            return
        if path == "/api/job-fetch":
            qs = urllib.parse.parse_qs(parsed.query or "")
            url = (qs.get("url") or [""])[0]
            self._json(200, job_from_url(url))
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_origin():
            self._json(403, {"ok": False, "error": "origin not allowed"})
            return
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
                queries = data.get("queries")
                limit = int(data.get("limit") or 40)
                limit = max(5, min(limit, 100))
                self._json(
                    200,
                    run_discover(sources, search=search, limit=limit, queries=queries),
                )
                return
            if path in ("/api/custom-sources", "/api/custom-sources/import"):
                # Dual path: any local user / GitHub clone can upload scrape definitions
                data = self._read_json()
                items = data.get("sources") if isinstance(data, dict) else None
                if items is None and isinstance(data, list):
                    items = data
                if not isinstance(items, list):
                    self._json(
                        400,
                        {
                            "ok": False,
                            "error": "expected { \"sources\": [ { id, kind, url|collectionId, ... } ] }",
                        },
                    )
                    return
                saved = save_custom_sources(items)
                self._json(
                    200,
                    {
                        "ok": True,
                        "sources": saved,
                        "catalog": merged_source_catalog(),
                        "message": f"Saved {len(saved)} custom source(s) to data/custom_sources.json",
                    },
                )
                return
            if path == "/api/custom-sources/clear":
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                if CUSTOM_SOURCES_PATH.is_file():
                    CUSTOM_SOURCES_PATH.unlink()
                self._json(
                    200,
                    {
                        "ok": True,
                        "sources": [],
                        "catalog": merged_source_catalog(),
                        "message": "Cleared custom sources",
                    },
                )
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
            # Log full traceback server-side only — never leak to clients
            sys.stderr.write("API error: %s\n%s\n" % (e, traceback.format_exc()))
            self._json(400, {"ok": False, "error": str(e) or e.__class__.__name__})


def main() -> None:
    ap = argparse.ArgumentParser(description="Bootstraps local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8792)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Bootstraps → http://{args.host}:{args.port}", flush=True)
    print("  discover: POST /api/discover  |  fetch: POST /api/job-fetch", flush=True)
    print(
        "  custom sources: GET/POST /api/custom-sources  (upload RSS / sitemap / Getro boards)",
        flush=True,
    )
    n_custom = len(load_custom_sources())
    if n_custom:
        print(f"  loaded {n_custom} custom source(s) from data/custom_sources.json", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
