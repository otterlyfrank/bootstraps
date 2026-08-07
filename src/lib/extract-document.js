/**
 * Local document text extraction for resume upload (PDF / DOCX / plain text).
 * No build step — loads pdf.js / mammoth from CDN on demand.
 */

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';

/** @type {any} */
let pdfjsLib = null;
/** @type {any} */
let mammothLib = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(/* @vite-ignore */ PDFJS_CDN);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return pdfjsLib;
}

async function loadMammoth() {
  if (mammothLib) return mammothLib;
  if (globalThis.mammoth) {
    mammothLib = globalThis.mammoth;
    return mammothLib;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MAMMOTH_CDN;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load DOCX parser (mammoth)'));
    document.head.appendChild(s);
  });
  mammothLib = globalThis.mammoth;
  if (!mammothLib) throw new Error('DOCX parser unavailable');
  return mammothLib;
}

/**
 * Rebuild page text with reading order, section gaps, and bullet spacing cues.
 * pdf.js items lose "paragraph" structure; we re-derive it from geometry.
 */
function rebuildReadingOrder(content) {
  const items = content.items || [];
  if (!items.length) return '';

  // Group by approximate Y (pdf coords: higher y is higher on page)
  /** @type {{ y: number, parts: { x: number, str: string, w: number }[] }[]} */
  const lines = [];
  let current = null;
  for (const it of items) {
    const str = it.str || '';
    if (!str) continue;
    const x = it.transform?.[4] ?? 0;
    const y = Math.round((it.transform?.[5] ?? 0) * 2) / 2;
    // Horizontal advance when present — used to decide join vs space between runs
    const w = typeof it.width === 'number' ? it.width : Math.max(0, str.length * 4);
    if (!current || Math.abs(current.y - y) > 2.8) {
      current = { y, parts: [] };
      lines.push(current);
    }
    current.parts.push({ x, str, w });
  }
  lines.sort((a, b) => b.y - a.y);

  /** @type {{ y: number, text: string, x0: number }[]} */
  const built = lines.map((line) => {
    const parts = line.parts.slice().sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const p of parts) {
      const s = p.str;
      if (!text) {
        text = s;
        prevEnd = p.x + (p.w || 0);
        continue;
      }
      const gap = p.x - (prevEnd ?? p.x);
      // Tiny/negative gap → same word (kerning); modest gap → space; large → column gap
      if (gap < 1.2) text += s.replace(/^\s+/, '');
      else if (gap > 28) text += '  |  ' + s.trim(); // multi-column / date on right
      else text += (text.endsWith(' ') || s.startsWith(' ') ? '' : ' ') + s;
      prevEnd = p.x + (p.w || 0);
    }
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+\|\s+/g, ' | ').trim();
    // Normalize bullet glyphs that arrive as lone runs
    text = text.replace(/^([•●○◦▪▫·∙])\s*/, '• ');
    const x0 = parts[0]?.x ?? 0;
    return { y: line.y, text, x0 };
  }).filter((l) => l.text);

  if (!built.length) return '';

  // Median line spacing → blank line when gap is clearly a paragraph/section break
  const gaps = [];
  for (let i = 1; i < built.length; i++) {
    gaps.push(Math.abs(built[i - 1].y - built[i].y));
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;
  const paraBreak = Math.max(medianGap * 1.65, medianGap + 6);

  const out = [];
  for (let i = 0; i < built.length; i++) {
    if (i > 0) {
      const dy = Math.abs(built[i - 1].y - built[i].y);
      if (dy >= paraBreak) out.push('');
    }
    // Indented lines under a job often are bullets without glyphs — prefix carefully
    let t = built[i].text;
    const prev = out.length ? out[out.length - 1] : '';
    const prevT = (prev || '').trim();
    const indented =
      i > 0 &&
      built[i].x0 - built[i - 1].x0 > 12 &&
      !/^[•\-\*\d]/.test(t) &&
      prevT &&
      !/^(summary|skills|experience|education|projects)\b/i.test(prevT);
    if (indented && t.length > 12 && !/^\d{4}/.test(t) && !/@/.test(t)) {
      // Only auto-bullet if previous looks like a role header or another bullet
      if (/^[-•]/.test(prevT) || /\(\s*\d{4}|\d{4}\s*[-–—]/.test(prevT) || /present/i.test(prevT)) {
        t = `• ${t}`;
      }
    }
    out.push(t);
  }
  return out.join('\n');
}

/**
 * Extract text from PDF ArrayBuffer via pdf.js.
 */
export async function extractPdfText(arrayBuffer, { onProgress } = {}) {
  const { normalizeExtractedResume } = await import('./resume-format.js');
  const pdfjs = await loadPdfJs();
  const data = arrayBuffer instanceof ArrayBuffer ? new Uint8Array(arrayBuffer) : arrayBuffer;
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.({
      stage: 'pdf',
      message: `Reading PDF page ${i}/${pdf.numPages}…`,
      percent: Math.round(((i - 1) / pdf.numPages) * 100),
    });
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(rebuildReadingOrder(content));
  }
  onProgress?.({ stage: 'pdf', message: 'PDF text extracted', percent: 100 });
  // Join pages with a section-sized gap, then normalize bullets / headings / blanks
  return normalizeExtractedResume(parts.filter(Boolean).join('\n\n'));
}

