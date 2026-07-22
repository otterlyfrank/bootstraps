/**
 * Rejection density detection & domain performance.
 */

/**
 * @param {object[]} applications
 * @param {{ minApplications: number, minRejections: number, maxInterviewsToFlag: number, windowDays: number }} thresholds
 * @returns {{ domain: string, apps: number, rejected: number, ghosted: number, interviews: number, offers: number, rate: number, flagged: boolean, reason: string }[]}
 */
export function domainPerformance(applications, thresholds) {
  const now = Date.now();
  const windowMs = (thresholds.windowDays || 0) > 0 ? thresholds.windowDays * 86400000 : 0;
  const filtered = windowMs
    ? applications.filter((a) => (a.appliedAt || 0) >= now - windowMs)
    : applications;

  /** @type {Map<string, object>} */
  const map = new Map();
  for (const a of filtered) {
    const d = a.domain || 'Other';
    if (!map.has(d)) {
      map.set(d, {
        domain: d,
        apps: 0,
        rejected: 0,
        ghosted: 0,
        interviews: 0,
        offers: 0,
        applied: 0,
      });
    }
    const row = map.get(d);
    row.apps += 1;
    const s = a.status || 'Applied';
    if (s === 'Rejected') row.rejected += 1;
    else if (s === 'Ghosted') row.ghosted += 1;
    else if (s === 'Interview') row.interviews += 1;
    else if (s === 'Offer') row.offers += 1;
    else if (s === 'Applied') row.applied += 1;
  }

  const minApps = thresholds.minApplications ?? 3;
  const minRej = thresholds.minRejections ?? 3;
  const maxInt = thresholds.maxInterviewsToFlag ?? 0;

  return [...map.values()]
    .map((row) => {
      const dead = row.rejected + row.ghosted;
      const rate = row.apps ? dead / row.apps : 0;
      const positive = row.interviews + row.offers;
      const flagged =
        row.apps >= minApps && dead >= minRej && positive <= maxInt;
      let reason = '';
      if (flagged) {
        reason = `${dead} rejections/ghosts across ${row.apps} apps with ${positive} interview(s) — review framing & keywords for ${row.domain}`;
      }
      return {
        ...row,
        dead,
        rate,
        flagged,
        reason,
      };
    })
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.rate - a.rate || b.apps - a.apps);
}

/**
 * Applications for a domain (optionally windowed).
 */
export function appsForDomain(applications, domain, windowDays = 0) {
  const now = Date.now();
  const windowMs = windowDays > 0 ? windowDays * 86400000 : 0;
  return applications.filter((a) => {
    if ((a.domain || 'Other') !== domain) return false;
    if (!windowMs) return true;
    return (a.appliedAt || 0) >= now - windowMs;
  });
}
