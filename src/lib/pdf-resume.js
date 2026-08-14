/**
 * Zero-dependency ATS resume + cover letter → PDF (US Letter, selectable text).
 *
 * Design (still ATS-safe):
 * - Standard PDF fonts only (Helvetica / Helvetica-Bold) — parseable text
 * - Clear hierarchy: name → contact → section rules → body
 * - Thin hairline rules (vector, not images) under name block & section titles
 * - Comfortable margins / line-height; no tables or multi-column traps
 * - Cover letter: separate page(s), generous letter spacing, simple signature
 */

import { formatAtsPlainText, isJobHeaderLine, isSectionHeading } from './resume-format.js';
import { formatCoverLetter, resolveCoverSettings } from './cover-letter.js';

/** Visual system (points). Tuned for US Letter + ATS parsers. */
const DESIGN = {
  pageWidth: 612,
  pageHeight: 792,
  /** ~0.7" side margins */
  resumeMargin: 50,
  coverMargin: 72,
  nameSize: 20,
  headlineSize: 10.75,
  contactSize: 9.25,
  /** Section titles: clearly larger than body; paired with hairline rule */
  sectionSize: 12,
  jobSize: 11,
  bodySize: 10.25,
  bulletSize: 10.25,
  coverBodySize: 11,
  coverSigSize: 11.5,
  lineGapResume: 1.38,
  lineGapCover: 1.52,
  ruleGray: 0.22, // stroke gray (0=black)
  ruleWidth: 0.6,
  accentRuleWidth: 0.9,
};

/** @param {string} s @param {number} [max] */
export function slugFilenamePart(s, max = 40) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'role'
  );
}

/**
 * @param {{ company?: string, title?: string, baseName?: string, kind?: 'resume'|'cover'|'pack' }} meta
 */
export function atsPdfFilename(meta = {}) {
  if (meta.baseName) {
    const base = slugFilenamePart(meta.baseName, 60);
    return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  }
  const company = slugFilenamePart(meta.company || '', 28);
  const title = slugFilenamePart(meta.title || 'Resume', 32);
  const prefix =
    meta.kind === 'cover' ? 'Cover-Letter' : meta.kind === 'pack' ? 'Application' : 'Resume';
  if (company && company !== 'role') return `${prefix}-${company}-${title}.pdf`;
  return `${prefix}-${title}.pdf`;
}

/**
 * Fold text to PDF WinAnsi-safe (Helvetica).
 * @param {string} text
 */
export function foldForPdf(text) {
  let s = String(text ?? '');
  s = s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-')
    .replace(/\u00b7/g, '-')
    .replace(/[\u0150\u01D1]/g, 'O')
    .replace(/[\u0151\u01D2]/g, 'o')
    .replace(/[\u0170\u01D3]/g, 'U')
    .replace(/[\u0171\u01D4]/g, 'u');
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^\t\n\x20-\x7E\xA0-\xFF]/g, '?');
  return s;
}

function pdfEscapeChar(ch) {
  if (ch === '\\' || ch === '(' || ch === ')') return `\\${ch}`;
  return ch;
}

function pdfStringLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c || c === 0x28 || c === 0x29) out += pdfEscapeChar(s[i]);
    else if (c >= 0x20 && c <= 0x7e) out += s[i];
    else if (c >= 0xa0 && c <= 0xff) out += '\\' + c.toString(8).padStart(3, '0');
    else if (c === 0x09) out += ' ';
    else out += '?';
  }
  return `(${out})`;
}

/**
 * @param {string} s
 * @param {number} fontSize
 */
export function approxWidth(s, fontSize) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) w += 0.55;
    else if (c >= 65 && c <= 90) w += 0.66;
    else if (c === 32) w += 0.28;
    else if (c === 105 || c === 108 || c === 116 || c === 102 || c === 106 || c === 114) w += 0.3;
    else if (c === 109 || c === 119) w += 0.82;
    else w += 0.52;
  }
  return w * fontSize;
}

/**
 * @param {string} line
 * @param {number} fontSize
 * @param {number} maxWidth
 */
