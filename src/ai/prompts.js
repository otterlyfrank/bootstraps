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
    return `### App ${i + 1}
Title: ${a.title}
Company: ${a.company}
Status: ${a.status}
Domain: ${a.domain}
Applied: ${a.appliedAt ? new Date(a.appliedAt).toISOString().slice(0, 10) : '—'}
Notes: ${(a.notes || '').slice(0, 400) || '—'}
URL: ${a.url || '—'}
JD excerpt (if stored in notes/tailored unused): ${(a.tailoredResume || '').slice(0, 200) ? '[tailored on file]' : '—'}`;
  });

  // Prefer attaching short JD from notes field conventions — keep compact
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
- Be specific to the domain and evidence given.
- Do not invent experience; only reframe or emphasize what is plausible from the resume.
- Prefer high-signal keyword and proof-point fixes over vague advice.`,
    user: `DOMAIN UNDER REVIEW: ${domain}

PROFILE:
Skills: ${(profile.skills || []).join(', ')}
Preferred domains: ${(profile.preferredDomains || []).join(', ')}
Experience keywords: ${(profile.experienceKeywords || []).join(', ')}

WORKING RESUME:
${(workingResume || '').slice(0, 10000)}

APPLICATIONS & OUTCOMES (${applications.length} total, showing up to 12):
${packs.join('\n\n')}

Job description text may be limited; use titles, notes, and resume mismatch signals.`,
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
