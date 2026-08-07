export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

/**
 * Trigger a browser download for any Blob / File.
 * @param {string} filename
 * @param {Blob} blob
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function downloadJson(filename, obj) {
  downloadText(filename.endsWith('.json') ? filename : `${filename}.json`, JSON.stringify(obj, null, 2), 'application/json');
}

export function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

export function applicationsToMarkdown(apps) {
  const lines = ['# Application history', '', `_Exported ${new Date().toISOString()}_`, ''];
  for (const a of apps) {
    lines.push(
      `## ${a.title} — ${a.company}`,
      `- Status: **${a.status}**`,
      `- Domain: ${a.domain}`,
      `- Applied: ${formatDate(a.appliedAt)}`,
      `- URL: ${a.url || '—'}`,
      '',
      '### Notes',
      '',
      a.notes || '_No notes_',
      '',
      '### Job description',
      '',
      a.jobDescription || '_No JD stored_',
      '',
      '---',
      ''
    );
  }
  return lines.join('\n');
}

export function resumesToMarkdown(master, working) {
  return `# Resumes

## Master Resume
${master?.body || '_empty_'}

---

## Working Resume
${working?.body || '_empty_'}
`;
}
