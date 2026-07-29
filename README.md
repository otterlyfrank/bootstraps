# Bootstraps

**Pull yourself up by the bootstraps — then keep climbing.**  
Local-first job hunt optimization: find high-fit remote roles, track every application, and turn rejection patterns into a better **Working Resume** — while your **Master Resume** stays clean.

> Hunt → apply → log outcomes → detect weak domains → deep analysis → climb.

![Local-first](https://img.shields.io/badge/data-local--first-green)
![License: free personal use](https://img.shields.io/badge/license-free%20personal%20use-blue)

**Private repository** for now. Free for personal use; commercial redistribution needs permission. License can be changed later if you go public.

---

## If this helps you get hired

Bootstraps is free. If it helps you land a role, get interviews, or improve your materials, **please consider donating** — it funds continued development.

- **GitHub Sponsors** — set your URL in Settings (or update the defaults in the app)  
- **Ko-fi** — same  

You’ll also see a soft reminder in the app sidebar and on the dashboard.

---

## Install as an app (recommended)

Bootstraps is a **browser app** (PWA). No native binary, no Rust, no compile step.

Once it’s open over **http://localhost** (or a future public HTTPS URL):

1. **Chrome / Edge** — install icon in the address bar, or menu → **Install Bootstraps…** / **Install page as app**  
2. **Safari (Mac)** — **File → Add to Dock…**  
3. **iPhone / iPad** — Share → **Add to Home Screen**

That puts Bootstraps in your Applications list / Start menu and lets you **pin it to the Dock or taskbar**, with a chrome-less window.

In-app: **Settings → Install Bootstraps**, or the sidebar **Install app** button when the browser offers a prompt.

Your hunt data stays in **this browser profile’s IndexedDB** (export from Settings anytime).

> **Public host (later):** serve this folder on HTTPS. The same Install flow works for anyone who visits — try in browser first, install if they like it.

---

## Quick start (local)

Needs a modern browser + [Python 3](https://www.python.org/downloads/) (tiny local server so modules / PWA work — do **not** open `index.html` as a file).

### Mac / Linux

```bash
cd bootstraps
chmod +x start.sh
./start.sh
```

Open **http://127.0.0.1:8792** → then **Install app** (see above).

### Windows

Double-click **`start.bat`**, or:

```bat
cd bootstraps
python -m http.server 8792
```

Then install from the browser as above.

---

## Job discovery (robust)

| Path | How |
|------|-----|
| **Discover** | Multi-board: **Remotive**, **Remote OK**, **Arbeitnow**, **Jobicy**, optional **Himalayas**. Keyword search (defaults from Profile skills). Parallel fetch on your machine, score, dedupe. |
| **Paste links** | Dump Greenhouse / Lever / Ashby / LinkedIn / career URLs. ATS URLs use public JSON APIs when possible; else HTML extract. Batch fetch. |
| **Remotive only** | Single-board shortcut. |
| **Bulk import** | Structured paste (Title/Company/URL blocks, TSV, JSON). Pure URL lists auto-route to Paste links. |
| **Manual** | One-off title + company + URL + JD. |

`./start.sh` runs `scripts/bootstraps_server.py`:

- `POST /api/discover` — multi-source boards  
- `POST /api/job-fetch` / `/api/job-fetch-batch` — link resolve  
- Static UI  

Plain `python -m http.server` serves UI only (no discovery APIs).

---

## Resume upload (PDF)

1. **Settings** → Grok/xAI base URL + API key (for full assist).  
2. **Resumes** → **Choose PDF / DOCX** or drop a file.  
3. Bootstraps extracts text locally, Grok cleans Master + fills **Profile** (skills, keywords, domains), copies **Working**, rescored job matches.  
4. Edit anything in Master/Working/Profile, then **Discover jobs**.

Without an API key, text still extracts and a local heuristic fills what it can.

---

## First session (15 minutes)

The **Dashboard** shows a live checklist. Fast path:

1. **Upload resume (PDF)** or load sample data. With Grok configured, Profile populates automatically.  
2. **Job board** → **Discover** / **Paste links**. Scores show a **breakdown**.
3. **Prepare** on a card → **free local prep** (keyword coverage + pack) works offline; optional **Polish with Grok**.
4. **Log apply** — JD is stored for the learning loop.
5. **Applications → Pipeline** — drag status changes.
6. **Resumes → Master ↔ Working diff** — see what evolved.
7. **Domain intel** → accept/reject suggestions → apply to Working.

---

## Dual resume system

| Version | Role |
|---------|------|
| **Master** | Stable base you control. Reference truth. |
| **Working** | Living document used for match scoring & prep. Evolves from accepted suggestions and manual edits. |

Every meaningful Working change can be logged in **improvement history** (reason + optional domain link).

---

## Learning loop

1. Applications store status + domain tags.
2. Domain density is computed (configurable thresholds in Settings).
3. High rejection / ghost rate with few interviews → **flag**.
4. **Analyze failures** packages: Working Resume + application outcomes → Grok **deep** model.
5. You **accept** (full draft or append sections) or **discard**.

No cloud required for tracking — only optional API calls for generation/analysis.

---

## Grok / API usage (cost-aware)

| Task | Default tier | Config key |
|------|----------------|------------|
| Prepare application (tailored resume, cover note) | **Fast** | `fastModel` |
| Domain failure analysis | **Deep** | `deepModel` |

Defaults live in `src/config.js` and Settings:

- Base URL: `https://api.x.ai/v1`
- Fast model: `grok-4-1-fast-non-reasoning` (edit if your account uses different IDs)
- Deep model: `grok-4-1-fast-reasoning`

Prompts are in `src/ai/prompts.js` — structured, truncated context, JSON-only outputs.

The sidebar shows **approximate** token spend (display-only; update rates in `TOKEN_COST_USD` if pricing changes).

---

## Job discovery

- **Remotive** — public API, no key (`src/jobs/sources.js`).
- **Manual entry** — paste JD from We Work Remotely, LinkedIn, email, etc.
- **Match score** — skills, keywords, preferred domains, salary floor, remote + deal-breakers (`src/jobs/match.js`).

---

## Data & export

All data in **IndexedDB** (`bootstraps` database):

- Profile, settings, master/working resumes, history  
- Jobs, applications, AI usage ledger  

**Settings → Export JSON** or resume/application Markdown exports from their screens.

API keys are stored only in your browser; JSON export redacts the key.

---

## Project layout

```text
bootstraps/
  index.html
  start.sh · start.bat
  src/
    config.js          # models, thresholds, weights
    main.js · app.js · styles.css
    storage/db.js      # IndexedDB
    jobs/match.js · sources.js · learning.js
    resume/            # (reserved)
    ai/client.js · prompts.js
    lib/export.js
```

---

## Non-goals

Mass auto-apply · LinkedIn scraping · multi-user cloud sync · noisy vanity dashboards.

---

## License

**Free personal use** (source-available) — see [LICENSE](./LICENSE).

- Use and modify for yourself freely  
- Don’t sell the product or host it as a paid service without permission  
- No warranty  

If you’re unsure about open-source (MIT, Apache, etc.) later: personal-use is a safe default while the repo is private. Switching to MIT before a public launch is easy and still compatible with “please donate if this helped you get a job.”
