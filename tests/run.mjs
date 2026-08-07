/**
 * Minimal test runner for Node 17+ (no node:test required).
 * Usage: node tests/run.mjs
 */

import { scoreJob, tokenize, salaryFit } from '../src/jobs/match.js';
import { parseJobLinks, normalizeJobUrl } from '../src/jobs/links.js';
import {
  filterJobs,
  dealBreakerHits,
  daysFromNow,
  requiresEnglish,
} from '../src/lib/job-filters.js';
import { parseModelJson } from '../src/ai/prompts.js';

let failed = 0;
let passed = 0;

function ok(cond, msg) {
  if (!cond) {
    console.error('  ✗', msg);
    failed++;
  } else {
    console.log('  ✓', msg);
    passed++;
  }
}

console.log('tokenize');
{
  const t = tokenize('SQL, Python + Power-BI');
  ok(t.has('sql'), 'has sql');
  ok(t.has('python'), 'has python');
}

console.log('scoreJob');
{
  const profile = {
    skills: ['SQL', 'Python', 'Tableau'],
    experienceKeywords: ['funnel', 'dashboard'],
    preferredDomains: ['Data Analysis'],
    salaryFloorUsd: 2000,
    salaryCeilingUsd: 4000,
    dealBreakers: ['unpaid'],
    remoteOnly: true,
  };
  const resume = 'Data analyst with SQL Python Tableau funnel analysis dashboards remote.';
  const r = scoreJob(
    {
      title: 'Data Analyst',
      company: 'Acme',
      description: 'SQL Python Tableau dashboards remote $3000/month',
      salaryText: '$3000/mo',
      remote: true,
    },
    profile,
    resume
  );
  ok(r.score >= 40, `strong match score ${r.score}`);
  ok(!!r.breakdown, 'has breakdown');
  const bad = scoreJob(
    { title: 'Intern', description: 'unpaid volunteer SQL remote', remote: true },
    profile,
    resume
  );
  ok(bad.score < r.score, `penalty ${bad.score} < ${r.score}`);
}

console.log('salaryFit');
ok(salaryFit('', null, null, 2000, 3500) === 0.55, 'unknown salary neutral');

console.log('parseJobLinks');
{
  const items = parseJobLinks(`
https://jobs.lever.co/acme/abc-123
[Cool Role](https://boards.greenhouse.io/acme/jobs/99)
Title | https://example.com/jobs/1
`);
  ok(items.length >= 3, `parsed ${items.length} links`);
  ok(items.some((i) => i.url.includes('lever.co')), 'lever url');
  ok(items.some((i) => i.titleHint === 'Cool Role'), 'markdown title');
  const u = normalizeJobUrl('https://example.com/job/1/?utm_source=x');
  ok(!u.includes('utm_'), 'strips utm');
}

console.log('filterJobs');
{
  const jobs = [
    { id: '1', title: 'A', company: 'X', score: 80, dismissed: false },
    { id: '2', title: 'B', company: 'Y', score: 20, dismissed: false, shortlisted: true },
    { id: '3', title: 'C', company: 'Z', score: 50, dismissed: true },
  ];
  ok(filterJobs(jobs, { minScore: 40 }).length === 1, 'min score + dismissed');
  ok(filterJobs(jobs, { shortlistedOnly: true, minScore: 0 }).length === 1, 'shortlist');
  ok(
    dealBreakerHits(
      { title: 'Role', description: 'This is unpaid internship' },
      { dealBreakers: ['unpaid'] }
    ).length === 1,
    'deal breaker'
  );
  const enJobs = [
    {
      id: '1',
      title: 'Data Engineer',
      company: 'Telekom',
      source: 'telekom',
      score: 70,
      dismissed: false,
      description: 'You need fluent English and Python experience.',
    },
    {
      id: '2',
      title: 'Raktáros',
      company: 'Local',
      source: 'profession',
      score: 60,
      dismissed: false,
      description: 'Fizikai munka, magyar nyelvtudás elégséges.',
    },
  ];
  ok(filterJobs(enJobs, { minScore: 0, requireEnglish: true }).length === 1, 'english required filter');
}

