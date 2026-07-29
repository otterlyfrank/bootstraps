/**
 * Efficient, structured prompt templates for Grok.
 * Keep context tight — only what the model needs.
 */

/**
 * Tailored ATS resume + optional cover note.
 */
export function prepareApplicationPrompt({ workingResume, job, profile, includeCover }) {
  const jd = (job.description || '').slice(0, 6000);
  return {
    system: `You help candidates prepare focused job applications. Output strict JSON only, no markdown fences.
Schema:
{
  "tailoredResume": "full resume text optimized for ATS and this role",
  "coverNote": "short 120-180 word note or empty string",
  "keywordsEmphasized": ["..."],
  "changesSummary": "2-4 sentences on what you shifted vs base resume"
}
Rules:
- Preserve truthfulness; never invent employers, degrees, or metrics.
- Mirror high-value keywords from the JD when honestly supported by the base resume.
- Prefer clear section headings and scannable bullets.
- Keep tailoredResume complete enough to paste into an application.`,
    user: `BASE WORKING RESUME:
${(workingResume || '').slice(0, 10000)}

CANDIDATE PROFILE:
Skills: ${(profile.skills || []).join(', ') || '—'}
Keywords: ${(profile.experienceKeywords || []).join(', ') || '—'}
Salary floor (monthly USD): ${profile.salaryFloorUsd ?? '—'}
Notes: ${(profile.notes || '').slice(0, 500) || '—'}

JOB:
Title: ${job.title}
Company: ${job.company}
URL: ${job.url || '—'}
Category: ${job.category || '—'}
Domains: ${(job.domains || []).join(', ') || '—'}

JOB DESCRIPTION:
${jd}

Include cover note: ${includeCover ? 'yes' : 'no (set coverNote to "")'}`,
  };
}

/**
 * Domain-level rejection deep analysis.
 */
export function domainFailurePrompt({ domain, workingResume, applications, profile }) {
  const packs = applications.slice(0, 12).map((a, i) => {
    const jd = (a.jobDescription || '').trim();
    const jdBlock = jd
      ? `JOB DESCRIPTION (captured at apply):\n${jd.slice(0, 2500)}${jd.length > 2500 ? '\n…[truncated]' : ''}`
      : 'JOB DESCRIPTION: (not stored — rely on title/notes)';
    return `### App ${i + 1}
Title: ${a.title}
Company: ${a.company}
Status: ${a.status}
Domain: ${a.domain}
Applied: ${a.appliedAt ? new Date(a.appliedAt).toISOString().slice(0, 10) : '—'}
Notes: ${(a.notes || '').slice(0, 400) || '—'}
URL: ${a.url || '—'}
Tailored materials on file: ${a.tailoredResume ? 'yes' : 'no'}
${jdBlock}`;
  });

  return {
    system: `You are a rigorous career strategist analyzing rejection patterns for ONE domain.
Output strict JSON only (no markdown fences):
{
  "likelyReasons": ["...", "..."],
  "actionableAdjustments": [
    { "area": "keywords|framing|proof|positioning|other", "change": "...", "why": "..." }
  ],
  "revisedSections": "markdown of revised resume sections only (not necessarily full resume)",
  "fullWorkingResumeDraft": "optional full updated working resume if changes are broad, else empty string",
  "confidence": "low|medium|high",
  "summary": "4-6 sentence plain-language brief for the candidate"
}
Rules:
- Be specific to the domain and evidence given — especially job descriptions when present.
- Do not invent experience; only reframe or emphasize what is plausible from the resume.
- Prefer high-signal keyword and proof-point fixes over vague advice.
- Call out mismatches between JD language and the working resume.`,
    user: `DOMAIN UNDER REVIEW: ${domain}

PROFILE:
Skills: ${(profile.skills || []).join(', ')}
Preferred domains: ${(profile.preferredDomains || []).join(', ')}
Experience keywords: ${(profile.experienceKeywords || []).join(', ')}

WORKING RESUME:
${(workingResume || '').slice(0, 10000)}

APPLICATIONS & OUTCOMES (${applications.length} total, showing up to 12):
${packs.join('\n\n')}

Use job descriptions when available; otherwise titles, notes, and resume mismatch signals.`,
  };
}

/**
 * Optional: turn resume/profile into board search queries.
 */
export function huntQueriesPrompt({ profile, resumeText }) {
  return {
    system: `You design job-board search queries for remote roles.
Output strict JSON only:
{ "queries": ["3-8 short search strings"], "titles": ["likely job titles"], "rationale": "one sentence" }
Rules:
- Queries must be short (1-4 words) for Remotive/RemoteOK-style boards.
- Prefer concrete titles and tools (e.g. "data analyst", "SQL", "policy research").
- No company names. No location codes. Remote is already assumed.
- Do not invent skills not present in the resume/profile.`,
    user: `PROFILE skills: ${(profile?.skills || []).join(', ') || '—'}
Keywords: ${(profile?.experienceKeywords || []).join(', ') || '—'}
Domains: ${(profile?.preferredDomains || []).join(', ') || '—'}

RESUME (excerpt):
${(resumeText || '').slice(0, 6000)}`,
  };
}

/**
 * Structure a raw resume into plain text + profile fields for Bootstraps.
 */
export function parseResumePrompt({ resumeText }) {
  return {
    system: `You extract structured career data from a resume for a job-hunt app.
Output strict JSON only (no markdown fences):
{
  "plainResume": "clean plain-text resume, well sectioned, ATS-friendly, preserve ALL real facts",
  "headline": "short professional headline",
  "yearsExperience": null or number,
  "summary": "2-4 sentence professional summary",
  "profile": {
    "name": "",
    "skills": ["concrete skills/tools"],
    "experienceKeywords": ["role themes and domain keywords for job matching"],
    "preferredDomains": ["pick 2-5 from: Data Analysis, Strategy, Research, Web3/Blockchain, Marketing/BD, Hybrid, Product, Operations, Writing/Content, Other — or close labels"],
    "salaryFloorUsd": null,
    "salaryCeilingUsd": null,
    "dealBreakers": [],
    "remoteOnly": true,
    "notes": "contact lines, location, work authorization if present — short"
  }
}
Rules:
- NEVER invent employers, degrees, dates, or metrics not supported by the source text.
- plainResume must be complete enough to use as Master Resume (not a summary-only stub).
- skills: 8–25 high-signal items (tools, methods, languages).
- experienceKeywords: words that should match job postings (e.g. "SQL", "go-to-market", "due diligence").
- If salary not stated, leave salary fields null.
- remoteOnly true unless resume clearly requires on-site only.`,
    user: `RESUME SOURCE TEXT:
${(resumeText || '').slice(0, 24000)}

Return the JSON object now.`,
  };
}

/**
 * Parse model JSON even if wrapped in fences.
 */
export function parseModelJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}
