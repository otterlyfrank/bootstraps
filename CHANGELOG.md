# Changelog

## 1.15.1 — 2026-08-14

### UX: one next action

- Resumes and ATS toolbars: **Upload / Download PDF** up front; the rest under **More**
- Empty job shelf has **Hunt from resume** instead of a paragraph of options
- `/` focuses search; `?` still lists keys
- Home no longer puts “Sample data” next to a live hunt

## 1.15.0 — 2026-08-14

### ATS resume formatting that actually reads as a resume

- Broader section headings (Work History, Highlights, Achievements…)
- Job headers detected by title + dates / separators — summary sentences with a year no longer become bold “jobs”
- Contact lines in the header stay centered; role lines with `|` and dates stay left as jobs
- Stuck headings, mid-line `•` bullets, and missing blanks before a new role are cleaned on Fix formatting / save / ingest
- **Preview ATS PDF** and **Download Working PDF** on the Resumes desk (you should not have to hunt for the file)
- Live word / page estimate under each editor
- Tests cover the new heading and job-header cases

## 1.14.0 — 2026-08-07

### Cover letter + polished ATS PDF

- **Resume PDF (ATS-safe polish):** Helvetica only; **centered 20pt bold name**; contact/headline centered; hairline rule under header; **12pt bold ALL-CAPS section titles** with underline rules; **11pt bold job lines**; comfortable margins & line-height; hanging bullets
- **Cover letter** (not a short note): Grok writes a real multi-paragraph body using resume skills + **otterly.global**; app wraps simple template:
  - `Dear {company},` → body → `Warm Regards,` → name → contact
- **Separate PDF page(s)** for the cover letter before the resume; also **Cover letter PDF** alone
- **Settings → Cover letter:** greeting, sign-off, signature name, contact line, portfolio URL, optional date/address (off by default)
- **Profile:** email, phone, website fields feed the signature block
- Format preservation from upload → ATS → PDF (`resume-format.js`)
- SW cache **v10**

## 1.13.1 — 2026-08-07

### Resume → ATS formatting preservation

- **PDF/DOCX extract** keeps section gaps, smarter run joins, bullet/indent cues (less “wall of text”)
- **`resume-format.js`** normalizes bullets (`- `), section blanks, headings; strips old local-prep checklist wrappers
- **Local prep** no longer glues a keyword checklist into the tailored resume (upload-ready body only)
- **Grok ATS / ingest prompts** require layout preservation (bullets, blanks, job headers, contact block)
- Post-polish after generate + **Fix formatting** on Resumes; PDF layout: name, headings, hanging bullets, job lines
- SW cache **v9**

## 1.13.0 — 2026-08-07

### ATS PDF exporter (one-click upload file)

- **Download PDF** on the ATS generator — builds a clean US Letter resume PDF (selectable Helvetica text) ready to upload on job portals
- Optional **Include cover note in PDF** checkbox
- Same PDF download in the Hunt **Prepare application** modal
- Zero new dependencies (`src/lib/pdf-resume.js`); filenames like `Resume-Acme-Data-Analyst.pdf`
- SW cache **v8** precaches the PDF module

## 1.12.0 — 2026-08-05

### English-required filter (all users) + local research hook

- **English required** board toggle for everyone (Hunt filter bar + Settings) — keeps roles that mention English / angol requirement, CEFR levels, or EN-written JDs; **EN** chip on matching cards
- **Local research sources** — optional `data/local_sources.json` (gitignored) can enable personal adapters on the desk server without shipping them as public built-ins
- Maintainer-only HU scrapers (Profession.hu multi-RSS, Magyar Telekom JSON API) stay behind that local file — not listed for GitHub clones by default

## 1.11.2 — 2026-08-05

### Logo rework — funny bootstrap mascot is back

- Restored the original **self-bootstrap pull mascot** as the primary brand mark (sidebar, hero, boot screen)
- Regenerated **icon-192 / icon-512 / apple-touch** from the mascot (reads as the joke on home screens)
- SVG mark redrawn as a simplified mascot silhouette (not the vague leather blob)
- SW cache bumped to **v4** so installs pick up new assets

## 1.11.1 — 2026-08-05

### BlackRock Budapest (TalentBrew)

- **Built-in research source** `blackrock` — BlackRock careers filtered to **Budapest, HU**
- Note: `https://careers.blackrock.com/job/budapest/` is **not** a listing page (404); we use TalentBrew `/search-jobs/results` + location facet
- New generic adapter kind **`talentbrew`** for custom upload (any TMPN/TalentBrew career site + location)
- Example custom pack updated

