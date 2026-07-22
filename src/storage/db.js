/**
 * Bootstraps IndexedDB — resumes, jobs, applications, profile, AI usage.
 */

import {
  AI_DEFAULTS,
  DEFAULT_DOMAINS,
  REJECTION_THRESHOLDS,
} from '../config.js';

const DB_NAME = 'bootstraps';
const DB_VERSION = 1;

/** @type {IDBDatabase | null} */
let dbInstance = null;

export const DEFAULT_PROFILE = {
  name: '',
  skills: [], // string[]
  experienceKeywords: [],
  preferredDomains: ['Data Analysis', 'Strategy', 'Research'],
  salaryFloorUsd: 2000,
  salaryCeilingUsd: 3500,
  dealBreakers: ['unpaid', 'crypto-only pay', 'on-site only'],
  remoteOnly: true,
  notes: '',
};

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  llmBaseUrl: AI_DEFAULTS.baseUrl,
  llmApiKey: '',
  fastModel: AI_DEFAULTS.fastModel,
  deepModel: AI_DEFAULTS.deepModel,
  domains: DEFAULT_DOMAINS,
  rejectionMinApps: REJECTION_THRESHOLDS.minApplications,
  rejectionMinRejects: REJECTION_THRESHOLDS.minRejections,
  rejectionMaxInterviews: REJECTION_THRESHOLDS.maxInterviewsToFlag,
  rejectionWindowDays: REJECTION_THRESHOLDS.windowDays,
  remotiveCategory: 'data',
  lastJobFetchAt: 0,
  /** Donation / support links — shown in-app so users who land jobs can give back */
  supportGithubSponsors: 'https://github.com/sponsors',
  supportKofi: 'https://ko-fi.com',
  supportNote:
    'Bootstraps is free to use. If it helps you land a role (or even get interviews), please consider donating — it keeps the tool improving.',
};

function uuid() {
  return crypto.randomUUID();
}

function openDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onversionchange = () => {
        try {
          dbInstance?.close();
        } catch {
          /* */
        }
        dbInstance = null;
      };
      resolve(dbInstance);
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('profile')) {
        db.createObjectStore('profile', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('resumes')) {
        db.createObjectStore('resumes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('resumeHistory')) {
        const h = db.createObjectStore('resumeHistory', { keyPath: 'id' });
        h.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('jobs')) {
        const j = db.createObjectStore('jobs', { keyPath: 'id' });
        j.createIndex('source', 'source', { unique: false });
        j.createIndex('fetchedAt', 'fetchedAt', { unique: false });
        j.createIndex('score', 'score', { unique: false });
      }
      if (!db.objectStoreNames.contains('applications')) {
        const a = db.createObjectStore('applications', { keyPath: 'id' });
        a.createIndex('status', 'status', { unique: false });
        a.createIndex('appliedAt', 'appliedAt', { unique: false });
        a.createIndex('domain', 'domain', { unique: false });
      }
      if (!db.objectStoreNames.contains('usage')) {
        db.createObjectStore('usage', { keyPath: 'id' });
      }
    };
  });
}

