# Changelog

## 1.5.0 — 2026-07-29

### Hunt from resume (automated pipeline)

- **Hunt from resume**: multi-query plan from profile skills, domains, keywords + resume title lines
- Server `/api/discover` accepts `queries[]` and fans out across public boards in parallel
- Score floor (default 35) + query hit reporting; advanced panel for sources/limit/min score
- After PDF ingest, optional one-click run of the hunt
- Honest scope: public remote boards (Remotive, Remote OK, Arbeitnow, Jobicy, Himalayas) + paste links — not LinkedIn/Indeed scrapers

---

## 1.4.1 — 2026-07-29

### Settings API guide + eye-comfort palette

- Settings: step-by-step xAI/Grok API key setup (console.x.ai), SuperGrok vs API note, fill defaults + clearer test errors
- Soft warm dark/light themes (no pure black/white, lower blue glare, desaturated accents) for long hunt sessions

---

## 1.4.0 — 2026-07-29

### Resume PDF upload + Grok population

- **Upload PDF / DOCX / TXT** on Resumes (drag-drop + file picker); local extract via pdf.js / mammoth
- **Grok assist** (Settings API key): structures clean Master resume text, copies Working, fills Profile (name, skills, keywords, domains, notes)
- Offline **heuristic parse** if no key; optional server `/api/extract-resume` fallback (pypdf)
- After ingest: jobs **rescored** against new Working resume
- Dashboard **Upload resume** shortcut; Profile links to upload flow

---

## 1.3.0 — 2026-07-29

### Maximum job discovery

- **Discover** panel: multi-board search (Remotive, Remote OK, Arbeitnow, Jobicy, optional Himalayas) with keyword box (pre-filled from Profile skills)
- All board traffic via local server `POST /api/discover` (parallel fetch, dedupe, error reporting per source)
- **Paste links** upgraded: batch `POST /api/job-fetch-batch`; Greenhouse / Lever / Ashby resolved via official public APIs when URL matches; HTML extract fallback
- Job cards show **source** tag; empty states / dashboard point at Discover + Paste links
- Health exposes `discover` + `jobFetch` flags

---

## 1.2.0 — 2026-07-29

### Job discovery — paste links

- **Paste links** on Job board + Dashboard: dump collected job URLs; Bootstraps fetches each page locally, extracts title/company/description, scores vs Working resume, dedupes by URL
- Accepts one URL per line, `Title | url`, `Title · Company · url`, markdown `[Title](url)`, or mixed notes
- Local server `scripts/bootstraps_server.py` adds `POST /api/job-fetch` (CORS-safe); `./start.sh` uses it
- Bulk import: pure URL pastes auto-route to Paste links; empty state copy updated
- `findJobByUrl` for dedupe across re-pastes

---

## 1.1.0 — 2026-07-29

### Install as app (PWA)

- Progressive Web App support: `manifest.webmanifest`, service worker (`sw.js`), 192/512 icons + Apple touch icon
- **Install app** in the sidebar (when Chromium offers a prompt) and **Settings → Install Bootstraps** with platform howtos
- README: install-as-app is the recommended path; local Python server remains for local development / first open
- Data still local-first (IndexedDB); export unchanged

### Notes for builders

- Open via `http://127.0.0.1:8790` (`./start.sh`) — not `file://`
- Host on HTTPS later for one-click install from a public URL
- Service worker is network-first for same-origin assets
