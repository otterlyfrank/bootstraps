/**
 * Pure-function unit tests for Bootstraps core scoring / parsing.
 * Run: node --test tests/unit.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob, tokenize, salaryFit } from '../src/jobs/match.js';
import { parseJobLinks, normalizeJobUrl } from '../src/jobs/links.js';
import { filterJobs, dealBreakerHits, daysFromNow } from '../src/lib/job-filters.js';
import { parseModelJson } from '../src/ai/prompts.js';

describe('tokenize', () => {
  it('lowercases and splits keywords', () => {
    const t = tokenize('SQL, Python + Power-BI');
    assert.ok(t.has('sql'));
    assert.ok(t.has('python'));
    assert.ok(t.has('power-bi') || t.has('power') || t.has('bi'));
  });
});

describe('scoreJob', () => {
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

  it('scores strong skill overlap highly', () => {
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
    assert.ok(r.score >= 40, `expected score >= 40, got ${r.score}`);
    assert.ok(r.breakdown);
    assert.ok(Array.isArray(r.domains));
  });

  it('applies deal-breaker penalty', () => {
    const good = scoreJob(
      { title: 'Analyst', description: 'SQL remote paid role', remote: true },
      profile,
      resume
    );
    const bad = scoreJob(
      { title: 'Intern', description: 'unpaid volunteer SQL remote', remote: true },
      profile,
      resume
    );
    assert.ok(bad.score < good.score, `penalty should lower score: ${bad.score} vs ${good.score}`);
  });
});

describe('salaryFit', () => {
  it('returns neutral when unknown', () => {
    assert.equal(salaryFit('', null, null, 2000, 3500), 0.55);
  });
});

describe('parseJobLinks', () => {
  it('parses bare urls and markdown', () => {
    const items = parseJobLinks(`
https://jobs.lever.co/acme/abc-123
[Cool Role](https://boards.greenhouse.io/acme/jobs/99)
Title | https://example.com/jobs/1
`);
    assert.ok(items.length >= 3);
    assert.ok(items.some((i) => i.url.includes('lever.co')));
    assert.ok(items.some((i) => i.titleHint === 'Cool Role'));
  });

  it('normalizes trailing slash and utm', () => {
    const u = normalizeJobUrl('https://example.com/job/1/?utm_source=x&utm_medium=y');
    assert.ok(!u.includes('utm_'));
  });
});

describe('filterJobs', () => {
  const jobs = [
    { id: '1', title: 'A', company: 'X', score: 80, dismissed: false },
    { id: '2', title: 'B', company: 'Y', score: 20, dismissed: false, shortlisted: true },
    { id: '3', title: 'C', company: 'Z', score: 50, dismissed: true },
  ];

  it('filters by min score and hides dismissed', () => {
    const list = filterJobs(jobs, { minScore: 40 });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, '1');
  });

  it('shortlist only', () => {
    const list = filterJobs(jobs, { shortlistedOnly: true, minScore: 0 });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, '2');
  });

  it('deal breaker hits', () => {
    const hits = dealBreakerHits(
      { title: 'Role', description: 'This is unpaid internship' },
      { dealBreakers: ['unpaid'] }
    );
    assert.deepEqual(hits, ['unpaid']);
  });
});

describe('parseModelJson', () => {
  it('parses fenced json', () => {
    const o = parseModelJson('Here you go:\n```json\n{"a":1,"b":"x"}\n```\n');
    assert.equal(o.a, 1);
    assert.equal(o.b, 'x');
  });

  it('parses raw object with noise', () => {
    const o = parseModelJson('Sure! {"ok":true,"n":2} thanks');
    assert.equal(o.ok, true);
    assert.equal(o.n, 2);
  });
});

describe('daysFromNow', () => {
  it('returns epoch for day offset', () => {
    const t = daysFromNow(3);
    assert.ok(typeof t === 'number' && t > Date.now());
  });
});
