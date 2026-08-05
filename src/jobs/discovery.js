/**
 * Multi-source job discovery — board feeds + paste-links orchestration.
 */

import { findJobByExternal, findJobByUrl, putJob } from '../storage/db.js';
import { inferDomains, scoreJob } from './match.js';
import { normalizeManual } from './sources.js';
import { parseJobLinks, fetchJobFromLink, normalizeJobUrl } from './links.js';

/**
 * Built-in catalog fallback (mirrors server; used if /api/sources fails).
 * Public APIs default on; research boards (workew / rwfa / solana) default off.
 * Custom uploaded sources only come from the server.
 */
export const DISCOVERY_SOURCES = [
  { id: 'remotive', name: 'Remotive', blurb: 'Curated remote roles', default: true, tier: 'public' },
  { id: 'remoteok', name: 'Remote OK', blurb: 'Large remote feed', default: true, tier: 'public' },
  { id: 'arbeitnow', name: 'Arbeitnow', blurb: 'EU + remote board', default: true, tier: 'public' },
  { id: 'jobicy', name: 'Jobicy', blurb: 'Remote jobs API', default: true, tier: 'public' },
  { id: 'himalayas', name: 'Himalayas', blurb: 'Remote-first (best-effort)', default: false, tier: 'public' },
  {
    id: 'workew',
    name: 'Workew',
    blurb: 'Research: remote board via public RSS',
    default: false,
    tier: 'research',
  },
  {
    id: 'rwfa',
    name: 'Real Work From Anywhere',
    blurb: 'Research: worldwide remote via sitemap + JSON-LD',
    default: false,
    tier: 'research',
  },
  {
    id: 'solana',
    name: 'Solana Jobs',
    blurb: 'Research: Solana ecosystem (Getro) — many crypto roles',
    default: false,
    tier: 'research',
  },
  {
    id: 'blackrock',
    name: 'BlackRock (Budapest)',
    blurb: 'Research: BlackRock TalentBrew · Budapest location facet',
    default: false,
    tier: 'research',
  },
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

/** Load user-uploaded custom scrape sources (+ example template). */
export async function loadCustomSources() {
  const res = await fetch('/api/custom-sources');
  if (!res.ok) throw new Error(`Custom sources failed (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Custom sources failed');
  return data;
}

/**
 * Replace custom scrape sources (local data/custom_sources.json).
 * @param {object[]} sources
 */
export async function saveCustomSources(sources) {
  const res = await fetch('/api/custom-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources }),
  });
  if (!res.ok) throw new Error(`Save custom sources failed (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Save failed');
  return data;
}

export async function clearCustomSources() {
  const res = await fetch('/api/custom-sources/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Clear custom sources failed (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Clear failed');
  return data;
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

/** Collapse near-duplicate titles at same company. */
function dedupeJobs(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const key = `${(j.company || '').toLowerCase().trim()}|${(j.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

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
 * @param {{ sources?: string[], search?: string, queries?: string[], limit?: number, minScore?: number }} opts
 */
export async function discoverJobs(
  { sources, search = '', queries = null, limit = 40, minScore = 0 },
  profile,
  resumeBody,
  knownDomains,
  onProgress
) {
  const res = await fetch('/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources, search, queries, limit }),
  });
  if (!res.ok) throw new Error(`Discover failed (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Discover failed');

  const stubs = dedupeJobs(data.jobs || []);
  let added = 0;
  let updated = 0;
  let belowFloor = 0;
  const jobs = [];

  // Boards returned — let UI paint per-source counts before scoring
  if (onProgress) {
    onProgress(0, stubs.length, null, {
      phase: 'boards',
      counts: data.counts || {},
      errors: data.errors || {},
      queries: data.queries || queries || [],
    });
  }

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
    if (minScore > 0 && (record.score || 0) < minScore) {
      belowFloor++;
      // still stored so user can lower floor later; just track
    }
    if (isNew) added++;
    else updated++;
    jobs.push(record);
    if (onProgress) onProgress(i + 1, stubs.length, record, data);
  }

  // Sort by score; optional filter for return set
  jobs.sort((a, b) => (b.score || 0) - (a.score || 0));
  const kept = minScore > 0 ? jobs.filter((j) => (j.score || 0) >= minScore) : jobs;

  return {
    added,
    updated,
    total: stubs.length,
    jobs: kept,
    allScored: jobs,
    belowFloor,
    minScore,
    counts: data.counts || {},
    errors: data.errors || {},
    search: data.search || search,
    queries: data.queries || queries || [],
    queryHits: data.queryHits || {},
  };
}

/**
 * Build a multi-query hunt plan from profile + resume text.
 * Public boards are not LinkedIn — we fan out titles/skills across APIs we can hit.
 */
export function buildHuntPlan(profile, resumeBody = '') {
  const p = profile || {};
  const resume = String(resumeBody || '');
  const queries = [];
  const seen = new Set();

  const add = (q) => {
    const s = String(q || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length < 3 || s.length > 80) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(s);
  };

  // 1) Preferred domains as soft profession queries
  for (const d of p.preferredDomains || []) {
    add(String(d).replace(/\//g, ' '));
  }

  // 2) Top skills (1–2 word tools make good board filters)
  for (const sk of (p.skills || []).slice(0, 8)) {
    add(sk);
  }

  // 3) Experience keywords / role themes
  for (const k of (p.experienceKeywords || []).slice(0, 6)) {
    add(k);
  }

  // 4) Title-like lines from resume (first 40 lines)
  const titleHints =
    /\b(analyst|engineer|developer|researcher|strategist|manager|director|designer|scientist|consultant|specialist|writer|editor|coordinator|lead|officer|architect|product|growth|data|marketing|operations|founder|associate)\b/i;
  const lines = resume.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
  for (const line of lines) {
    if (line.length < 6 || line.length > 60) continue;
    if (/^(email|phone|http|www\.|linkedin|github|education|experience|skills)/i.test(line)) continue;
    if (titleHints.test(line) || /^[A-Z][\w\s/&+-]{4,40}$/.test(line)) {
      // strip company pipes
      const clean = line.split(/[|@·•]/)[0].trim();
      if (titleHints.test(clean)) add(clean);
    }
  }

  // 5) Composite profession query from best signals
  const skillBits = (p.skills || []).slice(0, 2).join(' ');
  const domainBits = (p.preferredDomains || [])[0] || '';
  if (skillBits && domainBits) add(`${domainBits} ${skillBits}`);
  if (p.remoteOnly !== false) {
    // boards are already remote-heavy; don't force "remote" into every query
  }

  // Cap — server also caps
  const finalQueries = queries.slice(0, 6);
  if (!finalQueries.length) {
    finalQueries.push('remote');
  }

  return {
    queries: finalQueries,
    sources: DISCOVERY_SOURCES.filter((s) => s.default !== false).map((s) => s.id),
    minScore: 35,
    limit: 50,
    remoteOnly: p.remoteOnly !== false,
    summary: finalQueries.join(' · '),
  };
}

/**
 * Full automated hunt: plan → multi-query discover → score → keep above floor.
 */
export async function huntFromResume(
  profile,
  resumeBody,
  knownDomains,
  { sources, minScore, limit, onProgress, extraQueries } = {}
) {
  const plan = buildHuntPlan(profile, resumeBody);
  if (Array.isArray(extraQueries)) {
    for (const q of extraQueries) {
      if (q && !plan.queries.includes(q)) plan.queries.push(String(q).trim());
    }
    plan.queries = plan.queries.filter(Boolean).slice(0, 6);
  }
  if (sources?.length) plan.sources = sources;
  if (minScore != null) plan.minScore = minScore;
  if (limit != null) plan.limit = limit;

  onProgress?.(0, 1, null, { phase: 'plan', plan });

  const result = await discoverJobs(
    {
      sources: plan.sources,
      queries: plan.queries,
      search: plan.queries[0] || '',
      limit: plan.limit,
      minScore: plan.minScore,
    },
    profile,
    resumeBody,
    knownDomains,
    onProgress
  );

  return { ...result, plan };
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
  const plan = buildHuntPlan(profile, '');
  return plan.queries.slice(0, 3).join(' ');
}
