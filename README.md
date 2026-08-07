# Bootstraps

**Pull yourself up by the bootstraps — then keep climbing.**  
Local-first job hunt optimization: find high-fit remote roles, track every application, and turn rejection patterns into a better **Working Resume** — while your **Master Resume** stays clean.

> Hunt → apply → log outcomes → detect weak domains → deep analysis → climb.

![Local-first](https://img.shields.io/badge/data-local--first-green)
![License: free personal use](https://img.shields.io/badge/license-free%20personal%20use-blue)
![GitHub](https://img.shields.io/badge/github-public-brightgreen)

**Public source** — free for personal use; commercial redistribution needs permission. See [LICENSE](./LICENSE).

**Repo:** [github.com/otterlyfrank/bootstraps](https://github.com/otterlyfrank/bootstraps)

---

## If this helps you get hired

Bootstraps is free. If it helps you land a role, get interviews, or improve your materials, **please consider donating** — it funds continued development.

- **[Ko-fi — otterlyfrank](https://ko-fi.com/otterlyfrank)**  

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

## Job discovery — what can be automated?

| Automatable (public boards) | Walled gardens (not scraped) |
|----------------------------|------------------------------|
| Remotive, Remote OK, Arbeitnow, Jobicy, Himalayas | LinkedIn, Indeed, most company portals without public APIs |
| Paste Greenhouse / Lever / Ashby job URLs | Full-site crawls that violate ToS / need login |
| Score vs Working resume + profile | Apply on your behalf |

**Hunt from resume** builds multiple search queries from your skills/domains/resume titles, queries those public boards in parallel, scores every hit, and ranks them. Your Grok key is for resume/prep/analysis — **not** required for board pulls.

| Path | How |
|------|-----|
| **Hunt from resume** | One click: multi-query plan → boards → score (Job board). |
| **Custom discover** | Edit keywords/sources in Advanced. |
| **Paste links** | Your collected URLs (ATS APIs + HTML fetch). |
| **Remotive only** | Single-board shortcut. |
| **Bulk / Manual** | Structured or one-off entry. |
| **Research boards** | Optional: Workew, RWFA, Solana Jobs, **BlackRock Budapest** (unchecked by default). |
| **Upload scrape sources** | Advanced → custom JSON (`rss` / `sitemap_jsonld` / `getro` / `talentbrew`) → local `data/custom_sources.json`. |
| **English required** | Hunt filter (and Settings): only show roles that appear to require English. Works on every board. |
| **ATS → Download PDF** | Tailored resume (+ optional cover letter page) as a polished, ATS-friendly US Letter PDF. |
| **Cover letter** | Simple Dear / body / Warm Regards template; tweak in Settings; Grok draws on resume skills + portfolio. |

### Dual path: personal research vs public custom uploads

- **Research boards** ship as optional built-ins so a local hunt can tick Workew / RWFA / Solana / BlackRock Budapest without config files.
- **Any clone / GitHub user** can also **upload** their own boards via the same adapters (RSS feed URL, job sitemap + JSON-LD, Getro, or TalentBrew). Uploads stay on the machine in `data/custom_sources.json` (gitignored). See `data/custom_sources.example.json`.

`./start.sh` runs `scripts/bootstraps_server.py`:

- `POST /api/discover` — multi-source boards  
- `POST /api/job-fetch` / `/api/job-fetch-batch` — link resolve  
- Static UI  

Plain `python -m http.server` serves UI only (no discovery APIs).

### Power features (v1.10)

| Feature | How |
|---------|-----|
| **Command palette** | `⌘K` / `Ctrl+K` or topbar **⌘K** |
| **Session mode** | `S` or topbar **Session** — dim chrome, prepare goal HUD |
| **Climb timeline** | Home — 8-week sparklines + Working resume evolution |
| **Application pack** | ATS / Prepare → **Application pack** (print / Save PDF) |
| **Hunt progress** | Per-board counts + scoring bar while discovering |

### Security (local bridge)

The job-fetch API is an intentional **open URL fetcher for your machine**. It binds to **`127.0.0.1` by default** and blocks private/metadata addresses (SSRF guard). **Do not** run with `--host 0.0.0.0` or put this behind a public URL without auth — anyone who can hit the port could use it as a proxy.

### Backup & restore

**Settings → Export JSON** downloads jobs, applications, resumes, profile, and settings (API key redacted). **Import JSON** restores into this browser and keeps your current Grok key when the file has a redacted key.

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
