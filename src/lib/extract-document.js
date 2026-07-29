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

function rebuildReadingOrder(content) {
  const items = content.items || [];
  if (!items.length) return '';
  // Group by approximate Y (pdf coords: higher y is higher on page)
  const lines = [];
  /** @type {{ y: number, parts: { x: number, str: string }[] }[]} */
  let current = null;
  for (const it of items) {
    const str = it.str || '';
    if (!str) continue;
    const x = it.transform?.[4] ?? 0;
    const y = Math.round((it.transform?.[5] ?? 0) * 2) / 2;
    if (!current || Math.abs(current.y - y) > 2.5) {
      current = { y, parts: [] };
      lines.push(current);
    }
    current.parts.push({ x, str });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines
    .map((line) =>
      line.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract text from PDF ArrayBuffer via pdf.js.
 */
export async function extractPdfText(arrayBuffer, { onProgress } = {}) {
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
  return parts.join('\n\n').trim();
}

/**
 * Extract text from DOCX ArrayBuffer via mammoth.
 */
export async function extractDocxText(arrayBuffer, { onProgress } = {}) {
  onProgress?.({ stage: 'docx', message: 'Reading Word document…', percent: 20 });
  const mammoth = await loadMammoth();
  const result = await mammoth.extractRawText({ arrayBuffer });
  onProgress?.({ stage: 'docx', message: 'Word document extracted', percent: 100 });
  return String(result.value || '').trim();
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
  onProgress?.({ stage: 'text', message: 'Reading text file…', percent: 50 });
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).trim();
  if (!text) throw new Error('File is empty.');
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
