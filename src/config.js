/**
 * Bootstraps configuration — model selection, thresholds, prompt knobs.
 * Edit freely; all values are client-side only.
 */

/** @typedef {'fast' | 'deep'} ModelTier */

export const APP_NAME = 'Bootstraps';
export const APP_TAGLINE = 'Pull yourself up—then keep climbing';

/** xAI / OpenAI-compatible endpoint defaults */
export const AI_DEFAULTS = {
  baseUrl: 'https://api.x.ai/v1',
  /** Routine: tailored resume, light notes */
  fastModel: 'grok-4-1-fast-non-reasoning',
  /** Domain rejection analysis & major rewrites */
  deepModel: 'grok-4-1-fast-reasoning',
  /** Fallback labels if models change */
  fastLabel: 'Fast / cheap',
  deepLabel: 'Deep analysis',
};

/**
 * Rough USD per 1M tokens (display only — update as pricing changes).
 * Used for cumulative cost awareness, not billing.
 */
export const TOKEN_COST_USD = {
  inputPer1M: 0.2,
  outputPer1M: 0.5,
};

/** Matching weights (must sum ~1 for readability; score is 0–100) */
export const MATCH_WEIGHTS = {
  skillOverlap: 0.35,
  keywordOverlap: 0.3,
  domainBoost: 0.15,
  salaryFit: 0.1,
  remoteFit: 0.1,
};

/** Rejection density: flag domain when... */
export const REJECTION_THRESHOLDS = {
  /** Minimum applications in window before evaluating */
  minApplications: 3,
  /** Rejections + ghosted count to worry */
  minRejections: 3,
  /** If interviews (or offers) below this while rejections high → flag */
  maxInterviewsToFlag: 0,
  /** Days to look back for density (0 = all time) */
  windowDays: 60,
};

/** Recommended digest size */
export const DIGEST_SIZE = { min: 4, max: 8 };

/** Pre-seed domain tags */
export const DEFAULT_DOMAINS = [
  'Data Analysis',
  'Strategy',
  'Research',
  'Web3/Blockchain',
  'Marketing/BD',
  'Hybrid',
  'Product',
  'Operations',
  'Writing/Content',
  'Other',
];

export const APPLICATION_STATUSES = [
  'Applied',
  'Interview',
  'Rejected',
  'Ghosted',
  'Offer',
  'Withdrawn',
];

/** Remotive public API (no key). Categories map roughly to remotive slugs. */
export const REMOTIVE_API = 'https://remotive.com/api/remote-jobs';
export const REMOTIVE_CATEGORIES = [
  { id: '', label: 'All categories' },
  { id: 'data', label: 'Data' },
  { id: 'business', label: 'Business' },
  { id: 'product', label: 'Product' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'software-dev', label: 'Software Dev' },
  { id: 'writing', label: 'Writing' },
  { id: 'customer-support', label: 'Customer Support' },
  { id: 'finance-legal', label: 'Finance / Legal' },
  { id: 'hr', label: 'HR' },
  { id: 'design', label: 'Design' },
  { id: 'devops', label: 'DevOps' },
  { id: 'qa', label: 'QA' },
];
