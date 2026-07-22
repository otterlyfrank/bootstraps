/**
 * Score jobs against profile + working (or master) resume.
 */

import { MATCH_WEIGHTS } from '../config.js';

/**
 * Tokenize text into lowercase keyword set.
 * @param {string} text
 */
export function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s/-]/g, ' ')
      .split(/[\s,/|;]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length < 40)
  );
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.min(a.size, Math.max(8, Math.min(a.size, b.size)));
}

function listToSet(list) {
  const s = new Set();
  for (const item of list || []) {
    for (const t of tokenize(String(item))) s.add(t);
  }
  return s;
}

/**
 * Parse rough monthly USD from salary strings.
 * @param {string} text
 * @param {number|null} min
 * @param {number|null} max
 */
export function salaryFit(text, min, max, floor, ceiling) {
  const lo = min ?? extractSalaryNumber(text, 'min');
  const hi = max ?? extractSalaryNumber(text, 'max') ?? lo;
  if (lo == null && hi == null) return 0.55; // unknown — neutral
  const mid = ((lo ?? hi) + (hi ?? lo)) / 2;
  // Prefer mid in [floor, ceiling*1.5]
  if (mid < floor * 0.7) return 0.15;
  if (mid < floor) return 0.4;
  if (mid <= (ceiling || floor * 1.5) * 1.2) return 1;
  if (mid <= (ceiling || floor * 2) * 1.5) return 0.7;
  return 0.5;
}

function extractSalaryNumber(text, which) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Prefer full numbers: $2,500 · $2500 · 2.5k · 2000-3000
  const nums = [
    ...t.matchAll(/\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(k)?/gi),
    ...t.matchAll(/\b(\d+(?:\.\d+)?)\s*k\b/gi),
    ...t.matchAll(/\b(\d{3,6})\b/g),
  ].map((m) => {
    let n = parseFloat(String(m[1]).replace(/,/g, ''));
    if (m[2] || /k\b/i.test(m[0])) n *= n < 1000 ? 1000 : 1;
    if (/k\b/i.test(m[0]) && n < 1000) n *= 1000;
    // yearly heuristic
    if (n > 20000) n = Math.round(n / 12);
    return n;
  }).filter((n) => n >= 500 && n <= 50000);
  if (!nums.length) return null;
  nums.sort((a, b) => a - b);
  return which === 'max' ? nums[nums.length - 1] : nums[0];
}

/**
 * Guess domains from job title + description + category.
 * @param {{ title?: string, description?: string, category?: string }} job
 * @param {string[]} knownDomains
 */
export function inferDomains(job, knownDomains = []) {
  const blob = `${job.title || ''} ${job.category || ''} ${(job.description || '').slice(0, 2000)}`.toLowerCase();
  const hits = [];
  const rules = [
    ['Data Analysis', /data anal|analytics|sql|bi |business intelligence|tableau|power bi|metric/],
    ['Strategy', /strateg|ops strateg|growth strateg|corporate strateg/],
    ['Research', /research|policy|market research|user research|insight/],
    ['Web3/Blockchain', /web3|blockchain|crypto|defi|solidity|on-?chain/],
    ['Marketing/BD', /marketing|business development|bd |growth market|demand gen/],
    ['Product', /product manag|product owner|pm\b|roadmap/],
    ['Operations', /operations|ops manag|chief of staff|program manag/],
    ['Writing/Content', /content writ|copywrit|technical writ|editorial/],
    ['Hybrid', /hybrid role|generalist|player.?coach/],
  ];
  for (const [domain, re] of rules) {
    if (re.test(blob)) hits.push(domain);
  }
  for (const d of knownDomains) {
    if (hits.includes(d)) continue;
    if (blob.includes(String(d).toLowerCase())) hits.push(d);
  }
  return hits.length ? hits : ['Other'];
}

/**
 * @param {object} job
 * @param {{ skills?: string[], experienceKeywords?: string[], preferredDomains?: string[], salaryFloorUsd?: number, salaryCeilingUsd?: number, dealBreakers?: string[], remoteOnly?: boolean }} profile
 * @param {string} resumeBody
 * @returns {{ score: number, breakdown: object, domains: string[] }}
 */
export function scoreJob(job, profile, resumeBody) {
  const resumeTokens = tokenize(resumeBody);
  const skillSet = listToSet(profile.skills || []);
  const expSet = listToSet(profile.experienceKeywords || []);
  const jobTokens = tokenize(
    `${job.title || ''} ${job.company || ''} ${job.category || ''} ${(job.description || '').slice(0, 4000)}`
  );

  const skillOverlap = skillSet.size
    ? overlapRatio(skillSet, jobTokens)
    : overlapRatio(resumeTokens, jobTokens) * 0.6;
  const keywordOverlap = expSet.size
    ? 0.5 * overlapRatio(expSet, jobTokens) + 0.5 * overlapRatio(resumeTokens, jobTokens)
    : overlapRatio(resumeTokens, jobTokens);

  const domains = job.domains?.length ? job.domains : inferDomains(job, profile.preferredDomains);
  const preferred = new Set((profile.preferredDomains || []).map((d) => d.toLowerCase()));
  const domainBoost = domains.some((d) => preferred.has(String(d).toLowerCase()))
    ? 1
    : domains.includes('Other')
      ? 0.35
      : 0.5;

  const sal = salaryFit(
    job.salaryText || '',
    job.salaryMin,
    job.salaryMax,
    profile.salaryFloorUsd || 2000,
    profile.salaryCeilingUsd || 3500
  );

  const remoteFit =
    profile.remoteOnly === false ? 1 : job.remote !== false ? 1 : 0.1;

  // Deal-breakers
  let penalty = 0;
  const blob = `${job.title} ${job.description} ${job.salaryText}`.toLowerCase();
  for (const db of profile.dealBreakers || []) {
    const k = String(db).toLowerCase().trim();
    if (k && blob.includes(k)) penalty += 0.25;
  }
  if (/unpaid|volunteer|equity only|crypto only/i.test(blob)) penalty += 0.2;

  const w = MATCH_WEIGHTS;
  let raw =
    w.skillOverlap * clamp01(skillOverlap) +
    w.keywordOverlap * clamp01(keywordOverlap) +
    w.domainBoost * clamp01(domainBoost) +
    w.salaryFit * clamp01(sal) +
    w.remoteFit * clamp01(remoteFit);

  raw = Math.max(0, raw - penalty);
  const score = Math.round(clamp01(raw) * 100);

  return {
    score,
    domains,
    breakdown: {
      skillOverlap: round2(skillOverlap),
      keywordOverlap: round2(keywordOverlap),
      domainBoost: round2(domainBoost),
      salaryFit: round2(sal),
      remoteFit: round2(remoteFit),
      penalty: round2(penalty),
    },
  };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Build recommended digest (top N unscored-applied jobs).
 * @param {object[]} jobs
 * @param {Set<string>} appliedJobIds
 * @param {{ min?: number, max?: number }} size
 */
export function buildDigest(jobs, appliedJobIds, size = { min: 4, max: 8 }) {
  const open = jobs
    .filter((j) => !j.dismissed && !appliedJobIds.has(j.id))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const max = size.max || 8;
  const min = size.min || 4;
  const take = Math.min(max, Math.max(min, Math.min(open.length, max)));
  // If fewer than min, take what we have
  return open.slice(0, Math.min(open.length, take < min ? open.length : max));
}