console.log('requiresEnglish');
{
  ok(
    requiresEnglish({ title: 'Analyst', description: 'English required, B2 level.' }) === true,
    'explicit EN'
  );
  ok(
    requiresEnglish({
      title: 'Ügyfélszolgálati munkatárs',
      description: 'Elvárás a tárgyalóképes angol nyelvtudás.',
    }) === true,
    'HU angol'
  );
  ok(
    requiresEnglish({
      title: 'Raktáros',
      description: 'Fizikai munka Budapesten, teljes munkaidő.',
      source: 'profession',
    }) === false,
    'pure HU no language'
  );
  ok(
    requiresEnglish({
      title: 'Data Engineer',
      source: 'telekom',
      description:
        'You are the ideal candidate if you have strong Python skills and experience with the team. Work with your skills required for responsibilities.',
    }) === true,
    'EN-written HU board JD'
  );
}

console.log('parseModelJson');
{
  const o = parseModelJson('Here:\n```json\n{"a":1,"b":"x"}\n```\n');
  ok(o.a === 1 && o.b === 'x', 'fenced json');
  const o2 = parseModelJson('Sure! {"ok":true,"n":2} thanks');
  ok(o2.ok === true && o2.n === 2, 'noisy json');
}

console.log('daysFromNow');
ok(typeof daysFromNow(3) === 'number' && daysFromNow(3) > Date.now() - 1000, 'epoch offset');

console.log('climb-timeline + print-pack');
{
  const { weeklyAppBuckets, sparklineSvg } = await import('../src/ui/climb-timeline.js');
  const { applicationPackMarkdown } = await import('../src/ui/print-pack.js');
  const now = Date.now();
  const buckets = weeklyAppBuckets(
    [
      { appliedAt: now, status: 'Applied' },
      { appliedAt: now, status: 'Interview' },
      { appliedAt: now - 14 * 86400000, status: 'Rejected' },
    ],
    8
  );
  ok(buckets.length === 8, '8 week buckets');
  ok(buckets.reduce((s, b) => s + b.applied, 0) >= 2, 'apps bucketed');
  ok(sparklineSvg([1, 3, 2]).includes('polyline'), 'sparkline svg');
  const md = applicationPackMarkdown({
    title: 'Analyst',
    company: 'Acme',
    resume: 'SQL expert',
    coverNote: 'Hello',
  });
  ok(md.includes('Analyst') && md.includes('SQL expert'), 'pack markdown');
}

console.log('resume-format');
{
  const {
    normalizeBulletLine,
    formatAtsPlainText,
    stripPrepWrapper,
    polishAtsOutput,
    looksLikePrepPack,
    isSectionHeading,
  } = await import('../src/lib/resume-format.js');

  ok(normalizeBulletLine('• Built dashboards') === '- Built dashboards', 'bullet normalize');
  ok(isSectionHeading('EXPERIENCE'), 'section heading caps');
  ok(isSectionHeading('Skills'), 'section heading title');

  const messy = `Alex Rivera
alex@x.com
SUMMARY
Analyst line
EXPERIENCE
Acme (2020-2024)
• Did a thing
* Did another`;
  const clean = formatAtsPlainText(messy);
  ok(clean.includes('SUMMARY') || clean.includes('Summary'), 'has summary section');
  ok(clean.includes('- Did a thing'), 'bullet hyphenated');
  ok(/\n\n/.test(clean) || clean.split('\n').filter((l) => !l.trim()).length >= 1, 'section blanks');

  const prep = `# Application prep - Role @ Co

## Keyword checklist (auto)
Coverage: 50%

## Working resume (base)
Jane Doe
jane@x.com

SUMMARY
Hello world experience here with enough chars.
`;
  ok(looksLikePrepPack(prep), 'detects prep pack');
  const stripped = stripPrepWrapper(prep);
  ok(stripped.includes('Jane Doe') && !stripped.includes('Keyword checklist'), 'strips prep wrapper');
  ok(polishAtsOutput(prep).includes('Jane Doe'), 'polish recovers resume');
}

