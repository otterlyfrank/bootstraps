/**
 * Resume plain-text formatting — preserve structure from extract → ATS → PDF.
 * Small but important cues: section blanks, bullets, job headers, contact lines.
 */

const SECTION_RE =
  /^(summary|profile|professional summary|objective|skills|technical skills|core competencies|core skills|experience|work experience|professional experience|employment|employment history|education|academic background|projects|selected projects|certifications|certificates|licenses|awards|publications|languages|interests|volunteer|volunteering|affiliations|references|tools|technologies|tech stack|about|contact)\b[\s:]*$/i;

const BULLET_LEAD_RE = /^(?:[•●○◦▪▫◆◇■□►▸‣·∙]|\-|\*|–|—)\s+/;
const NUMBERED_LEAD_RE = /^(\d{1,2})[.)]\s+/;

/**
 * Normalize bullet / dash leaders to a single ATS-safe style: "- ".
 * @param {string} line
 */
export function normalizeBulletLine(line) {
  const t = String(line || '').replace(/\s+$/, '');
  if (!t.trim()) return '';
  if (BULLET_LEAD_RE.test(t.trimStart())) {
    const body = t.trimStart().replace(BULLET_LEAD_RE, '').trim();
    return body ? `- ${body}` : '-';
  }
  if (NUMBERED_LEAD_RE.test(t.trimStart())) {
    return t.trimStart().replace(NUMBERED_LEAD_RE, (_, n) => `${n}. `);
  }
  return t;
}

/**
 * True if line looks like a resume section heading.
 * @param {string} line
 */
export function isSectionHeading(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 48) return false;
  if (/@/.test(t) || /\d{4}/.test(t)) return false;
  if (SECTION_RE.test(t)) return true;
  // ALL CAPS short headings (EXPERIENCE, WORK HISTORY)
  if (/^[A-Z][A-Z0-9 &/\-]{1,40}$/.test(t) && /[A-Z]{3,}/.test(t)) return true;
  // Title Case single/multi word headers without trailing period
  if (
    !t.endsWith('.') &&
    !t.endsWith(',') &&
    /^[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9/&-]+){0,4}$/.test(t) &&
    SECTION_RE.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Soft-join lines that PDF extract wrongly split mid-sentence / mid-bullet.
 * Conservative: only join when previous doesn't look complete and next is lowercase continuation.
 * @param {string[]} lines
 */
