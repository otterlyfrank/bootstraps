/**
 * Sample data pack — demo the full loop without a week of real applications.
 */

import { saveResume, setProfile, putJob, putApplication } from '../storage/db.js';
import { scoreJob } from '../jobs/match.js';

const SAMPLE_RESUME = `Alex Rivera
Remote Data Analyst · Strategy & Research
alex@example.com · Portfolio on request

SUMMARY
Analyst comfortable with messy datasets, stakeholder research, and turning findings into decisions.
Targeting remote roles (~$2–3k/mo) in data analysis, strategy, and research hybrids.

SKILLS
SQL · Python (pandas) · Spreadsheet modeling · Dashboarding · Stakeholder interviews · Market research · Written briefing

EXPERIENCE
Independent Research / Analysis (2022–present)
- Built recurring metric reviews for a small ops team (pipeline, conversion, churn proxies)
- Delivered two competitive landscapes with sourcing notes and decision criteria
- Wrote plain-language briefs for non-technical stakeholders

Project work
- Survey design + analysis for a community program (n≈180)
- Funnel diagnostic: identified drop-off step and proposed A/B test plan

EDUCATION
B.A. Social Sciences — quantitative coursework (stats, research methods)
`;

const SAMPLE_PROFILE = {
  name: 'Alex Rivera (sample)',
  skills: ['SQL', 'Python', 'research', 'dashboards', 'stakeholder communication'],
  experienceKeywords: ['data analysis', 'metrics', 'competitive landscape', 'survey', 'briefing'],
  preferredDomains: ['Data Analysis', 'Strategy', 'Research'],
  salaryFloorUsd: 2000,
  salaryCeilingUsd: 3200,
  dealBreakers: ['unpaid', 'equity only', 'on-site only'],
  remoteOnly: true,
  notes: 'Sample profile for Bootstraps demo — replace with your real targeting.',
};

const SAMPLE_JOBS = [
  {
    id: 'sample-job-1',
    externalId: 'sample-1',
    source: 'sample',
    title: 'Remote Data Analyst',
    company: 'Northline Ops',
    url: 'https://example.com/jobs/data-analyst',
    category: 'Data',
    salaryText: '$2,400–2,800/mo',
    remote: true,
    domains: ['Data Analysis'],
    description: `We're hiring a remote Data Analyst to own weekly metrics and ad-hoc SQL pulls.
Must-haves: SQL, spreadsheet modeling, clear written updates.
Nice: Python/pandas, experience explaining numbers to operators.
Compensation: $2400–2800 USD/month, fully remote, async-friendly.`,
  },
  {
    id: 'sample-job-2',
    externalId: 'sample-2',
    source: 'sample',
    title: 'Strategy Research Associate',
    company: 'Harbor Collective',
    url: 'https://example.com/jobs/strategy-research',
    category: 'Business',
    salaryText: '$2,500/mo',
    remote: true,
    domains: ['Strategy', 'Research'],
    description: `Part-time Strategy Research Associate.
Scan markets, synthesize competitor moves, draft 2-page briefs.
Looking for research methods, structured writing, and comfort with ambiguous scopes.
Remote. ~$2500/month.`,
  },
  {
    id: 'sample-job-3',
    externalId: 'sample-3',
    source: 'sample',
    title: 'Growth Marketing Analyst',
    company: 'Brightfunnel',
    url: 'https://example.com/jobs/growth',
    category: 'Marketing',
    salaryText: '$3,000/mo',
    remote: true,
    domains: ['Marketing/BD', 'Data Analysis'],
    description: `Growth Marketing Analyst — attribution, experiment readouts, channel dashboards.
SQL + marketing metrics required. Paid ads experience a plus.
$3000/mo remote.`,
  },
  {
    id: 'sample-job-4',
    externalId: 'sample-4',
    source: 'sample',
    title: 'Blockchain Research Intern (Unpaid)',
    company: 'TokenYard',
    url: 'https://example.com/jobs/unpaid',
    category: 'Other',
    salaryText: 'Unpaid + equity only',
    remote: true,
    domains: ['Web3/Blockchain', 'Research'],
    description: `Unpaid research intern for crypto market notes. Equity only. On-chain data a plus.`,
  },
];

/**
 * Load demo Master/Working resume, profile, scored jobs, and applications
 * (including rejections with JDs so Domain intel can flag Data Analysis).
 */
export async function loadSamplePack() {
  await saveResume('master', SAMPLE_RESUME, 'Master Resume (sample)');
  await saveResume('working', SAMPLE_RESUME, 'Working Resume (sample)');
  await setProfile(SAMPLE_PROFILE);

  const jobRecords = [];
  for (const raw of SAMPLE_JOBS) {
    const { score, breakdown, domains } = scoreJob(raw, SAMPLE_PROFILE, SAMPLE_RESUME);
    const rec = await putJob({
      ...raw,
      domains: raw.domains?.length ? raw.domains : domains,
      score,
      scoreBreakdown: breakdown,
      fetchedAt: Date.now(),
      dismissed: false,
    });
    jobRecords.push(rec);
  }

  const [j1, j2, j3] = jobRecords;
  const day = 86400000;
  const now = Date.now();

  await putApplication({
    jobId: j1.id,
    title: j1.title,
    company: j1.company,
    url: j1.url,
    domain: 'Data Analysis',
    status: 'Rejected',
    notes: 'Automated rejection after 5 days. No feedback.',
    jobDescription: j1.description,
    resumeBase: 'working',
    appliedAt: now - 20 * day,
  });
  await putApplication({
    jobId: j3.id,
    title: j3.title,
    company: j3.company,
    url: j3.url,
    domain: 'Data Analysis',
    status: 'Ghosted',
    notes: 'Applied via form; silence.',
    jobDescription: j3.description,
    resumeBase: 'working',
    appliedAt: now - 14 * day,
  });
  await putApplication({
    title: 'Junior BI Analyst',
    company: 'MetricNest',
    url: 'https://example.com/jobs/bi',
    domain: 'Data Analysis',
    status: 'Rejected',
    notes: 'Recruiter said “need more enterprise BI tools.”',
    jobDescription:
      'Junior BI Analyst. Tableau or Power BI required. SQL daily. Remote US-friendly. $2200–2600/mo.',
    resumeBase: 'working',
    appliedAt: now - 10 * day,
  });
  await putApplication({
    title: 'Analytics Associate',
    company: 'Cedar Path',
    url: 'https://example.com/jobs/analytics',
    domain: 'Data Analysis',
    status: 'Rejected',
    notes: 'No interview. JD stressed “3+ years product analytics.”',
    jobDescription:
      'Analytics Associate supporting product. SQL, event tracking, A/B tests. Prefer 3+ years. $2500/mo remote.',
    resumeBase: 'working',
    appliedAt: now - 6 * day,
  });
  await putApplication({
    jobId: j2.id,
    title: j2.title,
    company: j2.company,
    url: j2.url,
    domain: 'Strategy',
    status: 'Interview',
    notes: 'Screen scheduled — sample positive signal.',
    jobDescription: j2.description,
    resumeBase: 'working',
    appliedAt: now - 3 * day,
  });

  return { jobs: jobRecords.length, applications: 5 };
}