function wrapLine(line, fontSize, maxWidth) {
  if (!line) return [''];
  if (approxWidth(line, fontSize) <= maxWidth) return [line];
  const words = line.split(/(\s+)/);
  const lines = [];
  let cur = '';
  for (const part of words) {
    const trial = cur + part;
    if (cur && approxWidth(trial, fontSize) > maxWidth) {
      lines.push(cur.replace(/\s+$/, ''));
      cur = part.replace(/^\s+/, '');
      while (approxWidth(cur, fontSize) > maxWidth && cur.length > 1) {
        let lo = 1;
        let hi = cur.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (approxWidth(cur.slice(0, mid), fontSize) <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        lines.push(cur.slice(0, lo));
        cur = cur.slice(lo);
      }
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur.replace(/\s+$/, ''));
  return lines.length ? lines : [''];
}

const PDF_SECTION_RE =
  /^(summary|profile|professional summary|objective|highlights|career highlights|skills|technical skills|core competencies|core skills|experience|work experience|work history|professional experience|relevant experience|employment|employment history|education|projects|selected projects|certifications|certificates|awards|publications|languages|interests|volunteer|tools|technologies|tech stack|cover letter|cover note|accomplishments|key achievements)\b[\s:&]*$/i;

/**
 * @param {string} line
 * @param {{ isFirstContent?: boolean, headerZone?: boolean }} [ctx]
 */
function classifyResumeLine(line, ctx = {}) {
  const t = line.trim();
  if (!t) {
    return {
      kind: 'blank',
      text: '',
      size: DESIGN.bodySize,
      bold: false,
      gapBefore: 0,
      gapAfter: 4,
      indent: 0,
      hang: 0,
      align: 'left',
      ruleAfter: false,
    };
  }

  if (ctx.isFirstContent && t.length <= 60 && !t.includes('@') && !/^https?:/i.test(t)) {
    return {
      kind: 'name',
      text: t,
      size: DESIGN.nameSize,
      bold: true,
      gapBefore: 2,
      gapAfter: 5,
      indent: 0,
      hang: 0,
      align: 'center',
      ruleAfter: false,
    };
  }

  if (
    /^#{1,3}\s+\S/.test(t) ||
    PDF_SECTION_RE.test(t) ||
    isSectionHeading(t) ||
    (t.length <= 48 &&
      !t.endsWith('.') &&
      !t.includes('@') &&
      /^[A-Z][A-Z0-9\s/&\-.]+$/.test(t) &&
      /[A-Z]{3,}/.test(t))
  ) {
    const textLine = t.replace(/^#{1,3}\s+/, '');
    return {
      kind: 'heading',
      text: textLine.toUpperCase(),
      size: DESIGN.sectionSize,
      bold: true,
      gapBefore: 13,
      gapAfter: 6,
      indent: 0,
      hang: 0,
      align: 'left',
      ruleAfter: true,
    };
  }

  const digitCount = (t.match(/\d/g) || []).length;
  const looksPhone = digitCount >= 9 && /(\+?\d[\d\s().-]{7,}\d)/.test(t);
  const looksContact =
    /@/.test(t) ||
    looksPhone ||
    /linkedin\.com|github\.com|otterly\.global|portfolio|https?:/i.test(t);
  const sepNoDate =
    ((t.includes('·') || t.includes('|')) && t.length < 100 && !/\b((19|20)\d{2}|present)\b/i.test(t));
  if (looksContact || (ctx.headerZone && sepNoDate && !isJobHeaderLine(t))) {
    return {
      kind: looksContact ? 'contact' : 'headline',
      text: t,
      size: looksContact ? DESIGN.contactSize : DESIGN.headlineSize,
      bold: !looksContact,
      gapBefore: 0,
      gapAfter: looksContact ? 1.5 : 2.5,
      indent: 0,
      hang: 0,
      align: 'center',
      ruleAfter: false,
    };
  }

  if (ctx.headerZone && t.length <= 70 && !t.endsWith('.') && !isJobHeaderLine(t) && !/^[-*•]/.test(t)) {
    return {
      kind: 'headline',
      text: t,
      size: DESIGN.headlineSize,
      bold: true,
      gapBefore: 0,
      gapAfter: 2.5,
      indent: 0,
      hang: 0,
      align: 'center',
      ruleAfter: false,
    };
  }

  if (/^[-*•]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
    const textLine = t.replace(/^[-*•]\s+/, '- ').replace(/^(\d+)[.)]\s+/, '$1. ');
    return {
      kind: 'bullet',
      text: textLine,
      size: DESIGN.bulletSize,
      bold: false,
      gapBefore: 0,
      gapAfter: 2.4,
      indent: 8,
      hang: 12,
      align: 'left',
      ruleAfter: false,
    };
  }

  if (isJobHeaderLine(t)) {
    return {
      kind: 'job',
      text: t,
      size: DESIGN.jobSize,
      bold: true,
      gapBefore: 8,
      gapAfter: 2.5,
      indent: 0,
      hang: 0,
      align: 'left',
      ruleAfter: false,
    };
  }

  return {
    kind: 'body',
    text: t,
    size: DESIGN.bodySize,
    bold: false,
    gapBefore: 0,
    gapAfter: 2.4,
    indent: 0,
    hang: 0,
    align: 'left',
    ruleAfter: false,
  };
}

/**
 * Layout resume into pages of draw ops (text + hairline rules).
 * @param {string} text
 * @param {{ margin?: number, pageWidth?: number, pageHeight?: number }} [opts]
 */
export function layoutResumePages(text, opts = {}) {
  const pageWidth = opts.pageWidth ?? DESIGN.pageWidth;
  const pageHeight = opts.pageHeight ?? DESIGN.pageHeight;
  const margin = opts.margin ?? DESIGN.resumeMargin;
  const topY = pageHeight - margin - 4;
  const bottomY = margin;
  const lineGap = DESIGN.lineGapResume;

  const raw = foldForPdf(text).split('\n');
  /** @type {any[][]} */
  const pages = [[]];
  let y = topY;
  let page = pages[0];
  let sawContent = false;
  let headerZone = true;
  let headerLines = 0;
  let pendingHeaderRule = false;

  const newPage = () => {
    page = [];
    pages.push(page);
    y = topY;
    headerZone = false;
    pendingHeaderRule = false;
  };

  const pushRule = (yPos, width = DESIGN.ruleWidth) => {
    page.push({
      op: 'rule',
      x1: margin,
      y1: yPos,
      x2: pageWidth - margin,
      y2: yPos,
      width,
      gray: DESIGN.ruleGray,
    });
  };

  for (const rawLine of raw) {
    const cls = classifyResumeLine(rawLine, {
      isFirstContent: !sawContent && !!rawLine.trim(),
      headerZone: headerZone && headerLines < 5,
    });
    if (cls.kind === 'blank') {
      if (headerZone && sawContent && pendingHeaderRule) {
        y -= 4;
        pushRule(y, DESIGN.accentRuleWidth);
        y -= 10;
        pendingHeaderRule = false;
        headerZone = false;
      } else {
        y -= 6;
      }
      if (y < bottomY) newPage();
      continue;
    }
    sawContent = true;
    if (cls.kind === 'name' || cls.kind === 'contact' || cls.kind === 'headline') {
      headerLines++;
      pendingHeaderRule = true;
    } else if (cls.kind === 'heading') {
      if (pendingHeaderRule) {
        y -= 3;
        pushRule(y, DESIGN.accentRuleWidth);
        y -= 8;
        pendingHeaderRule = false;
      }
      headerZone = false;
    } else {
      headerZone = false;
    }

    if (cls.gapBefore) {
      y -= cls.gapBefore;
      if (y < bottomY + 28) newPage();
    }

    const firstMax = pageWidth - margin * 2 - cls.indent;
    const contMax = pageWidth - margin * 2 - cls.indent - (cls.hang || 0);
    const pieces = wrapLine(cls.text, cls.size, firstMax);
    const visual = [];
    for (let i = 0; i < pieces.length; i++) {
      if (i === 0) visual.push(pieces[i]);
      else {
        visual.push(...wrapLine(pieces.slice(i).join(' '), cls.size, contMax || firstMax));
        break;
      }
    }

    for (let i = 0; i < visual.length; i++) {
      const lineH = cls.size * lineGap;
      if (y - lineH < bottomY) newPage();
      const piece = visual[i];
      let x = margin + cls.indent + (i > 0 ? cls.hang || 0 : 0);
      if (cls.align === 'center') {
        const w = approxWidth(piece, cls.size);
        x = Math.max(margin, (pageWidth - w) / 2);
      }
      page.push({
        op: 'text',
        text: piece,
        size: cls.size,
        bold: !!cls.bold,
        x,
        y,
      });
      y -= lineH;
    }

    if (cls.ruleAfter) {
      y -= 2;
      pushRule(y, DESIGN.ruleWidth);
      y -= 5;
    }
    y -= cls.gapAfter * 0.35;
  }

  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return { pages, pageWidth, pageHeight };
}

/**
 * Layout a cover letter (left-aligned professional letter).
 * @param {string} letterText
 * @param {{ margin?: number, pageWidth?: number, pageHeight?: number }} [opts]
 */
export function layoutCoverLetterPages(letterText, opts = {}) {
  const pageWidth = opts.pageWidth ?? DESIGN.pageWidth;
  const pageHeight = opts.pageHeight ?? DESIGN.pageHeight;
  const margin = opts.margin ?? DESIGN.coverMargin;
  const topY = pageHeight - margin;
  const bottomY = margin;
  const bodySize = DESIGN.coverBodySize;
  const lineGap = DESIGN.lineGapCover;

  const raw = foldForPdf(letterText).split('\n');
  /** @type {any[][]} */
  const pages = [[]];
  let y = topY;
  let page = pages[0];
  let sigCount = 0;

  const newPage = () => {
    page = [];
    pages.push(page);
    y = topY;
  };

  const pushLine = (text, { size = bodySize, bold = false, gapAfter = 0 } = {}) => {
    const maxW = pageWidth - margin * 2;
    const visual = wrapLine(text, size, maxW);
    for (const piece of visual) {
      const lineH = size * lineGap;
      if (y - lineH < bottomY) newPage();
      page.push({ op: 'text', text: piece, size, bold, x: margin, y });
      y -= lineH;
    }
    if (gapAfter) y -= gapAfter;
  };

  let inSignOff = false;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trimEnd();
    if (!t.trim()) {
      y -= inSignOff ? 6 : 11;
      if (y < bottomY) newPage();
      continue;
    }
    if (/^dear\b/i.test(t.trim()) && i < 8) {
      pushLine(t.trim(), { size: bodySize, bold: false, gapAfter: 10 });
      continue;
    }
    if (/^(warm\s+regards|best\s+regards|kind\s+regards|sincerely|yours\s+truly)\b/i.test(t.trim())) {
      inSignOff = true;
      sigCount = 0;
      y -= 8;
      pushLine(t.trim(), { size: bodySize, bold: false, gapAfter: 12 });
      continue;
    }
    if (inSignOff) {
      sigCount++;
      pushLine(t.trim(), {
        size: sigCount === 1 ? DESIGN.coverSigSize : DESIGN.contactSize,
        bold: sigCount === 1,
        gapAfter: sigCount === 1 ? 3 : 1.5,
      });
      continue;
    }
    if (i < 4 && (/^\w+ \d{1,2}, \d{4}$/.test(t.trim()) || t.length < 48)) {
      pushLine(t.trim(), { size: 10, bold: false, gapAfter: 3 });
      continue;
    }
    pushLine(t.trim(), { size: bodySize, bold: false, gapAfter: 0 });
  }

  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return { pages, pageWidth, pageHeight };
}

/**
 * Serialize page draw ops → PDF content stream.
 * Selectable Helvetica text + simple vector rules (ATS ignores paths).
 * @param {any[]} opsList
 */
function pageStream(opsList) {
  const out = [];
  let inText = false;
  let lastFont = '';
  let lastSize = 0;

  const endText = () => {
    if (inText) {
      out.push('ET');
      inText = false;
      lastFont = '';
      lastSize = 0;
    }
  };

  for (const item of opsList) {
    if (item.op === 'rule') {
      endText();
      const g = item.gray ?? DESIGN.ruleGray;
      const w = item.width ?? DESIGN.ruleWidth;
      out.push(`${g.toFixed(2)} G`);
      out.push(`${w.toFixed(2)} w`);
      out.push(`${item.x1.toFixed(2)} ${item.y1.toFixed(2)} m`);
      out.push(`${item.x2.toFixed(2)} ${item.y2.toFixed(2)} l`);
      out.push('S');
      out.push('0 G');
      continue;
    }
    const text = item.text ?? '';
    const size = item.size ?? DESIGN.bodySize;
    const bold = !!item.bold;
    const x = item.x ?? DESIGN.resumeMargin;
    const y = item.y ?? 700;
    if (!inText) {
      out.push('BT');
      inText = true;
    }
    const fontKey = bold ? 'FBold' : 'FReg';
    if (fontKey !== lastFont || size !== lastSize) {
      out.push(`/${fontKey} ${size} Tf`);
      lastFont = fontKey;
      lastSize = size;
    }
    out.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
    out.push(`${pdfStringLiteral(text)} Tj`);
  }
  endText();
  return out.join('\n');
}



/**
 * @param {string[]} pageStreams
 * @param {number} pageWidth
 * @param {number} pageHeight
 */
function assemblePdf(pageStreams, pageWidth, pageHeight) {
  const streams = pageStreams.length
    ? pageStreams
    : ['BT\n/FReg 10.5 Tf\n1 0 0 1 54 738 Tm\n() Tj\nET'];
  const nPages = streams.length;
  const contentStart = 5;
  const pageStart = contentStart + nPages;
  /** @type {Record<number, string>} */
  const bodies = {};
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = Array.from({ length: nPages }, (_, i) => `${pageStart + i} 0 R`).join(' ');
  bodies[2] = `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`;
  bodies[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  bodies[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  for (let i = 0; i < nPages; i++) {
    const stream = streams[i];
    bodies[contentStart + i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    bodies[pageStart + i] = [
      '<< /Type /Page',
      '/Parent 2 0 R',
      `/MediaBox [0 0 ${pageWidth} ${pageHeight}]`,
      `/Contents ${contentStart + i} 0 R`,
      '/Resources << /Font << /FReg 3 0 R /FBold 4 0 R >> >>',
      '>>',
    ].join(' ');
  }

  const maxId = pageStart + nPages - 1;
  const chunks = [];
  const offsets = [0];
  let pos = 0;
  const push = (str) => {
    chunks.push(str);
    pos += str.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  for (let id = 1; id <= maxId; id++) {
    offsets[id] = pos;
    push(`${id} 0 obj\n`);
    push(bodies[id]);
    push('\nendobj\n');
  }
  const xrefPos = pos;
  push(`xref\n0 ${maxId + 1}\n`);
  push('0000000000 65535 f \n');
  for (let id = 1; id <= maxId; id++) {
    push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  }
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\n`);
  push(`startxref\n${xrefPos}\n%%EOF\n`);

  const bin = chunks.join('');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Build resume-only PDF bytes.
 * @param {string} resumeText
 * @param {object} [meta]
 */
export function buildResumePdf(resumeText, meta = {}) {
  const body = formatAtsPlainText(resumeText);
  if (!body) throw new Error('Resume text is empty');

  // Legacy: if coverNote passed without separateCover, keep old single-doc behavior off —
  // prefer buildApplicationPdf for packs.
  if (meta.coverNote && meta.legacyInlineCover) {
    const head = ['COVER LETTER', '', String(meta.coverNote).trim(), '', 'RESUME', '', body].join(
      '\n'
    );
    const { pages, pageWidth, pageHeight } = layoutResumePages(head);
    return assemblePdf(pages.map(pageStream), pageWidth, pageHeight);
  }

  const { pages, pageWidth, pageHeight } = layoutResumePages(body);
  return assemblePdf(pages.map(pageStream), pageWidth, pageHeight);
}

/**
 * Cover letter only PDF.
 * @param {string} letterText
 */
export function buildCoverLetterPdf(letterText) {
  const text = String(letterText || '').trim();
  if (!text) throw new Error('Cover letter is empty');
  const { pages, pageWidth, pageHeight } = layoutCoverLetterPages(text);
  return assemblePdf(pages.map(pageStream), pageWidth, pageHeight);
}

/**
 * Application pack PDF: cover letter page(s) then resume page(s).
 * @param {string} resumeText
 * @param {{
 *   coverBody?: string,
 *   coverLetter?: string,
 *   job?: object,
 *   profile?: object,
 *   settings?: object,
 *   includeCover?: boolean,
 * }} [opts]
 */
export function buildApplicationPdf(resumeText, opts = {}) {
  const body = formatAtsPlainText(resumeText);
  if (!body) throw new Error('Resume text is empty');

  const includeCover = opts.includeCover !== false;
  const settings = opts.settings || {};
  const profile = opts.profile || {};
  const job = opts.job || {};
  const coverCfg = resolveCoverSettings(settings, profile);

  /** @type {string[]} */
  const streams = [];
  const pageWidth = 612;
  const pageHeight = 792;

  if (includeCover) {
    let letter = String(opts.coverLetter || '').trim();
    if (!letter) {
      const rawBody = String(opts.coverBody || opts.coverNote || '').trim();
      if (rawBody) {
        letter = formatCoverLetter({
          body: rawBody,
          job,
          profile,
          settings,
        });
      }
    }
    if (letter) {
      const coverPages = layoutCoverLetterPages(letter, { pageWidth, pageHeight });
      for (const p of coverPages.pages) streams.push(pageStream(p));
    }
  }

  const resumePages = layoutResumePages(body, { pageWidth, pageHeight });
  for (const p of resumePages.pages) streams.push(pageStream(p));

  // If separate page is false and we had cover+resume, still multi-page is fine;
  // coverSeparatePage mainly controls whether we include a full letter layout (always separate pages here).
  void coverCfg.coverSeparatePage;

  return assemblePdf(streams, pageWidth, pageHeight);
}

/**
 * Trigger browser download for a Uint8Array PDF.
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
export function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  return { ok: true, filename, bytes: bytes.length };
}

/**
 * Build + download resume PDF (optionally with cover letter pages).
 * @param {string} resumeText
 * @param {{
 *   coverNote?: string,
 *   coverBody?: string,
 *   coverLetter?: string,
 *   title?: string,
 *   company?: string,
 *   filename?: string,
 *   includeCover?: boolean,
 *   job?: object,
 *   profile?: object,
 *   settings?: object,
 *   kind?: 'resume'|'cover'|'pack',
 * }} [opts]
 */
export function downloadResumePdf(resumeText, opts = {}) {
  const includeCover =
    opts.includeCover === true &&
    !!(opts.coverLetter || opts.coverBody || opts.coverNote || '').toString().trim();

  let bytes;
  let kind = opts.kind || (includeCover ? 'pack' : 'resume');
  if (includeCover) {
    bytes = buildApplicationPdf(resumeText, {
      includeCover: true,
      coverBody: opts.coverBody || opts.coverNote,
      coverLetter: opts.coverLetter,
      job: opts.job || { title: opts.title, company: opts.company },
      profile: opts.profile,
      settings: opts.settings,
    });
  } else {
    bytes = buildResumePdf(resumeText);
  }

  const filename =
    opts.filename ||
    atsPdfFilename({
      company: opts.company,
      title: opts.title || 'Resume',
      kind,
    });
  return downloadPdfBytes(bytes, filename);
}

/**
 * Download cover letter only.
 */
export function downloadCoverLetterPdf(letterText, opts = {}) {
  const bytes = buildCoverLetterPdf(letterText);
  const filename =
    opts.filename ||
    atsPdfFilename({
      company: opts.company,
      title: opts.title || 'Cover-Letter',
      kind: 'cover',
    });
  return downloadPdfBytes(bytes, filename);
}
