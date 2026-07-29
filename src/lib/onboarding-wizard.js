/**
 * First-run wizard steps (UI strings + completion checks).
 */

export function wizardSteps(state) {
  const hasKey = !!(state.settings?.llmApiKey || '').trim();
  const hasResume = !!(state.working?.body || state.master?.body || '').trim();
  const hasJobs = (state.jobs || []).length > 0;
  const hasApp = (state.applications || []).length > 0;
  return [
    {
      id: 'api',
      title: 'Connect Grok (optional but recommended)',
      body: 'Powers resume structuring, prep polish, and domain analysis. Board hunts work without it.',
      done: hasKey,
      cta: 'Open Settings',
      view: 'settings',
    },
    {
      id: 'resume',
      title: 'Upload your resume',
      body: 'PDF or DOCX → Master + Working + Profile skills/keywords for matching.',
      done: hasResume,
      cta: 'Upload resume',
      view: 'resumes',
      action: 'upload',
    },
    {
      id: 'hunt',
      title: 'Run Hunt from resume',
      body: 'Pull public remote boards with queries from your profile, then score every role.',
      done: hasJobs,
      cta: 'Start hunt',
      view: 'jobs',
      action: 'hunt',
    },
    {
      id: 'apply',
      title: 'Prepare or shortlist one role',
      body: 'Star a shortlist item or Prepare a top match — then log apply with a follow-up date.',
      done: hasApp || (state.jobs || []).some((j) => j.shortlisted),
      cta: 'Open job board',
      view: 'jobs',
    },
  ];
}

export function wizardComplete(state) {
  if (state.settings?.onboardingDone) return true;
  return wizardSteps(state).every((s) => s.done);
}
