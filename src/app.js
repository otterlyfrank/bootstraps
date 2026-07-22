/**
 * Compound — presentation layer
 */

import {
  APP_NAME,
  APPLICATION_STATUSES,
  DIGEST_SIZE,
  REMOTIVE_CATEGORIES,
  AI_DEFAULTS,
} from './config.js';
import {
  getSettings,
  setSettings,
  getProfile,
  setProfile,
  getBothResumes,
  saveResume,
  ensureWorkingFromMaster,
  addResumeHistory,
  listResumeHistory,
  listJobs,
  putJob,
  listApplications,
  putApplication,
  updateApplication,
  deleteApplication,
  getUsageSummary,
  exportAllData,
} from './storage/db.js';
import { syncRemotive, normalizeManual, rescoreAllJobs } from './jobs/sources.js';
import { scoreJob, buildDigest, inferDomains } from './jobs/match.js';
import { domainPerformance, appsForDomain } from './jobs/learning.js';
import { chatCompletion, checkLlm, formatUsd } from './ai/client.js';
import { prepareApplicationPrompt, domainFailurePrompt, parseModelJson } from './ai/prompts.js';
import {
  downloadText,
  downloadJson,
  formatDate,
  applicationsToMarkdown,
  resumesToMarkdown,
} from './lib/export.js';

/** @type {any} */
let state = {
  view: 'dashboard',
  settings: null,
  profile: null,
  master: null,
  working: null,
  jobs: [],
  applications: [],
  history: [],
  usage: { calls: 0, totalTokens: 0, estCostUsd: 0 },
  jobQ: '',
  appFilter: 'all',
  appDomain: '',
  busy: false,
};

let rootEl = null;

export async function mountApp(root) {
  rootEl = root;
  await reloadAll();
  render();
}