function tx(names, mode = 'readonly') {
  return openDb().then((db) => db.transaction(names, mode));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── Settings & profile ─────────────────────────────────────

export async function getSettings() {
  const t = await tx(['settings']);
  const rows = await reqP(t.objectStore('settings').getAll());
  const map = { ...DEFAULT_SETTINGS };
  for (const row of rows) map[row.key] = row.value;
  if (!Array.isArray(map.domains) || !map.domains.length) map.domains = [...DEFAULT_DOMAINS];
  return map;
}

export async function setSettings(partial) {
  for (const [key, value] of Object.entries(partial)) {
    const t = await tx(['settings'], 'readwrite');
    await reqP(t.objectStore('settings').put({ key, value }));
  }
  return getSettings();
}

export async function getProfile() {
  const t = await tx(['profile']);
  const row = await reqP(t.objectStore('profile').get('main'));
  return row ? { ...DEFAULT_PROFILE, ...row.data } : { ...DEFAULT_PROFILE };
}

export async function setProfile(data) {
  const t = await tx(['profile'], 'readwrite');
  await reqP(t.objectStore('profile').put({ id: 'main', data: { ...DEFAULT_PROFILE, ...data } }));
  return getProfile();
}

// ── Resumes (master + working) ─────────────────────────────

/**
 * @typedef {{ id: string, role: 'master'|'working', title: string, body: string, updatedAt: number }} Resume
 */

export async function getResume(role) {
  const t = await tx(['resumes']);
  const all = await reqP(t.objectStore('resumes').getAll());
  return all.find((r) => r.role === role) || null;
}

export async function getBothResumes() {
  const t = await tx(['resumes']);
  const all = await reqP(t.objectStore('resumes').getAll());
  return {
    master: all.find((r) => r.role === 'master') || null,
    working: all.find((r) => r.role === 'working') || null,
  };
}

export async function saveResume(role, body, title = '') {
  const existing = await getResume(role);
  const now = Date.now();
  const record = {
    id: existing?.id || role,
    role,
    title: title || existing?.title || (role === 'master' ? 'Master Resume' : 'Working Resume'),
    body: body || '',
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };
  const t = await tx(['resumes'], 'readwrite');
  await reqP(t.objectStore('resumes').put(record));
  return record;
}

/** Seed working from master if working empty */
export async function ensureWorkingFromMaster() {
  const { master, working } = await getBothResumes();
  if (master?.body && (!working?.body || !working.body.trim())) {
    return saveResume('working', master.body, 'Working Resume');
  }
  return working;
}

/**
 * Append change to working-resume history.
 * @param {{ reason: string, domain?: string, applicationIds?: string[], before: string, after: string, source: string }} entry
 */
export async function addResumeHistory(entry) {
  const record = {
    id: uuid(),
    reason: entry.reason || '',
    domain: entry.domain || '',
    applicationIds: entry.applicationIds || [],
    before: entry.before || '',
    after: entry.after || '',
    source: entry.source || 'manual',
    createdAt: Date.now(),
  };
  const t = await tx(['resumeHistory'], 'readwrite');
  await reqP(t.objectStore('resumeHistory').put(record));
  return record;
}

export async function listResumeHistory(limit = 50) {
  const t = await tx(['resumeHistory']);
  const all = await reqP(t.objectStore('resumeHistory').getAll());
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
}

// ── Jobs ───────────────────────────────────────────────────

export async function putJob(job) {
  const now = Date.now();
  const record = {
    id: job.id || uuid(),
    title: job.title || 'Untitled',
    company: job.company || '',
    url: job.url || '',
    description: job.description || '',
    source: job.source || 'manual',
    externalId: job.externalId || '',
    category: job.category || '',
    domains: job.domains || [],
    salaryText: job.salaryText || '',
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    tags: job.tags || [],
    remote: job.remote !== false,
    score: job.score ?? 0,
    scoreBreakdown: job.scoreBreakdown || null,
    dismissed: !!job.dismissed,
    fetchedAt: job.fetchedAt || now,
    updatedAt: now,
  };
  const t = await tx(['jobs'], 'readwrite');
  await reqP(t.objectStore('jobs').put(record));
  return record;
}

export async function putJobsBulk(jobs) {
  const out = [];
  for (const j of jobs) out.push(await putJob(j));
  return out;
}

export async function listJobs(filter = {}) {
  const t = await tx(['jobs']);
  let all = await reqP(t.objectStore('jobs').getAll());
  if (filter.dismissed === false) all = all.filter((j) => !j.dismissed);
  if (filter.source) all = all.filter((j) => j.source === filter.source);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    all = all.filter(
      (j) =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.company || '').toLowerCase().includes(q) ||
        (j.description || '').toLowerCase().includes(q)
    );
  }
  return all.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.fetchedAt || 0) - (a.fetchedAt || 0));
}

export async function getJob(id) {
  const t = await tx(['jobs']);
  return reqP(t.objectStore('jobs').get(id));
}

