/**
 * Job sources — Remotive public API + manual normalization.
 */

import { REMOTIVE_API } from '../config.js';
import { findJobByExternal, putJob } from '../storage/db.js';
import { inferDomains, scoreJob } from './match.js';

/**
 * Strip HTML tags from Remotive descriptions (lightweight).
 */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Fetch remote jobs from Remotive.
 * @param {{ category?: string, search?: string, limit?: number }} opts
 */
export async function fetchRemotive(opts = {}) {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.search) params.set('search', opts.search);
  if (opts.limit) params.set('limit', String(opts.limit));
  const url = `${REMOTIVE_API}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Remotive error ${res.status}`);
  const data = await res.json();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map(normalizeRemotive);
}

function normalizeRemotive(j) {
  const description = stripHtml(j.description || '');
  return {
    externalId: String(j.id),
    source: 'remotive',
    title: j.title || 'Untitled',
    company: j.company_name || '',
    url: j.url || j.candidate_required_location || '',
    description,
    category: j.category || '',
    salaryText: j.salary || '',
    salaryMin: null,
    salaryMax: null,
    tags: Array.isArray(j.tags) ? j.tags : [],
    remote: true,
    fetchedAt: Date.now(),
  };
}

/**
 * Import/fetch Remotive jobs, score, upsert into IndexedDB.
 * @returns {{ added: number, updated: number, jobs: object[] }}
 */
export async function syncRemotive(opts, profile, resumeBody, knownDomains) {
  const remote = await fetchRemotive(opts);
  let added = 0;
  let updated = 0;
  const out = [];
  for (const raw of remote) {
    const existing = await findJobByExternal('remotive', raw.externalId);
    const domains = inferDomains(raw, knownDomains);
    const { score, breakdown, domains: d2 } = scoreJob(
      { ...raw, domains },
      profile,
      resumeBody || ''
    );
    const record = await putJob({
      ...(existing || {}),
      ...raw,
      id: existing?.id,
      domains: d2,
      score,
      scoreBreakdown: breakdown,
      dismissed: existing?.dismissed || false,
      fetchedAt: existing?.fetchedAt || Date.now(),
    });
    if (existing) updated++;
    else added++;
    out.push(record);
  }
  return { added, updated, jobs: out };
}

/**
 * Create a manual job entry.
 */
export function normalizeManual(input) {
  return {
    source: 'manual',
    externalId: '',
    title: (input.title || '').trim(),
    company: (input.company || '').trim(),
    url: (input.url || '').trim(),
    description: (input.description || '').trim(),
    category: input.category || '',
    salaryText: input.salaryText || '',
    domains: input.domains || [],
    tags: input.tags || [],
    remote: input.remote !== false,
    fetchedAt: Date.now(),
  };
}

/**
 * Re-score all jobs in memory against latest profile/resume.
 */
export async function rescoreAllJobs(jobs, profile, resumeBody) {
  const out = [];
  for (const job of jobs) {
    const { score, breakdown, domains } = scoreJob(job, profile, resumeBody || '');
    out.push(
      await putJob({
        ...job,
        score,
        scoreBreakdown: breakdown,
        domains: job.domains?.length ? job.domains : domains,
      })
    );
  }
  return out;
}