export function rejoinBrokenLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw || '').replace(/[ \t]+$/g, '');
    if (!out.length) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const prevT = prev.trim();
    const curT = line.trim();
    if (!curT) {
      out.push('');
      continue;
    }
    if (!prevT) {
      out.push(line);
      continue;
    }

    const prevIsBullet = /^[-*•]/.test(prevT) || /^\d+\./.test(prevT);
    const curIsBullet = /^[-*•]/.test(curT) || /^\d+\./.test(curT);
    const curIsHeading = isSectionHeading(curT);
    const prevIsHeading = isSectionHeading(prevT);

    // Never glue contact / URL / phone lines into the previous line
    const curIsContact =
      /@/.test(curT) ||
      /^https?:/i.test(curT) ||
      /linkedin\.com|github\.com/i.test(curT) ||
      /(\+?\d[\d\s().-]{7,}\d)/.test(curT) ||
      (/^[a-z0-9._%+-]+@/i.test(curT));
    if (curIsContact || curIsHeading || curIsBullet || prevIsHeading) {
      out.push(line);
      continue;
    }

    // Don't join short name-like previous line with a new short header-ish line
    const prevLooksLikeName =
      prevT.length <= 48 &&
      !prevIsBullet &&
      /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3}$/.test(prevT);
    if (prevLooksLikeName) {
      out.push(line);
      continue;
    }

    const prevEndsOpen =
      /[,\u2013\u2014/]$/.test(prevT) ||
      (/\b(and|or|of|the|to|for|with|in|on|at|a|an)$/i.test(prevT) && prevT.length < 90);

    // Mid-bullet wrap: previous bullet doesn't end with terminal punct
    const bulletWrap =
      prevIsBullet &&
      !/[.!?…]$/.test(prevT) &&
      curT.length < 120 &&
      !/^\d{4}/.test(curT) &&
      /^[a-z(]/.test(curT);

    // Continuation of an open clause (not a new sentence / role line)
    const softContinue =
      prevEndsOpen &&
      /^[a-z(]/.test(curT) &&
      curT.length < 100 &&
      !/\b(19|20)\d{2}\b/.test(curT);

    if (bulletWrap || softContinue) {
      out[out.length - 1] = `${prevT} ${curT}`.replace(/\s+/g, ' ');
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Insert blank lines around section headings; collapse 3+ blanks to 1.
 * @param {string[]} lines
 */
export function ensureSectionSpacing(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t && isSectionHeading(t)) {
      if (out.length && out[out.length - 1].trim() !== '') out.push('');
      out.push(normalizeHeading(t));
      continue;
    }
    out.push(line);
  }
  return collapseBlankLines(out);
}

/** @param {string} h */
function normalizeHeading(h) {
  const t = h.trim().replace(/:+$/, '');
  // Prefer classic ATS ALL CAPS for known sections
  if (SECTION_RE.test(t)) return t.toUpperCase();
  if (/^[A-Z][A-Z0-9 &/\-]{2,}$/.test(t)) return t;
  return t;
}

/**
 * Collapse runs of blank lines to a single blank; trim ends.
 * @param {string[]} lines
 */
export function collapseBlankLines(lines) {
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (!String(line).trim()) {
      blanks++;
      if (blanks === 1) out.push('');
      continue;
    }
    blanks = 0;
    out.push(String(line).replace(/[ \t]+$/g, ''));
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * Fix common PDF extract artifacts into clean ATS plain text.
 * Use after extractPdfText / extractDocxText and before save/Grok.
 * @param {string} text
 */
export function normalizeExtractedResume(text) {
  let s = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n');

  // Soft hyphen leftovers
  s = s.replace(/\u00ad\n?/g, '');

  let lines = s.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').trimEnd());
  // Only normalize bullet glyphs at line start (keep mid-line · separators in skills)
  lines = lines.map((l) =>
    l.replace(/^\s*[●○◦▪▫◆◇■□►▸‣∙•]\s+/, '• ').replace(/^\s*·\s+/, '• ')
  );

  // Drop form-feed / page debris lines
  lines = lines.filter((l) => !/^[\f\v]+$/.test(l));

  lines = rejoinBrokenLines(lines);
  lines = lines.map((l) => normalizeBulletLine(l));
  lines = ensureSectionSpacing(lines);
  lines = collapseBlankLines(lines);

  return lines.join('\n').trim();
}

/**
 * Normalize an already-structured master/ATS resume (light touch).
 * Does not invent content — only bullets, headings, spacing, strip prep wrappers.
 * @param {string} text
 */
export function formatAtsPlainText(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  // Strip accidental "application prep" wrappers from older local prep
  s = stripPrepWrapper(s);

  // Strip markdown fences if a model wrapped the resume
  s = s.replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/\s*```$/i, '');

  // Demote markdown headings to plain section headers
  s = s
    .split('\n')
    .map((line) => {
      const h = line.match(/^#{1,3}\s+(.+)$/);
      if (h) return h[1].trim();
      // bold-only line **SKILLS** → SKILLS
      const b = line.match(/^\*\*([^*]+)\*\*$/);
      if (b) return b[1].trim();
      return line;
    })
    .join('\n');

  return normalizeExtractedResume(s);
}

/**
 * If local prep / model returned a checklist pack, recover the resume body.
 * @param {string} text
 */
export function stripPrepWrapper(text) {
  const s = String(text || '');
  if (!/Application prep|Keyword checklist|##\s*Working resume/i.test(s)) return s;

  const trySplit = (re) => {
    const parts = s.split(re);
    if (parts.length < 2) return '';
    const body = parts.slice(1).join('\n').trim();
    // Real resume body should be more than a stub line
    return body.length >= 40 ? body : '';
  };

  // Prefer content after Working / ATS / Tailored resume heading
  const fromWorking = trySplit(/^##\s*Working resume(?:\s*\(base\))?\s*$/im);
  if (fromWorking) return fromWorking;
  const fromAts = trySplit(/^##\s*(?:ATS|Tailored) resume\s*$/im);
  if (fromAts) return fromAts;

  // Application prep title at top with working resume later
  if (/^#\s*Application prep\b/im.test(s)) {
    const parts = s.split(/^##\s*Working resume(?:\s*\(base\))?\s*$/im);
    if (parts[1]?.trim().length >= 40) return parts[1].trim();
  }
  return s;
}

/**
 * Post-process model ATS output so it stays upload-ready.
 * @param {string} text
 * @param {{ baseResume?: string }} [opts]
 */
export function polishAtsOutput(text, opts = {}) {
  let s = formatAtsPlainText(text);
  if (!s && opts.baseResume) s = formatAtsPlainText(opts.baseResume);
  // Guard: if model returned tiny stub, fall back to base
  if (opts.baseResume && s.length < Math.min(200, opts.baseResume.length * 0.35)) {
    s = formatAtsPlainText(opts.baseResume);
  }
  return s;
}

/**
 * Detect if text is a prep checklist rather than a resume.
 * @param {string} text
 */
export function looksLikePrepPack(text) {
  const s = String(text || '');
  if (/##\s*Working resume/i.test(s) && /Application prep|Keyword checklist/i.test(s)) {
    return true;
  }
  return (
    /Keyword checklist/i.test(s) &&
    (/Already covered/i.test(s) || /Gaps to address/i.test(s)) &&
    /Working resume/i.test(s)
  );
}
