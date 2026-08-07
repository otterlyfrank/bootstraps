# Views module layout

Presentation is modularized under `src/ui/` and composed from `src/app.js`.

| Module | Responsibility |
|--------|----------------|
| `src/ui/dom.js` | `$`, `esc`, `toast` |
| `src/ui/score-ui.js` | Score rings, chips, breakdown bars |
| `src/ui/job-cards.js` | Job card HTML + event binding |
| `src/ui/climb-timeline.js` | Weekly sparklines + resume evolution |
| `src/ui/command-palette.js` | ⌘K command palette |
| `src/ui/print-pack.js` | Printable ATS application pack |
| `src/lib/pdf-resume.js` | One-click ATS resume PDF (job-site upload) |
| `src/ui/discover-progress.js` | Per-source hunt progress |
| `src/ui/session-mode.js` | Ambient session focus mode |
| `src/lib/a11y.js` | Focus trap / dialog wiring |

`app.js` remains the composition root (state, shell, view routing, domain workflows).
New UI surfaces should land in `src/ui/*` first; route handlers stay in `app.js` until a view exceeds ~400 lines, then extract to `src/views/<name>.js` with an `api` context object.
