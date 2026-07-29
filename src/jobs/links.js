/**
 * Paste-links job discovery — extract URLs, fetch via local Bootstraps server, score & store.
 */

import { findJobByExternal, findJobByUrl, putJob } from '../storage/db.js';
import { inferDomains, scoreJob } from './match.js';
import { normalizeManual } from './sources.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Normalize a URL for dedupe (strip tracking params, trailing slash).
 */
export function normalizeJobUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    // drop common trackers
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k) || k.toLowerCase().startsWith('utm_')) {
        u.searchParams.delete(k);
      }
    }
    let out = u.toString();
    if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return String(url || '').trim().replace(/[),.]+$/, '');
  }
}

/**
 * Parse free text into link items.
 * Supports:
 *  - bare URLs (one per line or mixed)
 *  - "Title | URL" or "Title - URL"
 *  - "Title · Company · URL"
 *  - markdown [Title](url)
 *
 * @returns {{ url: string, titleHint?: string, companyHint?: string }[]}
 */
export function parseJobLinks(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const items = [];
  const seen = new Set();

  // Markdown links first
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
  let m;
  while ((m = mdRe.exec(text)) !== null) {
    const url = normalizeJobUrl(m[2]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({ url, titleHint: m[1].trim() });
  }

  const lines = text.split(/\n/);
  for (const line of lines) {
    const L = line.trim();
    if (!L) continue;

    const urls = L.match(URL_RE) || [];
    if (!urls.length) continue;

    for (const rawUrl of urls) {
      const url = normalizeJobUrl(rawUrl.replace(/[),.]+$/, ''));
      if (!url || seen.has(url)) continue;
      seen.add(url);

      // Text before URL as title / company hints
      let prefix = L.slice(0, L.indexOf(rawUrl)).trim();
      prefix = prefix.replace(/[-–—|·•,:]+$/, '').trim();
      let titleHint = '';
      let companyHint = '';
      if (prefix) {
        const parts = prefix.split(/\s*[|·•]\s*|\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          titleHint = parts[0];
          companyHint = parts[1];
        } else {
          titleHint = parts[0] || prefix;
        }
      }
      items.push({ url, titleHint, companyHint });
    }
  }

  // Catch remaining URLs not on their own line structure
  const all = text.match(URL_RE) || [];
  for (const rawUrl of all) {
    const url = normalizeJobUrl(rawUrl.replace(/[),.]+$/, ''));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({ url });
  }

  return items;
}

/**
 * Client-side guess when fetch is unavailable.
 */
export function stubFromUrl(url, hints = {}) {
  let title = hints.titleHint || '';
  let company = hints.companyHint || '';
  try {
    const u = new URL(url);
    const host = (u.hostname || '').replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    if (!company) {
      if (host.includes('lever.co') && path[0]) company = path[0].replace(/-/g, ' ');
      else if (host.includes('greenhouse') && path[0]) company = path[0].replace(/-/g, ' ');
      else if (host.includes('ashbyhq') && path[0]) company = path[0].replace(/-/g, ' ');
      else company = host.split('.')[0] || '';
      company = company.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    if (!title && path.length) {
      const slug = path[path.length - 1];
      if (slug && !/^\d+$/.test(slug) && slug.length > 2) {
        title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
  } catch {
    /* */
  }
  if (!title) title = 'Role from link';
  return normalizeManual({
    source: 'link',
    externalId: normalizeJobUrl(url),
    title,
    company,
    url: normalizeJobUrl(url),
    description:
      hints.note ||
      `Imported from link (page not fetched). Paste JD into Prepare or re-import with server running.\n\n${url}`,
  });
}

/**
 * Fetch one job page via local Bootstraps server.
 * @returns {Promise<object>} normalizeManual-shaped stub + fetch meta
 */
export async function fetchJobFromLink(url, hints = {}) {
  const clean = normalizeJobUrl(url);
  const endpoint = `/api/job-fetch`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: clean }),
    });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const data = await res.json();
    if (!data.ok) {
      const stub = stubFromUrl(clean, hints);
      stub.description =
        `(Could not load page: ${data.error || 'unknown'})\n\n` + stub.description;
      stub.fetchError = data.error || 'failed';
      return stub;
    }
    return normalizeManual({
      source: data.source || 'link',
      externalId: data.externalId || clean,
      title: hints.titleHint || data.title || 'Untitled',
      company: hints.companyHint || data.company || '',
      url: clean,
      description: data.description || '',
      tags: ['from-link'],
    });
  } catch (err) {
    // No job-fetch API (plain http.server) or network error
    const stub = stubFromUrl(clean, hints);
    stub.fetchError = err.message || String(err);
    stub.description =
      `(Local job-fetch unavailable — run ./start.sh with Bootstraps server, not plain http.server.)\n\n` +
      stub.description;
    return stub;
  }
}

/**
 * Import many links: fetch → score → upsert.
 * @param {string} rawText
 * @param {(done: number, total: number, item: object) => void} [onProgress]
 */
export async function importJobLinks(rawText, profile, resumeBody, knownDomains, onProgress) {
  const items = parseJobLinks(rawText);
  let added = 0;
  let updated = 0;
  let failed = 0;
  const jobs = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let stub;
    try {
      stub = await fetchJobFromLink(item.url, item);
      if (stub.fetchError) failed++;
    } catch {
      stub = stubFromUrl(item.url, item);
      failed++;
    }

    const existing =
      (await findJobByUrl(stub.url)) ||
      (stub.externalId
        ? await findJobByExternal(stub.source || 'link', stub.externalId)
        : null);

    const domains = stub.domains?.length ? stub.domains : inferDomains(stub, knownDomains);
    const { score, breakdown, domains: d2 } = scoreJob(
      { ...stub, domains },
      profile,
      resumeBody || ''
    );

    const record = await putJob({
      ...(existing || {}),
      ...stub,
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
    if (onProgress) onProgress(i + 1, items.length, record);
  }

  return {
    added,
    updated,
    failed,
    total: items.length,
    jobs,
  };
}

/**
 * Probe whether /api/job-fetch is available.
 */
export async function checkJobFetch() {
  try {
    const res = await fetch('/health', { method: 'GET' });
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    const data = await res.json();
    return { ok: !!data.jobFetch, reason: data.jobFetch ? 'ready' : 'old server' };
  } catch (e) {
    return { ok: false, reason: e.message || 'offline' };
  }
}