## 1.11.0 — 2026-08-05

### Research boards + custom scrape uploads (dual path)

- **Built-in research sources** (optional, off by default): **Workew** (RSS), **Real Work From Anywhere** (sitemap + JobPosting JSON-LD), **Solana Jobs** (Getro collection 858)
- **Generic adapters** shared by research + custom: `rss` · `sitemap_jsonld` · `getro`
- **Custom scrape upload** for any GitHub/local user:
  - `GET/POST /api/custom-sources` · `POST /api/custom-sources/clear` · `GET /api/custom-sources/example`
  - Hunt → Advanced → paste/import JSON → Save; stored in local `data/custom_sources.json` (gitignored)
  - Example pack: `data/custom_sources.example.json`
- Source chips show **research** / **custom** tags; public boards still default on

## 1.10.0 — 2026-07-29

### Finish audit stretch goals + UI modules

- **⌘K command palette** — jump to any view, hunt, upload, session, export
- **Climb timeline** on Home — 8-week sparklines (apps + interviews) + Working resume evolution ticks
- **Application pack** — printable paper preview on ATS + open print window / Save PDF
- **Session mode** (`S` or topbar) — dim chrome, focus hunt loop, prepare goal HUD
- **Per-source hunt progress** — board counts, scoring bar, error dots during discover
- **UI modules** under `src/ui/` (dom, score, cards, climb, palette, print, progress, session)
- **Fonts** — system-first stack (fast offline LCP); optional DM Sans / Newsreader progressive enhancement
- SW precache **v3** for new UI modules
- Extra unit coverage for climb buckets + pack markdown

## 1.9.0 — 2026-07-29

### Cross-functional audit P0–P1 polish

- **Mobile bottom nav** (Home · Hunt · ATS · Pipeline · More) — sidebar no longer leaves phone users stranded
- **Partial shell re-render** — chrome stays mounted; content swaps; skip link + `aria-current`
- **A11y:** focus trap + Escape on wizard/drawer, `aria-live` toasts, `prefers-reduced-motion`, hit targets
- **SW v2** — full module precache (discovery, ingest, a11y, presets, …)
- **Server hardening:** SSRF block on job-fetch (private/metadata hosts), no client stack traces, body size cap
- **Import backup** in Settings (export was already there; restore merges data and keeps local API key)
- **Restored missing `jobCardHtml` / `bindJobCards`** (critical board regression) + score rings, match chips, shortlist ★
- **Hunt results ribbon** after discover/refresh; job list pagination (40/page); debounced filter
- **Visual:** SVG mark, score rings, pipeline status hairlines, card hover lift, subtle noise, tighter heading tracking
- **Microcopy** aligned to Hunt-from-resume primary path
- **Unit tests:** `npm test` / `node --test tests/unit.test.js` for match, links, filters, parseModelJson

## 1.8.0 — 2026-07-29

### ATS generator page + leaner UI

- New **ATS** nav page: paste job URL + JD → Master resume → local or Grok ATS pack → **Save to Pipeline**
- Fetch listing from URL; copy/export; cover note optional
- Streamlined sidebar (Home · Hunt · ATS · Pipeline · Resumes · Settings; More for Recommended/Domains/Profile)
- Job board overflow menu for bulk/manual; pipeline **+ ATS pack**
- Keyboard **T** opens ATS

---

## 1.7.0 — 2026-07-29

### Tier 4 — presets, wizard, source health

- **Guided setup wizard** (auto on first incomplete setup; Settings → Replay)
- **Named hunt presets** — save/load/delete on Job board; export/import JSON + run from Settings
- **Source health** dots on discovery (probe each board)
- **Hard score filter** — min score applies to All scored shelf when enabled

---

## 1.6.0 — 2026-07-29

### Tier 1–3 polish

**Tier 1**
- Daily loop dashboard (resume → hunt → decide → follow up)
- First-run 3-card path; empty shelves with clear CTAs
- Worth applying / Shortlist / All shelves; min score + hide deal-breakers
- Shortlist ★ on jobs; Refresh last hunt
- Application next follow-up date (+1/+3/+7d); overdue strip on dashboard

**Tier 2**
- Job detail drawer (match reasons + JD)
- Prep pack export (markdown)
- Near-duplicate job collapse (title+company)
- Optional Grok refine hunt queries

**Tier 3**
- Keyboard shortcuts (H/U/J/A/D/R/?)
- Weekly at-a-glance strip on dashboard

---

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
