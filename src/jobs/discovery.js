/**
 * Multi-source job discovery — board feeds + paste-links orchestration.
 */

import { findJobByExternal, findJobByUrl, putJob } from '../storage/db.js';
import { inferDomains, scoreJob } from './match.js';
import { normalizeManual } from './sources.js';
import { parseJobLinks, fetchJobFromLink, normalizeJobUrl } from './links.js';

/** Built-in catalog (mirrors server; used if /api/sources fails). */
export const DISCOVERY_SOURCES = [
  { id: 'remotive', name: 'Remotive', blurb: 'Curated remote roles', default: true },
  { id: 'remoteok', name: 'Remote OK', blurb: 'Large remote feed', default: true },
  { id: 'arbeitnow', name: 'Arbeitnow', blurb: 'EU + remote board', default: true },
  { id: 'jobicy', name: 'Jobicy', blurb: 'Remote jobs API', default: true },
  { id: 'himalayas', name: 'Himalayas', blurb: 'Remote-first (best-effort)', default: false },
];

export async function loadSourceCatalog() {
  try {
    const res = await fetch('/api/sources');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (data.ok && Array.isArray(data.sources) && data.sources.length) {
      return data.sources;
    }
  } catch {
    /* fall through */
  }
  return DISCOVERY_SOURCES;
}

export async function checkDiscovery() {
  try {
    const res = await fetch('/health');
    if (!res.ok) return { ok: false, discover: false, jobFetch: false, reason: `health ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      discover: !!data.discover,
      jobFetch: !!data.jobFetch,
      sources: data.sources || [],
      reason: data.discover ? 'ready' : 'old server — restart ./start.sh',
    };
  } catch (e) {
    return { ok: false, discover: false, jobFetch: false, reason: e.message || 'offline' };
  }
}

/**
 * Score + upsert a normalized stub.
 */
async function upsertScored(raw, profile, resumeBody, knownDomains) {
  const url = normalizeJobUrl(raw.url || '');
  const existing =
    (url && (await findJobByUrl(url))) ||
    (raw.externalId
      ? await findJobByExternal(raw.source || 'import', raw.externalId)
      : null);

  const domains = raw.domains?.length ? raw.domains : inferDomains(raw, knownDomains);
  const { score, breakdown, domains: d2 } = scoreJob(
    { ...raw, domains, url },
    profile,
    resumeBody || ''
  );
  const record = await putJob({
    ...(existing || {}),
    ...raw,
    url,
    id: existing?.id,
    domains: d2,
    score,
    scoreBreakdown: breakdown,
    dismissed: existing?.dismissed || false,
    fetchedAt: existing?.fetchedAt || Date.now(),
  });
  return { record, isNew: !existing };
}

/**
 * Discover from multiple boards via local server.
 */
export async function discoverJobs(
  { sources, search = '', limit = 40 },
  profile,
  resumeBody,
  knownDomains,
  onProgress
) {
  const res = await fetch('/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources, search, limit }),
  });
  if (!res.ok) throw new Error(`Discover failed (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Discover failed');

  const stubs = data.jobs || [];
  let added = 0;
  let updated = 0;
  const jobs = [];

  for (let i = 0; i < stubs.length; i++) {
    const j = stubs[i];
    const raw = normalizeManual({
      source: j.source || 'discover',
      externalId: j.externalId || j.url || '',
      title: j.title || '',
      company: j.company || '',
      url: j.url || '',
      description: j.description || '',
      salaryText: j.salaryText || '',
      category: j.category || '',
      tags: j.tags || [],
      remote: j.remote !== false,
    });
    if (!raw.title && !raw.url) continue;
    if (!raw.title) raw.title = 'Untitled role';
    const { record, isNew } = await upsertScored(raw, profile, resumeBody, knownDomains);
    if (isNew) added++;
    else updated++;
    jobs.push(record);
    if (onProgress) onProgress(i + 1, stubs.length, record, data);
  }

  return {
    added,
    updated,
    total: stubs.length,
    jobs,
    counts: data.counts || {},
    errors: data.errors || {},
    search: data.search || search,
  };
}

/**
 * Paste links with batch API when available (faster).
 */
export async function importJobLinksRobust(
  rawText,
  profile,
  resumeBody,
  knownDomains,
  onProgress
) {
  const items = parseJobLinks(rawText);
  if (!items.length) {
    return { added: 0, updated: 0, failed: 0, total: 0, jobs: [] };
  }

  // Try batch endpoint
  let results = null;
  try {
    const res = await fetch('/api/job-fetch-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: items.map((i) => i.url) }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.results)) results = data.results;
    }
  } catch {
    results = null;
  }

  let added = 0;
  let updated = 0;
  let failed = 0;
  const jobs = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let stub;
    if (results && results[i]) {
      const data = results[i];
      if (data.ok) {
        stub = normalizeManual({
          source: data.source || 'link',
          externalId: data.externalId || item.url,
          title: item.titleHint || data.title || 'Untitled',
          company: item.companyHint || data.company || '',
          url: item.url,
          description: data.description || '',
          tags: data.tags || ['from-link'],
          category: data.category || '',
          salaryText: data.salaryText || '',
        });
      } else {
        failed++;
        stub = await fetchJobFromLink(item.url, item);
      }
    } else {
      stub = await fetchJobFromLink(item.url, item);
      if (stub.fetchError) failed++;
    }

    const { record, isNew } = await upsertScored(stub, profile, resumeBody, knownDomains);
    if (isNew) added++;
    else updated++;
    jobs.push(record);
    if (onProgress) onProgress(i + 1, items.length, record);
  }

  return { added, updated, failed, total: items.length, jobs };
}

/**
 * Build default search string from profile (skills + keywords).
 */
export function defaultSearchFromProfile(profile) {
  const skills = (profile?.skills || []).slice(0, 4);
  const kws = (profile?.experienceKeywords || []).slice(0, 3);
  const parts = [...skills, ...kws].map((s) => String(s).trim()).filter(Boolean);
  // Prefer short focused query
  return parts.slice(0, 3).join(' ');
}
