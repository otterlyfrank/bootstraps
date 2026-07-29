# Changelog

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
