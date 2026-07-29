/**
 * Climb timeline — weekly application outcomes + resume evolution ticks.
 */

import { esc } from './dom.js';

/**
 * Bucket applications into last N weeks (oldest → newest).
 * @param {object[]} applications
 * @param {number} weeks
 */
export function weeklyAppBuckets(applications, weeks = 8) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // align to start of current week (Mon)
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day - (weeks - 1) * 7);

  /** @type {{ weekStart: number, label: string, applied: number, interview: number, offer: number, rejected: number }[]} */
  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    const w = new Date(start);
    w.setDate(start.getDate() + i * 7);
    const end = new Date(w);
    end.setDate(w.getDate() + 7);
    buckets.push({
      weekStart: w.getTime(),
      weekEnd: end.getTime(),
      label: w.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
    });
  }

  for (const a of applications || []) {
    const t = a.appliedAt || a.updatedAt || 0;
    if (!t) continue;
    for (const b of buckets) {
      if (t >= b.weekStart && t < b.weekEnd) {
        b.applied++;
        if (a.status === 'Interview') b.interview++;
        else if (a.status === 'Offer') b.offer++;
        else if (a.status === 'Rejected' || a.status === 'Ghosted') b.rejected++;
        break;
      }
    }
  }
  return buckets;
}

/**
 * SVG sparkline for a series of numbers.
 * @param {number[]} values
 * @param {{ width?: number, height?: number, className?: string, color?: string }} opts
 */
export function sparklineSvg(values, opts = {}) {
  const w = opts.width || 120;
  const h = opts.height || 32;
  const vals = values.length ? values : [0];
  const max = Math.max(1, ...vals);
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const pts = vals
    .map((v, i) => {
      const x = i * step;
      const y = h - 2 - (v / max) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = vals[vals.length - 1] || 0;
  return `<svg class="sparkline ${opts.className || ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline fill="none" stroke="${opts.color || 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />
    <circle cx="${((vals.length - 1) * step).toFixed(1)}" cy="${(h - 2 - (last / max) * (h - 6)).toFixed(1)}" r="2.5" fill="${opts.color || 'currentColor'}" />
  </svg>`;
}

/**
 * @param {object[]} applications
 * @param {object[]} history resume history entries
 */
export function climbTimelineHtml(applications, history) {
  const weeks = weeklyAppBuckets(applications, 8);
  const appliedSeries = weeks.map((w) => w.applied);
  const interviewSeries = weeks.map((w) => w.interview);
  const totalApplied = appliedSeries.reduce((a, b) => a + b, 0);
  const totalInterview = interviewSeries.reduce((a, b) => a + b, 0);
  const totalOffer = weeks.reduce((s, w) => s + w.offer, 0);
  const conversion =
    totalApplied > 0 ? Math.round((totalInterview / totalApplied) * 100) : 0;

  const ticks = (history || [])
    .slice(0, 6)
    .map((h) => {
      const when = h.createdAt
        ? new Date(h.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '—';
      return `<li>
        <span class="climb-tick-dot" aria-hidden="true"></span>
        <div>
          <strong>${esc(h.reason || h.source || 'Working update')}</strong>
          <span class="dim"> · ${esc(when)}${h.domain ? ` · ${esc(h.domain)}` : ''}</span>
        </div>
      </li>`;
    })
    .join('');

  return `
    <section class="climb-timeline card" aria-label="Climb timeline">
      <div class="climb-head">
        <div>
          <h3 style="margin:0;font-family:var(--serif)">Climb timeline</h3>
          <p class="dim" style="margin:0.25rem 0 0">Last 8 weeks · interview rate ${conversion}%</p>
        </div>
        <div class="climb-kpis">
          <span><strong>${totalApplied}</strong> apps</span>
          <span><strong>${totalInterview}</strong> interviews</span>
          <span><strong>${totalOffer}</strong> offers</span>
        </div>
      </div>
      <div class="climb-charts">
        <div class="climb-chart">
          <div class="climb-chart-label">Applications</div>
          ${sparklineSvg(appliedSeries, { className: 'spark-apps', color: 'var(--master)' })}
          <div class="climb-week-labels">${weeks
            .map((w, i) => (i % 2 === 0 ? `<span>${esc(w.label)}</span>` : '<span></span>'))
            .join('')}</div>
        </div>
        <div class="climb-chart">
          <div class="climb-chart-label">Interviews</div>
          ${sparklineSvg(interviewSeries, { className: 'spark-int', color: 'var(--accent)' })}
        </div>
      </div>
      <div class="climb-evolution">
        <h4 style="margin:0.75rem 0 0.4rem;font-size:0.85rem;color:var(--muted)">Working resume evolution</h4>
        ${
          ticks
            ? `<ul class="climb-ticks">${ticks}</ul>`
            : `<p class="dim" style="margin:0">Accept domain suggestions or edit Working to build this trail.</p>`
        }
      </div>
    </section>`;
}
