/**
 * Printable / shareable ATS application pack.
 */

import { esc } from './dom.js';

/**
 * Build markdown for export/copy.
 */
export function applicationPackMarkdown({ title, company, url, resume, coverNote, score }) {
  return `# Application pack — ${title || 'Role'}${company ? ` @ ${company}` : ''}

${url ? `**Listing:** ${url}\n` : ''}${score != null ? `**Match score:** ${score}\n` : ''}
## Cover note

${coverNote?.trim() || '_None_'}

## ATS resume

${resume?.trim() || '_Empty_'}

---
_Generated with Bootstraps_
`;
}

/**
 * Open a print-friendly pack in a new window (or print dialog).
 * @param {{ title: string, company: string, url?: string, resume: string, coverNote?: string, score?: number }} pack
 */
export function openPrintablePack(pack) {
  const title = pack.title || 'Untitled role';
  const company = pack.company || '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Application pack — ${esc(title)}</title>
  <style>
    :root {
      --ink: #1c1915;
      --muted: #5c564c;
      --rule: #d4cbbd;
      --paper: #faf7f1;
      --accent: #4a6b48;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #e8e2d6;
      color: var(--ink);
      font-family: "Iowan Old Style", Palatino, Georgia, "Times New Roman", serif;
      font-size: 11.5pt;
      line-height: 1.55;
    }
    .sheet {
      max-width: 8.5in;
      min-height: 11in;
      margin: 1.5rem auto;
      padding: 0.85in 0.9in;
      background: var(--paper);
      box-shadow: 0 12px 40px rgba(28, 25, 21, 0.18);
      border: 1px solid var(--rule);
    }
    .brand {
      font-size: 0.72rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
      font-family: system-ui, sans-serif;
      margin: 0 0 0.35rem;
    }
    h1 {
      font-size: 1.55rem;
      font-weight: 600;
      margin: 0 0 0.2rem;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .meta {
      color: var(--muted);
      font-size: 0.92rem;
      margin: 0 0 1.25rem;
      font-family: system-ui, sans-serif;
    }
    .meta a { color: var(--accent); }
    h2 {
      font-size: 0.78rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      border-bottom: 1px solid var(--rule);
      padding-bottom: 0.3rem;
      margin: 1.4rem 0 0.65rem;
      font-family: system-ui, sans-serif;
      font-weight: 700;
    }
    .cover, .resume {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      padding: 0.75rem;
      background: rgba(28, 25, 21, 0.88);
      backdrop-filter: blur(8px);
    }
    .toolbar button {
      font: 600 0.85rem system-ui, sans-serif;
      border: 0;
      border-radius: 8px;
      padding: 0.5rem 0.9rem;
      cursor: pointer;
      background: #8fad8a;
      color: #161411;
    }
    .toolbar button.ghost {
      background: transparent;
      color: #e4ddd2;
      border: 1px solid #3a342c;
    }
    @media print {
      body { background: white; }
      .toolbar { display: none !important; }
      .sheet {
        margin: 0;
        box-shadow: none;
        border: 0;
        max-width: none;
        min-height: 0;
        padding: 0.4in 0.55in;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button type="button" onclick="window.print()">Print / Save PDF</button>
    <button type="button" class="ghost" onclick="window.close()">Close</button>
  </div>
  <article class="sheet">
    <p class="brand">Bootstraps · application pack</p>
    <h1>${esc(title)}</h1>
    <p class="meta">
      ${esc(company)}${pack.score != null ? ` · match ${pack.score}` : ''}
      ${pack.url ? `<br/><a href="${esc(pack.url)}">${esc(pack.url)}</a>` : ''}
    </p>
    ${
      pack.coverNote?.trim()
        ? `<h2>Cover note</h2><div class="cover">${esc(pack.coverNote.trim())}</div>`
        : ''
    }
    <h2>ATS resume</h2>
    <div class="resume">${esc((pack.resume || '').trim() || '—')}</div>
  </article>
</body>
</html>`;

  const w = window.open('', '_blank', 'noopener,noreferrer');
  if (!w) {
    // popup blocked — download HTML instead
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `application-pack-${(title || 'role').replace(/\W+/g, '-').slice(0, 40)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    return { ok: true, mode: 'download' };
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  return { ok: true, mode: 'window' };
}
