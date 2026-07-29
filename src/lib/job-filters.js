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
 * Filter jobs for board / digest / shortlist.
 * @param {object[]} jobs
 * @param {{ minScore?: number, shortlistedOnly?: boolean, hideDealBreakers?: boolean, hideApplied?: boolean, appliedIds?: Set<string>, profile?: object, q?: string }} opts
 */
export function filterJobs(jobs, opts = {}) {
  const minScore = opts.minScore ?? 0;
  const applied = opts.appliedIds || new Set();
  let list = (jobs || []).filter((j) => !j.dismissed);
  if (opts.shortlistedOnly) list = list.filter((j) => j.shortlisted);
  if (minScore > 0) list = list.filter((j) => (j.score || 0) >= minScore);
  if (opts.hideDealBreakers && opts.profile) {
    list = list.filter((j) => dealBreakerHits(j, opts.profile).length === 0);
  }
  if (opts.hideApplied) list = list.filter((j) => !applied.has(j.id));
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
