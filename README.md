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

## Quick start

Needs a modern browser + [Python 3](https://www.python.org/downloads/) (for a tiny local server).

### Mac / Linux

```bash
cd bootstraps
chmod +x start.sh
./start.sh
```

Open **http://127.0.0.1:8790**

### Windows

Double-click **`start.bat`**, or:

```bat
cd bootstraps
python -m http.server 8790
```

---

## First session (15 minutes)

The **Dashboard** shows a live checklist. Fast path:

1. **Load sample data** (Dashboard) — demo resume, scored jobs, applications with JDs, and a flagged domain.  
   Or paste your real **Master** resume and fill **Profile**.
2. **Job board** → **Fetch Remotive** or use sample jobs; scores show a **breakdown** (skills / keywords / domain / salary / remote).
3. **Log apply** from a card — the **job description is stored** on the application (for domain analysis later).
4. **Settings** → optional xAI/Grok API key for Prepare + deep analysis.
5. Update statuses on the **Applications → Pipeline** board (drag cards or use the status menu).  
6. **Domain intel** when flags appear → **Analyze failures** → accept/reject each suggestion → **Apply accepted → Working**.

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
