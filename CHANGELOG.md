# Changelog

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
