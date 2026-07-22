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
    source: input.source || 'manual',
    externalId: input.externalId || '',
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
 * Bulk-import jobs from free text:
 * - Remotive-style JSON: { "jobs": [ ... ] } or a raw array
 * - Blocks separated by --- or blank lines, fields as Title: / Company: / URL: / Salary: / Description:
 * - TSV lines: title\tcompany\turl\tdescription
 *
 * @param {string} raw
 * @returns {object[]} normalized job stubs (not yet scored)
 */
export function parseBulkJobs(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  // JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.jobs || data.items || [];
      return list
        .map((j, i) => {
          if (j.company_name || j.candidate_required_location) {
            return normalizeRemotive(j);
          }
          return normalizeManual({
            source: j.source || 'import',
            externalId: j.id != null ? String(j.id) : j.externalId || `import-${i}`,
            title: j.title || j.name || '',
            company: j.company || j.company_name || '',
            url: j.url || j.link || '',
            description: stripHtml(j.description || j.summary || j.content || ''),
            category: j.category || '',
            salaryText: j.salary || j.salaryText || '',
            domains: j.domains || [],
            tags: j.tags || [],
            remote: j.remote !== false,
          });
        })
        .filter((j) => j.title);
    } catch {
      /* fall through to text parsers */
    }
  }

  // TSV
  const lines = text.split(/\n/);
  if (lines.length >= 1 && lines[0].includes('\t')) {
    const out = [];
    for (const line of lines) {
      const parts = line.split('\t').map((s) => s.trim());
      if (parts.length < 2 || !parts[0]) continue;
      out.push(
        normalizeManual({
          source: 'import',
          title: parts[0],
          company: parts[1] || '',
          url: parts[2] || '',
          description: parts[3] || '',
          salaryText: parts[4] || '',
        })
      );
    }
    if (out.length) return out;
  }

  // Blocks: Title: ... Company: ... separated by --- 
  const blocks = text.split(/\n---+\n|\n{3,}/);
  const out = [];
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    const get = (label) => {
      const re = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'im');
      const m = b.match(re);
      return m ? m[1].trim() : '';
    };
    let title = get('Title') || get('Role') || get('Position');
    let company = get('Company') || get('Org') || get('Organization');
    let url = get('URL') || get('Link') || get('Href');
    let salaryText = get('Salary') || get('Comp') || get('Pay');
    let description = '';
    const descM = b.match(/^(?:Description|JD|Details)\s*:\s*([\s\S]+)/im);
    if (descM) description = descM[1].trim();
    // Fallback: first line title, second company
    if (!title) {
      const ls = b.split(/\n/).map((l) => l.trim()).filter(Boolean);
      title = ls[0] || '';
      if (!company && ls[1] && !/^https?:/i.test(ls[1])) company = ls[1];
      if (!url) {
        const u = ls.find((l) => /^https?:\/\//i.test(l));
        if (u) url = u;
      }
      if (!description && ls.length > 2) {
        description = ls
          .slice(2)
          .filter((l) => l !== url)
          .join('\n');
      }
    }
    if (!title) continue;
    out.push(
      normalizeManual({
        source: 'import',
        title,
        company,
        url,
        description: description || b,
        salaryText,
      })
    );
  }
  return out;
}

/**
 * Score + upsert bulk jobs into IndexedDB.
 */
export async function importBulkJobs(rawText, profile, resumeBody, knownDomains) {
  const stubs = parseBulkJobs(rawText);
  let added = 0;
  let updated = 0;
  const jobs = [];
  for (const raw of stubs) {
    const existing =
      raw.externalId && raw.source
        ? await findJobByExternal(raw.source, raw.externalId)
        : null;
    const domains = raw.domains?.length ? raw.domains : inferDomains(raw, knownDomains);
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
    jobs.push(record);
  }
  return { added, updated, total: stubs.length, jobs };
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
