/**
 * Job board filters + application follow-up helpers.
 */

/**
 * Deal-breaker substrings hit in a job blob.
 */
export function dealBreakerHits(job, profile) {
  const blob = `${job.title || ''} ${job.description || ''} ${job.salaryText || ''}`.toLowerCase();
  const hits = [];
  for (const db of profile?.dealBreakers || []) {
    const k = String(db).toLowerCase().trim();
    if (k && blob.includes(k)) hits.push(db);
  }
  return hits;
}

/**
 * Patterns that suggest English is required or is a working language.
 * Covers EN + HU phrasing common on Hungarian boards (Profession, Telekom, SSC).
 */
const ENGLISH_REQUIRED_RES = [
  /\benglish\s+(language\s+)?(required|mandatory|must|needed|necessary|preferred|advantage)\b/i,
  /\b(required|mandatory|must|need)\b[^.!?\n]{0,40}\benglish\b/i,
  /\bfluent\s+(in\s+)?english\b/i,
  /\benglish\s+fluency\b/i,
  /\b(working|business|company|official)\s+language\s*[:=]?\s*english\b/i,
  /\blanguage\s*[:=]\s*english\b/i,
  /\benglish\s*\(?\s*(b1|b2|c1|c2)\s*\)?/i,
  /\b(b1|b2|c1|c2)\b[^.!?\n]{0,24}\benglish\b/i,
  /\benglish\b[^.!?\n]{0,24}\b(b1|b2|c1|c2)\b/i,
  /\bproficien[ct]y\s+in\s+english\b/i,
  /\benglish\s+speaker\b/i,
  /\bspoken\s+(and\s+)?written\s+english\b/i,
  // Hungarian
  /\bangol\s+nyelv(tud[aá]s|ismeret|ismeretek)?\b/i,
  /\bangol\s+tud[aá]s\b/i,
  /\bangolul\s+(besz[eé]l|t[aá]rgyal|kommunik[aá])/i,
  /\bt[aá]rgyal[oó]k[eé]pes\s+angol\b/i,
  /\bfoly[eé]kony\s+angol\b/i,
  /\bangol\s+(k[oö]telez[oő]|sz[uü]ks[eé]ges|elv[aá]r[aá]s)\b/i,
  /\b(k[oö]telez[oő]|sz[uü]ks[eé]ges|elv[aá]rt)\b[^.!?\n]{0,30}\bangol\b/i,
  /\bangol\s+nyelven\b/i,
  /\bmunkanyelv\s*[:=]?\s*angol\b/i,
  /\bangol\s*\(?\s*(b1|b2|c1|c2)\s*\)?/i,
];

/**
 * True when the JD/title likely requires (or heavily prefers) English.
 * Also treats mostly-English titles on HU boards as a soft signal when paired
 * with common EN job-word vocabulary (engineer, analyst, manager…).
 *
 * @param {object} job
 * @returns {boolean}
 */
export function requiresEnglish(job) {
  if (!job) return false;
  const title = String(job.title || '');
  const desc = String(job.description || '');
  const tags = Array.isArray(job.tags) ? job.tags.join(' ') : String(job.tags || '');
  const blob = `${title}\n${desc}\n${tags}`;
  if (!blob.trim()) return false;
  for (const re of ENGLISH_REQUIRED_RES) {
    if (re.test(blob)) return true;
  }
  // Soft: English job title on a HU source (no Hungarian accents in title, EN role words)
  const src = String(job.source || '').toLowerCase();
  const huSources = new Set(['profession', 'telekom', 'blackrock']);
  if (huSources.has(src)) {
    const t = title.trim();
    const hasHuChars = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(t);
    const enRole =
      /\b(engineer|developer|analyst|manager|specialist|consultant|architect|scientist|designer|lead|officer|director|coordinator)\b/i.test(
        t
      );
    if (t && !hasHuChars && enRole && /\benglish\b/i.test(desc)) return true;
    // Detail pages that are written primarily in English (Telekom often does this)
    if (t && !hasHuChars && enRole) {
      const sample = desc.slice(0, 1200);
      const enWords = (sample.match(/\b(the|and|with|you|your|experience|team|work|skills|required|responsibilities)\b/gi) || [])
        .length;
      const huWords = (sample.match(/\b(és|hogy|valamint|tapasztalat|feladat|elvárás|jelentkez|munkavégzés)\b/gi) || [])
        .length;
      if (enWords >= 6 && enWords > huWords * 2) return true;
    }
  }
  return false;
}

/**
 * Filter jobs for board / digest / shortlist.
 * @param {object[]} jobs
 * @param {{ minScore?: number, shortlistedOnly?: boolean, hideDealBreakers?: boolean, hideApplied?: boolean, appliedIds?: Set<string>, profile?: object, q?: string, requireEnglish?: boolean }} opts
 */
export function filterJobs(jobs, opts = {}) {
  const minScore = opts.minScore ?? 0;
  const applied = opts.appliedIds || new Set();
  let list = (jobs || []).filter((j) => !j.dismissed);
  if (opts.shortlistedOnly) list = list.filter((j) => j.shortlisted);
  // hardScoreFilter: apply min even when caller passed minScore 0 for "all"
  const floor =
    opts.hardScoreFilter && opts.scoreFloor != null
      ? Number(opts.scoreFloor)
      : minScore;
  if (floor > 0) list = list.filter((j) => (j.score || 0) >= floor);
  if (opts.hideDealBreakers && opts.profile) {
    list = list.filter((j) => dealBreakerHits(j, opts.profile).length === 0);
  }
  if (opts.hideApplied) list = list.filter((j) => !applied.has(j.id));
  if (opts.requireEnglish) list = list.filter((j) => requiresEnglish(j));
  if (opts.q) {
    const q = opts.q.toLowerCase();
    list = list.filter(
      (j) =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.company || '').toLowerCase().includes(q) ||
        (j.source || '').toLowerCase().includes(q)
    );
  }
  return list.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/** Applications with nextTouchAt in the past (or today start). */
export function overdueApplications(apps, now = Date.now()) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  return (apps || [])
    .filter((a) => {
      if (!a.nextTouchAt) return false;
      if (['Offer', 'Withdrawn', 'Rejected'].includes(a.status)) return false;
      return a.nextTouchAt <= now || a.nextTouchAt <= t0 + 86400000 - 1;
    })
    .sort((a, b) => (a.nextTouchAt || 0) - (b.nextTouchAt || 0));
}

export function dueThisWeek(apps, now = Date.now()) {
  const end = now + 7 * 86400000;
  return (apps || [])
    .filter((a) => a.nextTouchAt && a.nextTouchAt >= now && a.nextTouchAt <= end)
    .sort((a, b) => (a.nextTouchAt || 0) - (b.nextTouchAt || 0));
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function daysFromNow(n) {
  return startOfDay(Date.now()) + n * 86400000;
}

export function formatTouchDate(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}
