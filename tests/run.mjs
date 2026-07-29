/**
 * Minimal test runner for Node 17+ (no node:test required).
 * Usage: node tests/run.mjs
 */

import { scoreJob, tokenize, salaryFit } from '../src/jobs/match.js';
import { parseJobLinks, normalizeJobUrl } from '../src/jobs/links.js';
import { filterJobs, dealBreakerHits, daysFromNow } from '../src/lib/job-filters.js';
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
