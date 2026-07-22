/**
 * Lightweight line-level diff for Master vs Working resume.
 * LCS-based; fine for resume-length text.
 */

/**
 * @param {string} aText
 * @param {string} bText
 * @returns {{ type: 'same'|'add'|'del', text: string }[]}
 */
export function lineDiff(aText, bText) {
  const a = String(aText || '').replace(/\r\n/g, '\n').split('\n');
  const b = String(bText || '').replace(/\r\n/g, '\n').split('\n');
  const n = a.length;
  const m = b.length;
  /** @type {number[][]} */
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  /** @type {{ type: 'same'|'add'|'del', text: string }[]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i++] });
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j++] });
  }
  return out;
}

export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
    else same++;
  }
  return { added, removed, same, changed: added + removed };
}