async function reloadAll() {
  state.settings = await getSettings();
  state.profile = await getProfile();
  const resumes = await getBothResumes();
  state.master = resumes.master;
  state.working = resumes.working;
  await ensureWorkingFromMaster();
  const resumes2 = await getBothResumes();
  state.master = resumes2.master;
  state.working = resumes2.working;
  state.jobs = await listJobs({ dismissed: false });
  state.applications = await listApplications({});
  state.history = await listResumeHistory(40);
  state.usage = await getUsageSummary();
  applyTheme(state.settings.theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function $(sel, r = document) {
  return r.querySelector(sel);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, kind = '') {
  let host = $('#toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3400);
}

function resumeBody() {
  return state.working?.body || state.master?.body || '';
}

function thresholds() {
  const s = state.settings;
  return {
    minApplications: s.rejectionMinApps,
    minRejections: s.rejectionMinRejects,
    maxInterviewsToFlag: s.rejectionMaxInterviews,
    windowDays: s.rejectionWindowDays,
  };
}

function domainStats() {
  return domainPerformance(state.applications, thresholds());
}

function appliedJobIds() {
  return new Set(state.applications.map((a) => a.jobId).filter(Boolean));
}

// ── Shell ──────────────────────────────────────────────────

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <h1>${APP_NAME}</h1>
        <p>Hunt · learn · compound</p>
      </div>
      ${navBtn('dashboard', 'Dashboard')}
      ${navBtn('digest', 'Recommended')}
      ${navBtn('jobs', 'Job board')}
      ${navBtn('applications', 'Applications')}
      ${navBtn('resumes', 'Resumes')}
      ${navBtn('domains', 'Domain intel')}
      ${navBtn('profile', 'Profile')}
      ${navBtn('settings', 'Settings')}
      <div class="sidebar-foot">
        <p>Local-first · optional Grok</p>
        <p class="usage-chip" style="display:inline-block;margin-top:0.35rem">
          AI ~${formatUsd(state.usage.estCostUsd)} · ${state.usage.totalTokens || 0} tok
        </p>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <h2>${esc(viewTitle())}</h2>
        <div class="topbar-actions" id="top-actions"></div>
      </header>
      <div class="content" id="view-root"></div>
    </div>
  `;
  rootEl.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.onclick = async () => {
      state.view = btn.dataset.nav;
      await reloadAll();
      render();
    };
  });
  const root = $('#view-root');
  const actions = $('#top-actions');
  const map = {
    dashboard: renderDashboard,
    digest: renderDigest,
    jobs: renderJobs,
    applications: renderApplications,
    resumes: renderResumes,
    domains: renderDomains,
    profile: renderProfile,
    settings: renderSettings,
  };
  (map[state.view] || renderDashboard)(root, actions);
}

function navBtn(id, label) {
  return `<button type="button" class="nav-btn ${state.view === id ? 'active' : ''}" data-nav="${id}">${label}</button>`;
}

function viewTitle() {
  const t = {
    dashboard: 'Dashboard',
    digest: 'Recommended applications',
    jobs: 'Job board',
    applications: 'Applications',
    resumes: 'Dual resumes',
    domains: 'Domain intelligence',
    profile: 'Profile & targeting',
    settings: 'Settings',
  };
  return t[state.view] || 'Compound';
}

// ── Dashboard ──────────────────────────────────────────────

function renderDashboard(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="d-fetch">Fetch Remotive</button>
    <button type="button" class="btn primary" id="d-digest">Open digest</button>
  `;
  const stats = domainStats();
  const flagged = stats.filter((d) => d.flagged);
  const apps = state.applications;
  const counts = {
    applied: apps.filter((a) => a.status === 'Applied').length,
    interview: apps.filter((a) => a.status === 'Interview').length,
    rejected: apps.filter((a) => a.status === 'Rejected').length,
    offer: apps.filter((a) => a.status === 'Offer').length,
  };
  const digest = buildDigest(state.jobs, appliedJobIds(), DIGEST_SIZE);

  root.innerHTML = `
    ${
      !resumeBody().trim()
        ? `<div class="banner warn">
            <h3>Start with your Master Resume</h3>
            <p class="muted" style="margin:0">Paste your base resume under <strong>Resumes</strong>. The Working copy evolves from outcomes; Master stays clean.</p>
          </div>`
        : ''
    }
    ${
      flagged.length
        ? `<div class="banner warn">
            <h3>High rejection density</h3>
            <p class="muted" style="margin:0 0 0.5rem">${flagged
              .map((f) => `<strong>${esc(f.domain)}</strong>: ${esc(f.reason)}`)
              .join('<br/>')}</p>
            <button type="button" class="btn primary" id="go-domains">Review domain intel</button>
          </div>`
        : ''
    }
    <div class="stat-row">
      <div class="stat"><div class="n">${apps.length}</div><div class="l">Applications</div></div>
      <div class="stat"><div class="n">${counts.interview}</div><div class="l">Interviews</div></div>
      <div class="stat"><div class="n">${counts.rejected}</div><div class="l">Rejected</div></div>
      <div class="stat"><div class="n">${counts.offer}</div><div class="l">Offers</div></div>
      <div class="stat"><div class="n">${state.jobs.length}</div><div class="l">Jobs scored</div></div>
      <div class="stat"><div class="n">${digest.length}</div><div class="l">Digest picks</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3>This week’s play</h3>
        <ol class="muted" style="margin:0;padding-left:1.2rem;line-height:1.65">
          <li>Fetch or add roles that match your floor (~$${state.profile.salaryFloorUsd || 2000}/mo remote)</li>
          <li>Work the <strong>Recommended</strong> digest (4–8 high-fit)</li>
          <li>Log outcomes honestly — ghosts count</li>
          <li>When a domain flags, run <strong>Deep Analysis</strong> and update Working Resume</li>
        </ol>
      </div>
      <div class="card">
        <h3>Resume status</h3>
        <p class="muted" style="margin:0">
          <span class="tag master">Master</span> ${state.master?.body ? `${state.master.body.length} chars · ${formatDate(state.master.updatedAt)}` : 'empty'}
        </p>
        <p class="muted" style="margin:0.5rem 0 0">
          <span class="tag working">Working</span> ${state.working?.body ? `${state.working.body.length} chars · ${formatDate(state.working.updatedAt)}` : 'empty'}
        </p>
        <p class="dim" style="margin:0.75rem 0 0">${state.history.length} improvement events logged</p>
      </div>
    </div>
    <h3 style="font-family:var(--serif);margin:1.25rem 0 0.6rem">Top matches</h3>
    <div class="job-list">
      ${
        digest.length
          ? digest
              .slice(0, 5)
              .map((j) => jobCardHtml(j, { compact: true }))
              .join('')
          : `<div class="empty"><h3>No ranked jobs yet</h3><p>Fetch Remotive or add a job manually.</p></div>`
      }
    </div>
  `;
  $('#d-fetch').onclick = () => fetchJobs();
  $('#d-digest').onclick = () => {
    state.view = 'digest';
    render();
  };
  $('#go-domains')?.addEventListener('click', () => {
    state.view = 'domains';
    render();
  });
  bindJobCards(root);
}

// ── Digest ─────────────────────────────────────────────────

function renderDigest(root, actions) {
  actions.innerHTML = `<button type="button" class="btn primary" id="dig-refresh">Refresh scores</button>`;
  const digest = buildDigest(state.jobs, appliedJobIds(), DIGEST_SIZE);
  root.innerHTML = `
    <p class="muted" style="margin-top:0">High-fit opportunities vs your <strong>Working Resume</strong> + profile. Aim for ${DIGEST_SIZE.min}–${DIGEST_SIZE.max} applications with intent, not spray.</p>
    <div class="job-list">
      ${
        digest.length
          ? digest.map((j) => jobCardHtml(j)).join('')
          : `<div class="empty"><h3>Digest empty</h3><p>Fetch jobs or loosen deal-breakers / skills in Profile.</p></div>`
      }
    </div>
  `;
  $('#dig-refresh').onclick = async () => {
    await rescoreAllJobs(await listJobs({}), state.profile, resumeBody());
    await reloadAll();
    toast('Rescored', 'ok');
    render();
  };
  bindJobCards(root);
}

// ── Jobs ───────────────────────────────────────────────────

function renderJobs(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="j-manual">Add manual</button>
    <button type="button" class="btn primary" id="j-fetch">Fetch Remotive</button>
  `;
  let jobs = state.jobs;
  if (state.jobQ) {
    const q = state.jobQ.toLowerCase();
    jobs = jobs.filter(
      (j) =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.company || '').toLowerCase().includes(q)
    );
  }
  root.innerHTML = `
    <div class="filter-row">
      <input class="search" id="job-q" placeholder="Search jobs…" value="${esc(state.jobQ)}" />
      <select id="job-cat" style="max-width:12rem">
        ${REMOTIVE_CATEGORIES.map(
          (c) =>
            `<option value="${esc(c.id)}" ${state.settings.remotiveCategory === c.id ? 'selected' : ''}>${esc(c.label)}</option>`
        ).join('')}
      </select>
      <span class="dim">${jobs.length} shown</span>
    </div>
    <div class="job-list">
      ${
        jobs.length
          ? jobs.map((j) => jobCardHtml(j)).join('')
          : `<div class="empty"><h3>No jobs yet</h3><p>Fetch from Remotive (high-signal remote board) or add manually. WWR etc. via manual entry for now.</p></div>`
      }
    </div>
  `;
  $('#j-fetch').onclick = () => fetchJobs();
  $('#j-manual').onclick = () => openManualJob();
  $('#job-q').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      state.jobQ = e.target.value.trim();
      render();
    }
  });
  $('#job-cat').onchange = async (e) => {
    state.settings = await setSettings({ remotiveCategory: e.target.value });
  };
  bindJobCards(root);
}

function scoreClass(score) {
  if (score >= 60) return '';
  if (score >= 40) return 'mid';
  return 'low';
}

function jobCardHtml(j, { compact } = {}) {
  const domains = (j.domains || []).map((d) => `<span class="tag">${esc(d)}</span>`).join('');
  const desc = compact
    ? ''
    : `<p class="dim" style="margin:0.4rem 0 0;grid-column:1/-1">${esc((j.description || '').slice(0, 220))}${(j.description || '').length > 220 ? '…' : ''}</p>`;
  return `
    <article class="job-card" data-job-id="${j.id}">
      <div>
        <h3>${esc(j.title)}</h3>
        <div class="job-meta">${esc(j.company)} · ${esc(j.source)} · ${formatDate(j.fetchedAt)}</div>
        <div style="margin-top:0.35rem">${domains}<span class="tag">${esc(j.category || '—')}</span></div>
        ${desc}
      </div>
      <div class="row-actions" style="flex-direction:column;align-items:flex-end">
        <span class="score-pill ${scoreClass(j.score || 0)}" title="Match score">${j.score ?? 0}</span>
        <div class="row-actions" style="margin-top:0.4rem">
          <button type="button" class="btn primary" data-prepare="${j.id}">Prepare</button>
          <button type="button" class="btn" data-apply="${j.id}">Log apply</button>
          ${j.url ? `<a class="btn ghost" href="${esc(j.url)}" target="_blank" rel="noopener">Open</a>` : ''}
          <button type="button" class="btn ghost" data-dismiss="${j.id}">Hide</button>
        </div>
      </div>
    </article>`;
}

function bindJobCards(root) {
  root.querySelectorAll('[data-prepare]').forEach((btn) => {
    btn.onclick = () => prepareForJob(btn.dataset.prepare);
  });
  root.querySelectorAll('[data-apply]').forEach((btn) => {
    btn.onclick = () => logApplyFromJob(btn.dataset.apply);
  });
  root.querySelectorAll('[data-dismiss]').forEach((btn) => {
    btn.onclick = async () => {
      const job = state.jobs.find((j) => j.id === btn.dataset.dismiss);
      if (!job) return;
      await putJob({ ...job, dismissed: true });
      await reloadAll();
      render();
    };
  });
}

async function fetchJobs() {
  if (state.busy) return;
  state.busy = true;
  toast('Fetching Remotive…');
  try {
    const cat = state.settings.remotiveCategory || '';
    const result = await syncRemotive(
      { category: cat || undefined, limit: 50 },
      state.profile,
      resumeBody(),
      state.settings.domains
    );
    await setSettings({ lastJobFetchAt: Date.now() });
    await reloadAll();
    toast(`Jobs: +${result.added} new · ${result.updated} refreshed`, 'ok');
    render();
  } catch (err) {
    toast(err.message || String(err), 'err');
  } finally {
    state.busy = false;
  }
}

function openManualJob() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Add job manually</h2>
      <p class="muted">For We Work Remotely, company sites, referrals, etc.</p>
      <div class="field"><label>Title</label><input id="m-title" /></div>
      <div class="field"><label>Company</label><input id="m-company" /></div>
      <div class="field"><label>URL</label><input id="m-url" placeholder="https://" /></div>
      <div class="field"><label>Domain</label>
        <select id="m-domain">${(state.settings.domains || []).map((d) => `<option>${esc(d)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Salary note</label><input id="m-sal" placeholder="e.g. $2.5–3k/mo" /></div>
      <div class="field"><label>Description / JD</label><textarea id="m-desc" rows="8"></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="m-cancel">Cancel</button>
        <button type="button" class="btn primary" id="m-save">Save & score</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#m-cancel', backdrop).onclick = close;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  $('#m-save', backdrop).onclick = async () => {
    const raw = normalizeManual({
      title: $('#m-title', backdrop).value,
      company: $('#m-company', backdrop).value,
      url: $('#m-url', backdrop).value,
      description: $('#m-desc', backdrop).value,
      salaryText: $('#m-sal', backdrop).value,
      domains: [$('#m-domain', backdrop).value],
    });
    if (!raw.title) {
      toast('Title required', 'err');
      return;
    }
    const domains = raw.domains?.length
      ? raw.domains
      : inferDomains(raw, state.profile.preferredDomains);
    const { score, breakdown, domains: d2 } = scoreJob(
      { ...raw, domains },
      state.profile,
      resumeBody()
    );
    await putJob({ ...raw, domains: d2, score, scoreBreakdown: breakdown });
    close();
    await reloadAll();
    toast('Job added', 'ok');
    render();
  };
}

// ── Applications ───────────────────────────────────────────

function renderApplications(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="a-export">Export MD</button>
    <button type="button" class="btn primary" id="a-new">Log application</button>
  `;
  let apps = state.applications;
  if (state.appFilter !== 'all') apps = apps.filter((a) => a.status === state.appFilter);
  if (state.appDomain) apps = apps.filter((a) => a.domain === state.appDomain);

  root.innerHTML = `
    <div class="filter-row">
      <button type="button" class="chip ${state.appFilter === 'all' ? 'active' : ''}" data-st="all">All</button>
      ${APPLICATION_STATUSES.map(
        (s) =>
          `<button type="button" class="chip ${state.appFilter === s ? 'active' : ''}" data-st="${esc(s)}">${esc(s)}</button>`
      ).join('')}
      <select id="a-dom" style="max-width:11rem">
        <option value="">All domains</option>
        ${(state.settings.domains || [])
          .map((d) => `<option value="${esc(d)}" ${state.appDomain === d ? 'selected' : ''}>${esc(d)}</option>`)
          .join('')}
      </select>
    </div>
    <div class="app-list">
      ${
        apps.length
          ? apps.map((a) => appCardHtml(a)).join('')
          : `<div class="empty"><h3>No applications logged</h3><p>Log from a job card or add manually. Outcomes feed the learning loop.</p></div>`
      }
    </div>
  `;
  $('#a-new').onclick = () => openAppEditor(null);
  $('#a-export').onclick = () => {
    downloadText('compound-applications.md', applicationsToMarkdown(state.applications), 'text/markdown');
    toast('Exported', 'ok');
  };
  root.querySelectorAll('[data-st]').forEach((btn) => {
    btn.onclick = () => {
      state.appFilter = btn.dataset.st;
      render();
    };
  });
  $('#a-dom').onchange = (e) => {
    state.appDomain = e.target.value;
    render();
  };
  root.querySelectorAll('[data-edit-app]').forEach((btn) => {
    btn.onclick = () => openAppEditor(btn.dataset.editApp);
  });
  root.querySelectorAll('[data-del-app]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this application log?')) return;
      await deleteApplication(btn.dataset.delApp);
      await reloadAll();
      render();
    };
  });
}

function appCardHtml(a) {
  return `
    <article class="job-card">
      <div>
        <h3>${esc(a.title)}</h3>
        <div class="job-meta">${esc(a.company)} · ${formatDate(a.appliedAt)} · base: ${esc(a.resumeBase || 'working')}</div>
        <div style="margin-top:0.35rem">
          <span class="tag">${esc(a.status)}</span>
          <span class="tag">${esc(a.domain)}</span>
        </div>
        ${a.notes ? `<p class="dim" style="margin:0.4rem 0 0">${esc(a.notes.slice(0, 180))}</p>` : ''}
      </div>
      <div class="row-actions" style="flex-direction:column;align-items:flex-end">
        ${a.url ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener">URL</a>` : ''}
        <button type="button" class="btn" data-edit-app="${a.id}">Update</button>
        <button type="button" class="btn danger" data-del-app="${a.id}">Delete</button>
      </div>
    </article>`;
}

function openAppEditor(id) {
  const existing = id ? state.applications.find((a) => a.id === id) : null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>${existing ? 'Update application' : 'Log application'}</h2>
      <div class="field"><label>Title</label><input id="ap-title" value="${esc(existing?.title || '')}" /></div>
      <div class="field"><label>Company</label><input id="ap-company" value="${esc(existing?.company || '')}" /></div>
      <div class="field"><label>URL</label><input id="ap-url" value="${esc(existing?.url || '')}" /></div>
      <div class="grid-2">
        <div class="field"><label>Domain</label>
          <select id="ap-domain">
            ${(state.settings.domains || [])
              .map(
                (d) =>
                  `<option value="${esc(d)}" ${existing?.domain === d ? 'selected' : ''}>${esc(d)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="field"><label>Status</label>
          <select id="ap-status">
            ${APPLICATION_STATUSES.map(
              (s) =>
                `<option value="${esc(s)}" ${existing?.status === s ? 'selected' : ''}>${esc(s)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label>Notes</label><textarea id="ap-notes" rows="4">${esc(existing?.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="ap-cancel">Cancel</button>
        <button type="button" class="btn primary" id="ap-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#ap-cancel', backdrop).onclick = close;
  $('#ap-save', backdrop).onclick = async () => {
    const payload = {
      title: $('#ap-title', backdrop).value.trim(),
      company: $('#ap-company', backdrop).value.trim(),
      url: $('#ap-url', backdrop).value.trim(),
      domain: $('#ap-domain', backdrop).value,
      status: $('#ap-status', backdrop).value,
      notes: $('#ap-notes', backdrop).value,
    };
    if (!payload.title) {
      toast('Title required', 'err');
      return;
    }
    if (existing) await updateApplication(existing.id, payload);
    else await putApplication({ ...payload, resumeBase: 'working' });
    close();
    await reloadAll();
    toast('Saved', 'ok');
    render();
  };
}

async function logApplyFromJob(jobId) {
  const job = state.jobs.find((j) => j.id === jobId) || (await listJobs({})).find((j) => j.id === jobId);
  if (!job) return;
  const domain = (job.domains && job.domains[0]) || 'Other';
  await putApplication({
    jobId: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    domain,
    status: 'Applied',
    notes: '',
    resumeBase: 'working',
  });
  await reloadAll();
  toast('Logged as Applied', 'ok');
  state.view = 'applications';
  render();
}

// ── Prepare application (Grok fast) ────────────────────────

async function prepareForJob(jobId) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (!resumeBody().trim()) {
    toast('Add a Working (or Master) resume first', 'err');
    state.view = 'resumes';
    render();
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Prepare application</h2>
      <p class="muted">${esc(job.title)} · ${esc(job.company)}</p>
      <p class="dim">Base: <span class="tag working">Working Resume</span> · Model: ${esc(state.settings.fastModel || AI_DEFAULTS.fastModel)} (fast)</p>
      <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
        <input type="checkbox" id="p-cover" checked /> Short cover note
      </label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="p-cancel">Cancel</button>
        <button type="button" class="btn primary" id="p-run">Generate with Grok</button>
      </div>
      <div id="p-out" hidden>
        <div class="field" style="margin-top:1rem"><label>Tailored resume</label><textarea id="p-resume" rows="14"></textarea></div>
        <div class="field"><label>Cover note</label><textarea id="p-note" rows="5"></textarea></div>
        <p class="dim" id="p-summary"></p>
        <div class="modal-actions">
          <button type="button" class="btn" id="p-copy">Copy resume</button>
          <button type="button" class="btn primary" id="p-log">Save to application log</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#p-cancel', backdrop).onclick = close;

  $('#p-run', backdrop).onclick = async () => {
    const includeCover = $('#p-cover', backdrop).checked;
    const { system, user } = prepareApplicationPrompt({
      workingResume: resumeBody(),
      job,
      profile: state.profile,
      includeCover,
    });
    $('#p-run', backdrop).disabled = true;
    $('#p-run', backdrop).textContent = 'Generating…';
    try {
      const { content } = await chatCompletion({
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
        model: state.settings.fastModel || AI_DEFAULTS.fastModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        purpose: 'prepare_application',
        tier: 'fast',
      });
      const parsed = parseModelJson(content);
      $('#p-out', backdrop).hidden = false;
      $('#p-resume', backdrop).value = parsed.tailoredResume || content;
      $('#p-note', backdrop).value = parsed.coverNote || '';
      $('#p-summary', backdrop).textContent =
        parsed.changesSummary ||
        (parsed.keywordsEmphasized || []).join(', ') ||
        'Generated.';
      state.usage = await getUsageSummary();
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      $('#p-run', backdrop).disabled = false;
      $('#p-run', backdrop).textContent = 'Generate with Grok';
    }
  };

  $('#p-copy', backdrop)?.addEventListener('click', async () => {
    const t = $('#p-resume', backdrop)?.value || '';
    await navigator.clipboard.writeText(t);
    toast('Copied', 'ok');
  });

  // event delegation after generate creates buttons - bind on backdrop
  backdrop.addEventListener('click', async (e) => {
    const t = e.target;
    if (t?.id === 'p-copy') {
      await navigator.clipboard.writeText($('#p-resume', backdrop).value || '');
      toast('Copied', 'ok');
    }
    if (t?.id === 'p-log') {
      const domain = (job.domains && job.domains[0]) || 'Other';
      await putApplication({
        jobId: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        domain,
        status: 'Applied',
        notes: 'Prepared via Compound',
        tailoredResume: $('#p-resume', backdrop).value,
        coverNote: $('#p-note', backdrop).value,
        resumeBase: 'working',
      });
      close();
      await reloadAll();
      toast('Saved to applications', 'ok');
      state.view = 'applications';
      render();
    }
  });
}

// ── Resumes ────────────────────────────────────────────────

function renderResumes(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="r-export">Export MD</button>
    <button type="button" class="btn" id="r-clone">Working ← Master</button>
  `;
  root.innerHTML = `
    <p class="muted" style="margin-top:0">
      <span class="tag master">Master</span> stable reference ·
      <span class="tag working">Working</span> evolves from rejections & accepted suggestions
    </p>
    <div class="grid-2">
      <div class="resume-panel master">
        <header>
          <h3>Master / Default</h3>
          <button type="button" class="btn primary" id="save-master">Save master</button>
        </header>
        <div class="body">
          <textarea class="resume-editor" id="master-body" placeholder="Paste your clean base resume…">${esc(state.master?.body || '')}</textarea>
        </div>
      </div>
      <div class="resume-panel working">
        <header>
          <h3>Working / Improved</h3>
          <button type="button" class="btn primary" id="save-working">Save working</button>
        </header>
        <div class="body">
          <textarea class="resume-editor" id="working-body" placeholder="Living resume used for matching & prep…">${esc(state.working?.body || '')}</textarea>
        </div>
      </div>
    </div>
    <h3 style="font-family:var(--serif);margin:1.25rem 0 0.6rem">Improvement history</h3>
    <div id="hist">
      ${
        state.history.length
          ? state.history
              .map(
                (h) => `
        <div class="history-item">
          <div class="job-meta">${formatDate(h.createdAt)} · ${esc(h.source)} ${h.domain ? '· ' + esc(h.domain) : ''}</div>
          <div>${esc(h.reason)}</div>
        </div>`
              )
              .join('')
          : `<p class="dim">No changes yet. Domain analysis acceptances and manual Working edits (with reason) will appear here.</p>`
      }
    </div>
  `;
  $('#save-master').onclick = async () => {
    const body = $('#master-body').value;
    state.master = await saveResume('master', body);
    toast('Master saved', 'ok');
    await reloadAll();
  };
  $('#save-working').onclick = async () => {
    const before = state.working?.body || '';
    const body = $('#working-body').value;
    if (body !== before) {
      const reason = prompt('What changed / why? (optional history note)', 'Manual edit') || 'Manual edit';
      await addResumeHistory({
        reason,
        before,
        after: body,
        source: 'manual',
      });
    }
    state.working = await saveResume('working', body);
    toast('Working resume saved', 'ok');
    await reloadAll();
    render();
  };
  $('#r-clone').onclick = async () => {
    if (!state.master?.body) {
      toast('Master is empty', 'err');
      return;
    }
    if (!confirm('Overwrite Working Resume with Master?')) return;
    const before = state.working?.body || '';
    await saveResume('working', state.master.body);
    await addResumeHistory({
      reason: 'Reset Working from Master',
      before,
      after: state.master.body,
      source: 'reset',
    });
    await reloadAll();
    toast('Working reset from Master', 'ok');
    render();
  };
  $('#r-export').onclick = () => {
    downloadText(
      'compound-resumes.md',
      resumesToMarkdown(state.master, state.working),
      'text/markdown'
    );
  };
}

// ── Domains / learning ─────────────────────────────────────

function renderDomains(root, actions) {
  actions.innerHTML = `<button type="button" class="btn" id="dom-help">How flags work</button>`;
  const stats = domainStats();
  root.innerHTML = `
    <p class="muted" style="margin-top:0">Glanceable domain performance. Flags fire when rejections/ghosts cluster without interviews (thresholds in Settings).</p>
    <table class="domain-table">
      <thead>
        <tr>
          <th>Domain</th>
          <th>Apps</th>
          <th>Rejected</th>
          <th>Ghosted</th>
          <th>Interview</th>
          <th>Offer</th>
          <th>Dead rate</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${
          stats.length
            ? stats
                .map(
                  (d) => `
          <tr class="${d.flagged ? 'flagged' : ''}">
            <td>${esc(d.domain)} ${d.flagged ? '<span class="tag flag">flagged</span>' : ''}</td>
            <td>${d.apps}</td>
            <td>${d.rejected}</td>
            <td>${d.ghosted}</td>
            <td>${d.interviews}</td>
            <td>${d.offers}</td>
            <td>${Math.round(d.rate * 100)}%</td>
            <td><button type="button" class="btn primary" data-analyze="${esc(d.domain)}">Analyze failures</button></td>
          </tr>`
                )
                .join('')
            : `<tr><td colspan="8" class="dim">Log applications to see domain density.</td></tr>`
        }
      </tbody>
    </table>
  `;
  $('#dom-help').onclick = () =>
    toast(
      `Flag when ≥${state.settings.rejectionMinApps} apps, ≥${state.settings.rejectionMinRejects} rejects/ghosts, ≤${state.settings.rejectionMaxInterviews} interviews in ${state.settings.rejectionWindowDays || 'all'} days`,
      ''
    );
  root.querySelectorAll('[data-analyze]').forEach((btn) => {
    btn.onclick = () => analyzeDomain(btn.dataset.analyze);
  });
}

async function analyzeDomain(domain) {
  const apps = appsForDomain(
    state.applications,
    domain,
    state.settings.rejectionWindowDays || 0
  );
  if (!apps.length) {
    toast('No applications in this domain', 'err');
    return;
  }
  if (!resumeBody().trim()) {
    toast('Need a Working resume', 'err');
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Analyze domain failures</h2>
      <p class="muted"><strong>${esc(domain)}</strong> · ${apps.length} application(s)</p>
      <p class="dim">Uses <strong>Deep</strong> model: ${esc(state.settings.deepModel || AI_DEFAULTS.deepModel)} — higher quality, higher cost.</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="an-cancel">Cancel</button>
        <button type="button" class="btn primary" id="an-run">Run deep analysis</button>
      </div>
      <div id="an-out" hidden style="margin-top:1rem">
        <div class="banner"><h3>Summary</h3><p class="muted" id="an-summary" style="margin:0"></p></div>
        <div class="field"><label>Likely reasons</label><div class="prose" id="an-reasons"></div></div>
        <div class="field"><label>Actionable adjustments</label><div class="prose" id="an-actions"></div></div>
        <div class="field"><label>Revised sections</label><textarea id="an-sections" rows="10"></textarea></div>
        <div class="field"><label>Full working draft (if provided)</label><textarea id="an-full" rows="12"></textarea></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="an-discard">Discard</button>
          <button type="button" class="btn" id="an-sections-only">Accept sections → append note</button>
          <button type="button" class="btn primary" id="an-accept">Accept full draft into Working</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#an-cancel', backdrop).onclick = close;
  $('#an-discard', backdrop)?.addEventListener('click', close);

  $('#an-run', backdrop).onclick = async () => {
    const { system, user } = domainFailurePrompt({
      domain,
      workingResume: resumeBody(),
      applications: apps,
      profile: state.profile,
    });
    $('#an-run', backdrop).disabled = true;
    $('#an-run', backdrop).textContent = 'Analyzing…';
    try {
      const { content } = await chatCompletion({
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
        model: state.settings.deepModel || AI_DEFAULTS.deepModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        purpose: 'domain_failure_analysis',
        tier: 'deep',
        temperature: 0.25,
      });
      const parsed = parseModelJson(content);
      $('#an-out', backdrop).hidden = false;
      $('#an-summary', backdrop).textContent = parsed.summary || '';
      $('#an-reasons', backdrop).textContent = (parsed.likelyReasons || []).map((r, i) => `${i + 1}. ${r}`).join('\n');
      $('#an-actions', backdrop).textContent = (parsed.actionableAdjustments || [])
        .map((a) => `• [${a.area}] ${a.change} — ${a.why}`)
        .join('\n');
      $('#an-sections', backdrop).value = parsed.revisedSections || '';
      $('#an-full', backdrop).value = parsed.fullWorkingResumeDraft || '';
      state.usage = await getUsageSummary();
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      $('#an-run', backdrop).disabled = false;
      $('#an-run', backdrop).textContent = 'Run deep analysis';
    }
  };

  backdrop.addEventListener('click', async (e) => {
    const t = e.target;
    if (t?.id === 'an-discard') close();
    if (t?.id === 'an-accept') {
      const draft = $('#an-full', backdrop).value.trim();
      if (!draft) {
        toast('No full draft from model — use Accept sections or paste into Working manually', 'err');
        return;
      }
      const before = state.working?.body || '';
      await saveResume('working', draft);
      await addResumeHistory({
        reason: `Accepted deep analysis for domain ${domain}`,
        domain,
        applicationIds: apps.map((a) => a.id),
        before,
        after: draft,
        source: 'deep_analysis',
      });
      close();
      await reloadAll();
      toast('Working resume updated', 'ok');
      state.view = 'resumes';
      render();
    }
    if (t?.id === 'an-sections-only') {
      const sections = $('#an-sections', backdrop).value.trim();
      if (!sections) {
        toast('No revised sections', 'err');
        return;
      }
      const before = state.working?.body || '';
      const after = `${before.trim()}\n\n---\n## Proposed revisions (${domain})\n\n${sections}\n`;
      await saveResume('working', after);
      await addResumeHistory({
        reason: `Appended revised sections for ${domain}`,
        domain,
        applicationIds: apps.map((a) => a.id),
        before,
        after,
        source: 'deep_analysis_sections',
      });
      close();
      await reloadAll();
      toast('Sections appended to Working', 'ok');
      state.view = 'resumes';
      render();
    }
  });
}

// ── Profile ────────────────────────────────────────────────

function renderProfile(root, actions) {
  actions.innerHTML = `<button type="button" class="btn primary" id="pf-save">Save profile</button>`;
  const p = state.profile;
  root.innerHTML = `
    <p class="muted" style="margin-top:0">Targeting signals for match scoring (remote / high-autonomy, ~$2–3k/mo band by default).</p>
    <div class="grid-2">
      <div class="field"><label>Your name</label><input id="pf-name" value="${esc(p.name || '')}" /></div>
      <div class="field"><label>Remote only</label>
        <select id="pf-remote"><option value="yes" ${p.remoteOnly !== false ? 'selected' : ''}>Yes</option><option value="no" ${p.remoteOnly === false ? 'selected' : ''}>No</option></select>
      </div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Salary floor (USD / month)</label><input id="pf-floor" type="number" value="${esc(p.salaryFloorUsd ?? 2000)}" /></div>
      <div class="field"><label>Salary ceiling (USD / month)</label><input id="pf-ceil" type="number" value="${esc(p.salaryCeilingUsd ?? 3500)}" /></div>
    </div>
    <div class="field"><label>Skills (comma-separated)</label><input id="pf-skills" value="${esc((p.skills || []).join(', '))}" placeholder="SQL, Python, stakeholder research…" /></div>
    <div class="field"><label>Experience keywords</label><input id="pf-kw" value="${esc((p.experienceKeywords || []).join(', '))}" placeholder="funnel analysis, market sizing…" /></div>
    <div class="field"><label>Preferred domains (comma-separated)</label><input id="pf-dom" value="${esc((p.preferredDomains || []).join(', '))}" /></div>
    <div class="field"><label>Deal-breakers (comma-separated substrings)</label><input id="pf-db" value="${esc((p.dealBreakers || []).join(', '))}" /></div>
    <div class="field"><label>Notes</label><textarea id="pf-notes" rows="4">${esc(p.notes || '')}</textarea></div>
  `;
  $('#pf-save').onclick = async () => {
    const split = (id) =>
      $(id)
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    state.profile = await setProfile({
      name: $('#pf-name').value.trim(),
      remoteOnly: $('#pf-remote').value === 'yes',
      salaryFloorUsd: Number($('#pf-floor').value) || 2000,
      salaryCeilingUsd: Number($('#pf-ceil').value) || 3500,
      skills: split('#pf-skills'),
      experienceKeywords: split('#pf-kw'),
      preferredDomains: split('#pf-dom'),
      dealBreakers: split('#pf-db'),
      notes: $('#pf-notes').value,
    });
    toast('Profile saved — rescoring jobs…', 'ok');
    await rescoreAllJobs(await listJobs({}), state.profile, resumeBody());
    await reloadAll();
    render();
  };
}

// ── Settings ───────────────────────────────────────────────

function renderSettings(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="s-export">Export JSON</button>
    <button type="button" class="btn primary" id="s-save">Save settings</button>
  `;
  const s = state.settings;
  root.innerHTML = `
    <div class="card" style="max-width:36rem">
      <h3>Appearance</h3>
      <div class="field"><label>Theme</label>
        <select id="s-theme"><option value="dark" ${s.theme !== 'light' ? 'selected' : ''}>Dark</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option></select>
      </div>
    </div>
    <div class="card" style="max-width:36rem;margin-top:1rem">
      <h3>Grok / OpenAI-compatible API</h3>
      <p class="muted">Key stays in IndexedDB on this browser only. Fast model for prep; deep for domain analysis.</p>
      <div class="field"><label>Base URL</label><input id="s-url" value="${esc(s.llmBaseUrl || '')}" placeholder="https://api.x.ai/v1" /></div>
      <div class="field"><label>API key</label><input id="s-key" type="password" value="${esc(s.llmApiKey || '')}" /></div>
      <div class="field"><label>Fast model</label><input id="s-fast" value="${esc(s.fastModel || '')}" /></div>
      <div class="field"><label>Deep model</label><input id="s-deep" value="${esc(s.deepModel || '')}" /></div>
      <button type="button" class="btn" id="s-test">Test connection</button>
      <p class="dim" id="s-test-out"></p>
      <p class="usage-chip">Approx. spend: ${formatUsd(state.usage.estCostUsd)} across ${state.usage.calls} calls (${state.usage.totalTokens} tokens). Display-only estimates.</p>
    </div>
    <div class="card" style="max-width:36rem;margin-top:1rem">
      <h3>Rejection flag thresholds</h3>
      <div class="grid-2">
        <div class="field"><label>Min applications</label><input id="s-minapps" type="number" value="${esc(s.rejectionMinApps)}" /></div>
        <div class="field"><label>Min rejects+ghosts</label><input id="s-minrej" type="number" value="${esc(s.rejectionMinRejects)}" /></div>
        <div class="field"><label>Max interviews to still flag</label><input id="s-maxint" type="number" value="${esc(s.rejectionMaxInterviews)}" /></div>
        <div class="field"><label>Window days (0 = all time)</label><input id="s-win" type="number" value="${esc(s.rejectionWindowDays)}" /></div>
      </div>
    </div>
    <div class="card" style="max-width:36rem;margin-top:1rem">
      <h3>Domain tags</h3>
      <div class="field"><label>One per line</label><textarea id="s-domains" rows="8">${esc((s.domains || []).join('\n'))}</textarea></div>
    </div>
  `;
  $('#s-save').onclick = async () => {
    const domains = $('#s-domains')
      .value.split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    state.settings = await setSettings({
      theme: $('#s-theme').value,
      llmBaseUrl: $('#s-url').value.trim(),
      llmApiKey: $('#s-key').value.trim(),
      fastModel: $('#s-fast').value.trim(),
      deepModel: $('#s-deep').value.trim(),
      rejectionMinApps: Number($('#s-minapps').value) || 3,
      rejectionMinRejects: Number($('#s-minrej').value) || 3,
      rejectionMaxInterviews: Number($('#s-maxint').value) || 0,
      rejectionWindowDays: Number($('#s-win').value) || 0,
      domains: domains.length ? domains : state.settings.domains,
    });
    applyTheme(state.settings.theme);
    toast('Settings saved', 'ok');
    render();
  };
  $('#s-test').onclick = async () => {
    const r = await checkLlm($('#s-url').value.trim(), $('#s-key').value.trim());
    $('#s-test-out').textContent = r.ok ? r.message : r.reason;
    toast(r.ok ? 'OK' : r.reason, r.ok ? 'ok' : 'err');
  };
  $('#s-export').onclick = async () => {
    const data = await exportAllData();
    downloadJson('compound-export.json', data);
    toast('Exported', 'ok');
  };
}