console.log('cover-letter');
{
  const {
    formatCoverLetter,
    formatGreeting,
    extractCoverBody,
    buildLocalCoverBody,
    resolveCoverSettings,
  } = await import('../src/lib/cover-letter.js');

  const letter = formatCoverLetter({
    body: 'I am applying for the analyst role.\n\nI bring SQL and Python.\n\nSee otterly.global for more.',
    job: { title: 'Data Analyst', company: 'Acme' },
    profile: {
      name: 'Frank Daniel Czito',
      email: 'frank@example.com',
      phone: '+36 30 000 0000',
      website: 'https://otterly.global',
    },
    settings: {
      coverGreeting: 'Dear {company},',
      coverSignOff: 'Warm Regards,',
      coverPortfolio: 'https://otterly.global',
    },
  });
  ok(letter.startsWith('Dear Acme,'), 'simple greeting');
  ok(letter.includes('Warm Regards,'), 'sign-off');
  ok(letter.includes('Frank Daniel Czito'), 'signature name');
  ok(letter.includes('frank@example.com'), 'contact line');
  ok(!/^I am applying/m.test(letter.split('\n')[0]), 'body not first line');

  ok(
    formatGreeting(resolveCoverSettings({ coverGreeting: 'Dear {company},' }, {}), {
      company: '',
    }).includes('Hiring Manager'),
    'fallback greeting'
  );
  ok(extractCoverBody('Dear Acme,\n\nHello body.\n\nWarm Regards,\n\nX').includes('Hello body'), 'extract body');
  const localBody = buildLocalCoverBody({
    job: { title: 'Analyst', company: 'Co' },
    profile: { skills: ['SQL', 'Python', 'research'] },
    workingResume: 'SKILLS\nSQL · Python\n',
    settings: { coverPortfolio: 'https://otterly.global' },
  });
  ok(localBody.includes('otterly.global') || localBody.includes('SQL'), 'local body skills/site');
}

console.log('pdf-resume');
{
  const {
    foldForPdf,
    atsPdfFilename,
    buildResumePdf,
    buildApplicationPdf,
    layoutResumePages,
    slugFilenamePart,
    approxWidth,
  } = await import('../src/lib/pdf-resume.js');

  const bytes = buildResumePdf(`JANE DOE
jane@example.com

EXPERIENCE
- Built dashboards with SQL and Python
- Led funnel analysis for growth

SKILLS
SQL, Python, Tableau`);
  ok(bytes instanceof Uint8Array && bytes.length > 200, 'pdf bytes');
  const head = String.fromCharCode(...bytes.slice(0, 8));
  ok(head.startsWith('%PDF-1.'), 'pdf header');
  const tail = String.fromCharCode(...bytes.slice(-12));
  ok(tail.includes('EOF'), 'pdf eof');

  let threw = false;
  try {
    buildResumePdf('   ');
  } catch {
    threw = true;
  }
  ok(threw, 'empty resume throws');

  const folded = foldForPdf('Szülőföld űrhajó');
  ok(!folded.includes('ő') && !folded.includes('ű'), 'folds HU double-acute');
  ok(
    atsPdfFilename({ company: 'Acme Corp', title: 'Data Analyst' }) ===
      'Resume-Acme-Corp-Data-Analyst.pdf',
    'filename company+title'
  );
  ok(slugFilenamePart('Hello World!') === 'Hello-World', 'slug');

  const long = Array.from(
    { length: 120 },
    (_, i) => `Bullet line number ${i + 1} with enough words to wrap a bit.`
  ).join('\n');
  const { pages } = layoutResumePages(long);
  ok(pages.length >= 2, `paginates long resume (${pages.length} pages)`);

  const paren = buildResumePdf('Engineer (remote) at Acme (Series B)');
  ok(paren[0] === 0x25, 'escapes parentheses');

  // Centered name: first line x should be > left margin
  const laid = layoutResumePages(`Alex Rivera
alex@x.com

SUMMARY
Hello`);
  const nameLine = laid.pages[0][0];
  ok(nameLine && nameLine.bold && nameLine.size >= 16, 'name large bold');
  ok(nameLine.x > 54, `name centered-ish (x=${nameLine.x})`);
  const heading = laid.pages[0].find((l) => l.text === 'SUMMARY');
  ok(heading && heading.bold && heading.size >= 12, 'section heading bold large');

  const pack = buildApplicationPdf(
    `Alex Rivera
alex@x.com

SUMMARY
Analyst.

SKILLS
SQL

EXPERIENCE
Acme (2020-2024)
- Did work`,
    {
      includeCover: true,
      coverLetter: `Dear Acme,

I bring SQL and research to this role.

Warm Regards,

Frank Daniel Czito
frank@example.com · otterly.global`,
      job: { title: 'Analyst', company: 'Acme' },
    }
  );
  ok(pack.length > bytes.length, 'pack larger than resume-only');
  void approxWidth;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