/**
 * Extract text from DOCX ArrayBuffer via mammoth.
 */
export async function extractDocxText(arrayBuffer, { onProgress } = {}) {
  const { normalizeExtractedResume } = await import('./resume-format.js');
  onProgress?.({ stage: 'docx', message: 'Reading Word document…', percent: 20 });
  const mammoth = await loadMammoth();
  const result = await mammoth.extractRawText({ arrayBuffer });
  onProgress?.({ stage: 'docx', message: 'Word document extracted', percent: 100 });
  return normalizeExtractedResume(String(result.value || ''));
}

/**
 * @param {File} file
 * @returns {Promise<{ text: string, kind: string, fileName: string, chars: number }>}
 */
export async function extractResumeFile(file, { onProgress } = {}) {
  if (!file) throw new Error('No file selected');
  const name = file.name || 'resume';
  const lower = name.toLowerCase();
  const buf = await file.arrayBuffer();

  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    let text = await extractPdfText(buf, { onProgress });
    // Scanned PDF fallback: try server OCR-less pypdf if empty
    if (!text || text.length < 40) {
      onProgress?.({ stage: 'pdf', message: 'Little text found — trying local server extract…', percent: 50 });
      const serverText = await extractViaServer(file).catch(() => '');
      if (serverText && serverText.length > text.length) text = serverText;
    }
    if (!text || text.length < 40) {
      throw new Error(
        'Could not extract enough text from this PDF (may be a scan/image). Try exporting as text PDF, or paste the resume as plain text.'
      );
    }
    return { text, kind: 'pdf', fileName: name, chars: text.length };
  }

  if (
    lower.endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const text = await extractDocxText(buf, { onProgress });
    if (!text || text.length < 40) throw new Error('DOCX extracted almost no text.');
    return { text, kind: 'docx', fileName: name, chars: text.length };
  }

  if (lower.endsWith('.doc')) {
    throw new Error('Legacy .doc is not supported. Save as .docx or PDF, or paste text.');
  }

  // .txt / .md / unknown text
  const { normalizeExtractedResume } = await import('./resume-format.js');
  onProgress?.({ stage: 'text', message: 'Reading text file…', percent: 50 });
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf).trim();
  if (!raw) throw new Error('File is empty.');
  const text = normalizeExtractedResume(raw);
  onProgress?.({ stage: 'text', message: 'Done', percent: 100 });
  return { text, kind: 'text', fileName: name, chars: text.length };
}

/**
 * Optional server-side PDF extract (pypdf if installed).
 */
async function extractViaServer(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/extract-resume', { method: 'POST', body: fd });
  if (!res.ok) return '';
  const data = await res.json();
  return data.ok ? String(data.text || '') : '';
}
