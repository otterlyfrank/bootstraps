/**
 * Per-source discover / hunt progress UI.
 */

import { esc } from './dom.js';

/**
 * @param {HTMLElement | null} host
 * @param {{
 *   phase?: string,
 *   sources?: string[],
 *   counts?: Record<string, number>,
 *   errors?: Record<string, string>,
 *   scored?: number,
 *   total?: number,
 *   label?: string,
 * }} progress
 */
export function renderDiscoverProgress(host, progress = {}) {
  if (!host) return;
  const sources = progress.sources || Object.keys(progress.counts || {});
  const counts = progress.counts || {};
  const errors = progress.errors || {};
  const scored = progress.scored ?? 0;
  const total = progress.total ?? 0;
  const scorePct = total > 0 ? Math.round((scored / total) * 100) : 0;

  const rows =
    sources.length > 0
      ? sources
          .map((sid) => {
            const err = errors[sid];
            const n = counts[sid];
            const done = n != null || err;
            const cls = err ? 'err' : done ? 'ok' : 'pending';
            const detail = err ? esc(String(err).slice(0, 48)) : n != null ? `${n} roles` : '…';
            return `<div class="disc-src-row ${cls}">
              <span class="disc-src-dot" aria-hidden="true"></span>
              <span class="disc-src-name">${esc(sid)}</span>
              <span class="disc-src-detail dim">${detail}</span>
            </div>`;
          })
          .join('')
      : '';

  host.innerHTML = `
    <div class="disc-progress" role="status" aria-live="polite">
      <div class="disc-progress-label">${esc(progress.label || progress.phase || 'Working…')}</div>
      ${
        total > 0
          ? `<div class="disc-progress-bar" aria-valuenow="${scorePct}" aria-valuemin="0" aria-valuemax="100">
              <i style="width:${scorePct}%"></i>
            </div>
            <p class="dim disc-progress-meta">Scoring ${scored}/${total}</p>`
          : ''
      }
      ${rows ? `<div class="disc-src-list">${rows}</div>` : ''}
    </div>`;
  host.hidden = false;
}

export function clearDiscoverProgress(host) {
  if (!host) return;
  host.innerHTML = '';
  host.hidden = true;
}
