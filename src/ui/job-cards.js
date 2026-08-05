/**
 * Job board card markup + event binding.
 */

import { formatDate } from '../lib/export.js';
import { requiresEnglish } from '../lib/job-filters.js';
import { esc } from './dom.js';
import { matchChipsHtml, scoreBreakdownHtml, scoreRingHtml } from './score-ui.js';

/**
 * @param {object} j
 * @param {{ compact?: boolean }} opts
 */
export function jobCardHtml(j, { compact } = {}) {
  const domains = (j.domains || []).map((d) => `<span class="tag">${esc(d)}</span>`).join('');
  const enChip = requiresEnglish(j)
    ? `<span class="tag soft" title="Looks like English is required or is the working language">EN</span>`
    : '';
  const desc = compact
    ? ''
    : `<p class="dim" style="margin:0.4rem 0 0">${esc((j.description || '').slice(0, 220))}${
        (j.description || '').length > 220 ? '…' : ''
      }</p>`;
  const chips = compact ? '' : matchChipsHtml(j);
  const breakdown = compact ? '' : scoreBreakdownHtml(j);
  return `
    <article class="job-card ${j.shortlisted ? 'shortlisted' : ''}" data-job-id="${j.id}">
      <div>
        <h3>
          <button type="button" class="job-title-btn" data-open-job="${j.id}">${esc(j.title)}</button>
        </h3>
        <div class="job-meta">${esc(j.company)} · ${esc(j.source)} · ${formatDate(j.fetchedAt)}</div>
        <div style="margin-top:0.35rem">${domains}${
          j.category ? `<span class="tag">${esc(j.category)}</span>` : ''
        }${enChip}<span class="tag">${esc(j.source || '—')}</span></div>
        ${chips}
        ${desc}
        ${breakdown}
      </div>
      <div class="row-actions job-card-actions">
        ${scoreRingHtml(j.score || 0)}
        <div class="row-actions" style="margin-top:0.4rem;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" class="btn ghost" data-star="${j.id}" aria-label="${
            j.shortlisted ? 'Remove from shortlist' : 'Add to shortlist'
          }">${j.shortlisted ? '★' : '☆'}</button>
          <button type="button" class="btn primary" data-prepare="${j.id}">Prepare</button>
          <button type="button" class="btn" data-apply="${j.id}">Log apply</button>
          ${j.url ? `<a class="btn ghost" href="${esc(j.url)}" target="_blank" rel="noopener">Open</a>` : ''}
          <button type="button" class="btn ghost" data-dismiss="${j.id}">Hide</button>
        </div>
      </div>
    </article>`;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   jobs: object[],
 *   prepareForJob: (id: string) => void,
 *   logApplyFromJob: (id: string) => void,
 *   openJobDrawer: (id: string) => void,
 *   onDismiss: (job: object) => Promise<void>,
 *   onStar: (job: object) => Promise<void>,
 * }} handlers
 */
export function bindJobCards(root, handlers) {
  const { jobs, prepareForJob, logApplyFromJob, openJobDrawer, onDismiss, onStar } = handlers;
  root.querySelectorAll('[data-prepare]').forEach((btn) => {
    btn.onclick = () => prepareForJob(btn.dataset.prepare);
  });
  root.querySelectorAll('[data-apply]').forEach((btn) => {
    btn.onclick = () => logApplyFromJob(btn.dataset.apply);
  });
  root.querySelectorAll('[data-dismiss]').forEach((btn) => {
    btn.onclick = async () => {
      const job = jobs.find((j) => j.id === btn.dataset.dismiss);
      if (!job) return;
      await onDismiss(job);
    };
  });
  root.querySelectorAll('[data-star]').forEach((btn) => {
    btn.onclick = async () => {
      const job = jobs.find((j) => j.id === btn.dataset.star);
      if (!job) return;
      await onStar(job);
    };
  });
  root.querySelectorAll('[data-open-job]').forEach((btn) => {
    btn.onclick = () => openJobDrawer(btn.dataset.openJob);
  });
}
