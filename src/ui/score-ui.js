/**
 * Match score visuals — rings, chips, breakdown bars.
 */

import { esc } from './dom.js';

export function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

export function scoreClass(score) {
  if (score >= 60) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

export function scoreRingHtml(score) {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  const r = 18;
  const c = 2 * Math.PI * r;
  const offset = c - (n / 100) * c;
  const cls = scoreClass(n);
  return `<div class="score-ring ${cls}" title="Match score vs Working resume + profile" aria-label="Match score ${n}">
    <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
      <circle class="score-ring-bg" cx="22" cy="22" r="${r}" />
      <circle class="score-ring-fg" cx="22" cy="22" r="${r}"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
    </svg>
    <span class="score-ring-n">${n}</span>
  </div>`;
}

export function matchChipsHtml(j) {
  const b = j.scoreBreakdown;
  if (!b) return '';
  const chips = [];
  if (b.skillOverlap >= 0.45) chips.push('Skills fit');
  if (b.keywordOverlap >= 0.4) chips.push('Keywords');
  if (b.domainBoost >= 0.9) chips.push('Domain match');
  if (b.salaryFit >= 0.85) chips.push('Salary OK');
  else if (b.salaryFit <= 0.4 && b.salaryFit != null) chips.push('Salary risk');
  if (b.remoteFit < 0.5) chips.push('Remote risk');
  if (b.penalty) chips.push('Penalties');
  if (!chips.length) return '';
  return `<div class="match-chips">${chips.map((c) => `<span class="match-chip">${esc(c)}</span>`).join('')}</div>`;
}

export function scoreBreakdownHtml(j) {
  const b = j.scoreBreakdown;
  if (!b) return '';
  const row = (label, v) => {
    const pct = Math.round(clamp01(v) * 100);
    return `<div class="score-bar-row" title="${esc(label)}: ${pct}%">
      <span>${esc(label)}</span>
      <div class="score-bar"><i style="width:${pct}%"></i></div>
      <span class="score-bar-n">${pct}</span>
    </div>`;
  };
  return `<div class="score-breakdown">
    ${row('Skills', b.skillOverlap)}
    ${row('Keywords', b.keywordOverlap)}
    ${row('Domain', b.domainBoost)}
    ${row('Salary', b.salaryFit)}
    ${row('Remote', b.remoteFit)}
    ${
      b.penalty
        ? `<div class="score-bar-row dim"><span>Penalties</span><span class="score-bar-n">−${Math.round(
            clamp01(b.penalty) * 100
          )}</span></div>`
        : ''
    }
  </div>`;
}
