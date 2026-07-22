export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
      a.notes || '_No notes_',
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
