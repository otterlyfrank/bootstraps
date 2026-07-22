/**
 * Non-AI application prep: keyword gaps + free tailored draft hints.
 */

import { tokenize } from './match.js';

const STOP = new Set(
  'a an the and or of to for in on with at by from as is are was were be been being this that these those it its your you we our they their will can may should must about into over under than then so if but not no yes all any each other such only own same too very just also more most some'.split(
    /\s+/
  )
);

/** High-value tokens from a job description (skip fluff). */
export function extractJdKeywords(jobDescription, limit = 40) {
  const tokens = [...tokenize(jobDescription || '')].filter((t) => {
    if (STOP.has(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (t.length < 3) return false;
    return true;
  });
  const scored = tokens.map((t) => {
    let s = 1;
    if (/sql|python|excel|tableau|power|bi|research|strategy|analytics|marketing|remote|async/.test(t)) {
      s += 3;
    }
    if (t.length >= 6) s += 1;
    if (/[+#]/.test(t)) s += 2;
    return { t, s };
  });
  scored.sort((a, b) => b.s - a.s || b.t.length - a.t.length);
  const seen = new Set();
  const out = [];
  for (const { t } of scored) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @param {string} resumeBody
 * @param {string} jobDescription
 * @param {{ skills?: string[], experienceKeywords?: string[] }} profile
 */
export function analyzeKeywordGaps(resumeBody, jobDescription, profile = {}) {
  const jdKw = extractJdKeywords(jobDescription);
  const resumeTok = tokenize(
    `${resumeBody || ''} ${(profile.skills || []).join(' ')} ${(profile.experienceKeywords || []).join(' ')}`
  );
  const present = [];
  const missing = [];
  for (const k of jdKw) {
    if (resumeTok.has(k)) present.push(k);
    else missing.push(k);
  }
  const coverage = jdKw.length ? present.length / jdKw.length : 0;
  return {
    jdKeywords: jdKw,
    present,
    missing,
    coverage,
    coveragePct: Math.round(coverage * 100),
  };
}

/**
 * Build a free prep pack without any API: hints + optional reordered draft.
 * Does not invent experience — only reorders emphasis and lists gaps.
 */
export function buildLocalPrep({ workingResume, job, profile }) {
  const gaps = analyzeKeywordGaps(workingResume, job.description || '', profile);
  const title = job.title || 'Role';
  const company = job.company || 'Company';

  const highlightLines = gaps.present
    .slice(0, 12)
    .map((k) => `- Emphasize: **${k}** (already in your materials)`);
  const gapLines = gaps.missing
    .slice(0, 15)
    .map((k) => `- JD asks for **${k}** — only add if true; else rephrase closest proof`);

  const coverNote = [
    `Hi — I'm applying for ${title} at ${company}.`,
    '',
    `I focus on remote analysis / research work and can contribute on: ${
      gaps.present.slice(0, 6).join(', ') || 'the core requirements'
    }.`,
    '',
    'Happy to walk through a relevant example from my background.',
    '',
    'Thanks for considering my application.',
  ].join('\n');

  const coveredBlock =
    highlightLines.length > 0 ? highlightLines : ['- (few direct overlaps - check wording)'];
  const gapBlock = gapLines.length > 0 ? gapLines : ['- No major keyword gaps detected'];

  const lines = [
    `# Application prep - ${title} @ ${company}`,
    '',
    '## Target',
    `${title} · ${company}`,
  ];
  if (job.url) lines.push(job.url);
  lines.push(
    '',
    '## Keyword checklist (auto)',
    `Coverage: ${gaps.coveragePct}% of extracted JD keywords appear in your Working resume/profile.`,
    '',
    '### Already covered',
    ...coveredBlock,
    '',
    '### Gaps to address only if honest',
    ...gapBlock,
    '',
    '## Working resume (base)',
    workingResume || '',
    ''
  );

  const tailoredResume = lines.join('\n');
  const changesSummary = `Local prep (no AI): ${gaps.coveragePct}% keyword coverage · ${gaps.present.length} matches · ${gaps.missing.length} gaps flagged. Nothing invented — review gaps before claiming skills.`;

  return {
    tailoredResume,
    coverNote,
    keywordsEmphasized: gaps.present.slice(0, 20),
    keywordsMissing: gaps.missing.slice(0, 20),
    coveragePct: gaps.coveragePct,
    changesSummary,
    mode: 'local',
  };
}