export async function deleteJob(id) {
  const t = await tx(['jobs'], 'readwrite');
  await reqP(t.objectStore('jobs').delete(id));
}

export async function findJobByExternal(source, externalId) {
  if (!externalId) return null;
  const all = await listJobs({});
  return all.find((j) => j.source === source && j.externalId === String(externalId)) || null;
}

// ── Applications ───────────────────────────────────────────

export async function putApplication(app) {
  const now = Date.now();
  const record = {
    id: app.id || uuid(),
    jobId: app.jobId || null,
    title: app.title || '',
    company: app.company || '',
    url: app.url || '',
    domain: app.domain || 'Other',
    tags: app.tags || [],
    status: app.status || 'Applied',
    notes: app.notes || '',
    tailoredResume: app.tailoredResume || '',
    coverNote: app.coverNote || '',
    resumeBase: app.resumeBase || 'working', // which version used
    appliedAt: app.appliedAt || now,
    updatedAt: now,
    statusHistory: app.statusHistory || [{ status: app.status || 'Applied', at: now }],
  };
  const t = await tx(['applications'], 'readwrite');
  await reqP(t.objectStore('applications').put(record));
  return record;
}

export async function getApplication(id) {
  const t = await tx(['applications']);
  return reqP(t.objectStore('applications').get(id));
}

export async function listApplications(filter = {}) {
  const t = await tx(['applications']);
  let all = await reqP(t.objectStore('applications').getAll());
  if (filter.status) all = all.filter((a) => a.status === filter.status);
  if (filter.domain) all = all.filter((a) => a.domain === filter.domain);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    all = all.filter(
      (a) =>
        (a.title || '').toLowerCase().includes(q) ||
        (a.company || '').toLowerCase().includes(q) ||
        (a.notes || '').toLowerCase().includes(q)
    );
  }
  return all.sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));
}

export async function updateApplication(id, patch) {
  const existing = await getApplication(id);
  if (!existing) throw new Error('Application not found');
  const next = { ...existing, ...patch, id };
  if (patch.status && patch.status !== existing.status) {
    next.statusHistory = [
      ...(existing.statusHistory || []),
      { status: patch.status, at: Date.now() },
    ];
  }
  next.updatedAt = Date.now();
  return putApplication(next);
}

export async function deleteApplication(id) {
  const t = await tx(['applications'], 'readwrite');
  await reqP(t.objectStore('applications').delete(id));
}

// ── AI usage ledger ────────────────────────────────────────

export async function recordUsage(entry) {
  const record = {
    id: uuid(),
    tier: entry.tier || 'fast',
    model: entry.model || '',
    purpose: entry.purpose || '',
    promptTokens: entry.promptTokens || 0,
    completionTokens: entry.completionTokens || 0,
    totalTokens: entry.totalTokens || 0,
    estCostUsd: entry.estCostUsd || 0,
    createdAt: Date.now(),
  };
  const t = await tx(['usage'], 'readwrite');
  await reqP(t.objectStore('usage').put(record));
  return record;
}

export async function getUsageSummary() {
  const t = await tx(['usage']);
  const all = await reqP(t.objectStore('usage').getAll());
  const totalTokens = all.reduce((s, r) => s + (r.totalTokens || 0), 0);
  const estCostUsd = all.reduce((s, r) => s + (r.estCostUsd || 0), 0);
  return {
    calls: all.length,
    totalTokens,
    estCostUsd,
    recent: all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20),
  };
}

export async function exportAllData() {
  const [settings, profile, resumes, history, jobs, applications, usage] = await Promise.all([
    getSettings(),
    getProfile(),
    getBothResumes(),
    listResumeHistory(200),
    listJobs({}),
    listApplications({}),
    getUsageSummary(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    app: 'bootstraps',
    settings: { ...settings, llmApiKey: settings.llmApiKey ? '[redacted]' : '' },
    profile,
    resumes,
    resumeHistory: history,
    jobs,
    applications,
    usage,
  };
}

export { openDb, uuid };
