/**
 * Bootstraps — presentation layer
 */

import {
  APP_NAME,
  APP_TAGLINE,
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
import {
  syncRemotive,
  normalizeManual,
  rescoreAllJobs,
  importBulkJobs,
} from './jobs/sources.js';
import { importJobLinks, checkJobFetch, parseJobLinks } from './jobs/links.js';
import { scoreJob, buildDigest, inferDomains } from './jobs/match.js';
import { domainPerformance, appsForDomain } from './jobs/learning.js';
import { buildLocalPrep } from './jobs/hints.js';
import { chatCompletion, checkLlm, formatUsd } from './ai/client.js';
import { prepareApplicationPrompt, domainFailurePrompt, parseModelJson } from './ai/prompts.js';
import {
  downloadText,
  downloadJson,
  formatDate,
  applicationsToMarkdown,
  resumesToMarkdown,
} from './lib/export.js';
import { loadSamplePack } from './lib/sample.js';
import { lineDiff, diffStats } from './lib/diff.js';
import { installUiHtml, wireInstallButtons } from './pwa.js';

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
  /** @type {'pipeline' | 'list'} */
  appView: 'pipeline',
  busy: false,
};

let rootEl = null;

export async function mountApp(root) {
  rootEl = root;
  await reloadAll();
  render();
  // Re-render when browser becomes installable / after install
  window.addEventListener('bootstraps-pwa-change', () => {
    if (rootEl) render();
  });
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

/** First-session checklist derived from live data. */
function onboardingSteps() {
  const hasMaster = !!(state.master?.body || '').trim();
  const hasWorking = !!(state.working?.body || '').trim();
  const hasProfile =
    (state.profile?.skills || []).length > 0 ||
    (state.profile?.experienceKeywords || []).length > 0 ||
    !!(state.profile?.name || '').trim();
  const hasJobs = state.jobs.length > 0;
  const hasApps = state.applications.length > 0;
  const hasApi = !!(state.settings?.llmApiKey || '').trim();
  const steps = [
    {
      id: 'resume',
      label: 'Paste Master Resume (Working can copy from it)',
      done: hasMaster || hasWorking,
      view: 'resumes',
    },
    {
      id: 'profile',
      label: 'Set skills, domains & salary floor',
      done: hasProfile,
      view: 'profile',
    },
    {
      id: 'jobs',
      label: 'Paste job links, fetch Remotive, or load sample jobs',
      done: hasJobs,
      view: 'jobs',
    },
    {
      id: 'apply',
      label: 'Log your first application (JD is saved automatically)',
      done: hasApps,
      view: hasJobs ? 'digest' : 'jobs',
    },
    {
      id: 'api',
      label: 'Optional: add Grok API key for Prepare & deep analysis',
      done: hasApi,
      view: 'settings',
      optional: true,
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneRequired = required.filter((s) => s.done).length;
  const complete = required.every((s) => s.done);
  return { steps, doneRequired, totalRequired: required.length, complete };
}

function scoreBreakdownHtml(j) {
  const b = j.scoreBreakdown;
  if (!b) return '';
  const row = (label, v) => {
    const pct = Math.round(clamp01(v) * 100);
    return `<div class="score-bar-row" title="${esc(label)}: ${pct}%">
      <span>${esc(label)}</span>
      <div class="score-bar"><i style="width:${pct}%"></i></div>
      <span class="score-bar-n">${pct}</span>
    </div>`;
  };
  return `<div class="score-breakdown">
    ${row('Skills', b.skillOverlap)}
    ${row('Keywords', b.keywordOverlap)}
    ${row('Domain', b.domainBoost)}
    ${row('Salary', b.salaryFit)}
    ${row('Remote', b.remoteFit)}
    ${b.penalty ? `<div class="score-bar-row dim"><span>Penalties</span><span class="score-bar-n">−${Math.round(clamp01(b.penalty) * 100)}</span></div>` : ''}
  </div>`;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// ── Shell ──────────────────────────────────────────────────

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-logo" src="./public/bootstraps-logo.jpg" alt="" width="52" height="52" />
        <div>
          <h1>${APP_NAME}</h1>
          <p>Hunt · learn · climb</p>
        </div>
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
        <div class="pwa-side-slot" style="margin-top:0.65rem">
          ${installUiHtml('compact')}
        </div>
        <p style="margin:0.65rem 0 0">
          <a href="#support" data-nav="settings" class="donate-link">♥ If this helps you get hired, donate</a>
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
      if (state.view === 'settings') {
        requestAnimationFrame(() => $('#support')?.scrollIntoView({ behavior: 'smooth' }));
      }
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
  wireInstallButtons(rootEl);
}

function supportBlock() {
  const s = state.settings || {};
  return `
    <div class="support-card" id="support">
      <h3>If Bootstraps helps you get hired</h3>
      <p>${esc(
        s.supportNote ||
          'This tool is free. If it helps you land a job, get interviews, or sharpen your resume — please donate. It funds continued development.'
      )}</p>
      <div class="support-links">
        <a class="btn primary" href="${esc(s.supportGithubSponsors || 'https://github.com/sponsors')}" target="_blank" rel="noopener">GitHub Sponsors</a>
        <a class="btn" href="${esc(s.supportKofi || 'https://ko-fi.com')}" target="_blank" rel="noopener">Ko-fi</a>
      </div>
      <p class="dim" style="margin:0.75rem 0 0;font-size:0.82rem">Even a one-time coffee after an offer means a lot.</p>
    </div>`;
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
  return t[state.view] || 'Bootstraps';
}

// ── Dashboard ──────────────────────────────────────────────

function renderDashboard(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="d-sample">Load sample data</button>
    <button type="button" class="btn primary" id="d-links">Paste links</button>
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
  const onboard = onboardingSteps();

  root.innerHTML = `
    <section class="hero">
      <img class="hero-logo" src="./public/bootstraps-logo.jpg" alt="Someone literally pulling themselves up by their bootstraps" />
      <div class="hero-copy">
        <p class="hero-kicker">${esc(APP_NAME)}</p>
        <h2 class="hero-tagline">${esc(APP_TAGLINE)}</h2>
        <p class="hero-sub muted">Local-first job hunt. Dual resumes. Rejection turns into climb fuel.</p>
      </div>
    </section>
    ${
      !onboard.complete
        ? `<div class="onboard card">
            <div class="onboard-head">
              <h3>Get started</h3>
              <span class="dim">${onboard.doneRequired}/${onboard.totalRequired} core steps</span>
            </div>
            <div class="onboard-progress"><i style="width:${Math.round((onboard.doneRequired / onboard.totalRequired) * 100)}%"></i></div>
            <ul class="onboard-list">
              ${onboard.steps
                .map(
                  (s) => `
                <li class="${s.done ? 'done' : ''}">
                  <span class="onboard-check">${s.done ? '✓' : '○'}</span>
                  <button type="button" class="onboard-link" data-go="${s.view}">
                    ${esc(s.label)}${s.optional ? ' <span class="dim">(optional)</span>' : ''}
                  </button>
                </li>`
                )
                .join('')}
            </ul>
            <p class="dim" style="margin:0.75rem 0 0">New here? <button type="button" class="btn" id="onboard-sample">Load sample data</button> to see scoring, JDs on apps, and a flagged domain in one click.</p>
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
    <div class="card resume-status-card">
      <h3>Resume status</h3>
      <div class="resume-status-row">
        <p class="muted" style="margin:0">
          <span class="tag master">Master</span> ${state.master?.body ? `${state.master.body.length} chars · ${formatDate(state.master.updatedAt)}` : 'empty'}
        </p>
        <p class="muted" style="margin:0">
          <span class="tag working">Working</span> ${state.working?.body ? `${state.working.body.length} chars · ${formatDate(state.working.updatedAt)}` : 'empty'}
        </p>
        <p class="dim" style="margin:0">${state.history.length} improvement events logged</p>
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
          : `<div class="empty"><h3>No ranked jobs yet</h3><p>Paste job links you’ve collected, fetch Remotive, or load sample data.</p></div>`
      }
    </div>
    ${supportBlock()}
  `;
  const runSample = async () => {
    if (
      (state.jobs.length || state.applications.length || resumeBody().trim()) &&
      !confirm('Load sample pack? This adds demo resume, profile, jobs, and applications (does not wipe your data — may add alongside).')
    ) {
      return;
    }
    try {
      const r = await loadSamplePack();
      await reloadAll();
      toast(`Sample loaded: ${r.jobs} jobs, ${r.applications} apps with JDs`, 'ok');
      render();
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  };
  $('#d-links').onclick = () => openPasteLinks();
  $('#d-fetch').onclick = () => fetchJobs();
  $('#d-digest').onclick = () => {
    state.view = 'digest';
    render();
  };
  $('#d-sample').onclick = runSample;
  $('#onboard-sample')?.addEventListener('click', runSample);
  $('#go-domains')?.addEventListener('click', () => {
    state.view = 'domains';
    render();
  });
  root.querySelectorAll('[data-go]').forEach((btn) => {
    btn.onclick = () => {
      state.view = btn.dataset.go;
      render();
    };
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
    <button type="button" class="btn primary" id="j-links">Paste links</button>
    <button type="button" class="btn" id="j-bulk">Bulk import</button>
    <button type="button" class="btn" id="j-manual">Add manual</button>
    <button type="button" class="btn" id="j-fetch">Fetch Remotive</button>
  `;
  let jobs = state.jobs;
  if (state.jobQ) {
    const q = state.jobQ.toLowerCase();
    jobs = jobs.filter(
      (j) =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.company || '').toLowerCase().includes(q) ||
        (j.url || '').toLowerCase().includes(q)
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
          : `<div class="empty"><h3>No jobs yet</h3><p><strong>Paste links</strong> you’ve collected (Greenhouse, Lever, LinkedIn, company pages…), fetch Remotive, bulk-import text, or add one job manually. Links are fetched locally, scored against your Working resume, then land here.</p></div>`
      }
    </div>
  `;
  $('#j-fetch').onclick = () => fetchJobs();
  $('#j-manual').onclick = () => openManualJob();
  $('#j-bulk').onclick = () => openBulkImport();
  $('#j-links').onclick = () => openPasteLinks();
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
    : `<p class="dim" style="margin:0.4rem 0 0">${esc((j.description || '').slice(0, 220))}${(j.description || '').length > 220 ? '…' : ''}</p>`;
  const breakdown = scoreBreakdownHtml(j);
  return `
    <article class="job-card" data-job-id="${j.id}">
      <div>
        <h3>${esc(j.title)}</h3>
        <div class="job-meta">${esc(j.company)} · ${esc(j.source)} · ${formatDate(j.fetchedAt)}</div>
        <div style="margin-top:0.35rem">${domains}<span class="tag">${esc(j.category || '—')}</span></div>
        ${desc}
        ${breakdown}
      </div>
      <div class="row-actions" style="flex-direction:column;align-items:flex-end">
        <span class="score-pill ${scoreClass(j.score || 0)}" title="Match score vs Working resume + profile">${j.score ?? 0}</span>
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

function openBulkImport() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Bulk import jobs</h2>
      <p class="muted">Paste structured jobs from WWR, newsletters, JSON, or spreadsheets. For a list of <strong>URLs only</strong>, use <strong>Paste links</strong> instead — it fetches each page.</p>
      <div class="field">
        <label>Formats</label>
        <p class="dim" style="margin:0">• Blocks with <code>Title:</code> <code>Company:</code> <code>URL:</code> <code>Description:</code> separated by <code>---</code><br/>
        • TSV: title · company · url · description<br/>
        • JSON array or Remotive-style <code>{"jobs":[...]}</code></p>
      </div>
      <div class="field"><label>Paste</label><textarea id="bulk-raw" rows="14" placeholder="Title: Remote Data Analyst
Company: Acme
URL: https://...
Description: SQL, Python, remote...

---

Title: Strategy Associate
Company: Harbor
..."></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="bulk-cancel">Cancel</button>
        <button type="button" class="btn" id="bulk-as-links">Looks like links → Paste links</button>
        <button type="button" class="btn primary" id="bulk-go">Import & score</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#bulk-cancel', backdrop).onclick = close;
  $('#bulk-as-links', backdrop).onclick = () => {
    const raw = $('#bulk-raw', backdrop).value;
    close();
    openPasteLinks(raw);
  };
  $('#bulk-go', backdrop).onclick = async () => {
    const raw = $('#bulk-raw', backdrop).value;
    // Auto-route pure URL pastes to link importer
    const linkItems = parseJobLinks(raw);
    const nonUrlLines = raw
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^https?:\/\//i.test(l) && !/\[[^\]]+\]\(https?:\/\//i.test(l));
    if (linkItems.length >= 1 && nonUrlLines.length === 0) {
      close();
      openPasteLinks(raw);
      return;
    }
    try {
      const r = await importBulkJobs(raw, state.profile, resumeBody(), state.settings.domains);
      if (!r.total) {
        toast('No jobs parsed — check format, or use Paste links for URLs', 'err');
        return;
      }
      close();
      await reloadAll();
      toast(`Imported ${r.added} new · ${r.updated} updated`, 'ok');
      render();
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  };
}

function openPasteLinks(prefill = '') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Paste job links</h2>
      <p class="muted">
        Drop in URLs you’ve saved from Greenhouse, Lever, Ashby, LinkedIn, company career pages, newsletters, etc.
        Bootstraps fetches each page <strong>on your machine</strong>, extracts title / company / description, then scores against your Working resume.
      </p>
      <div class="field">
        <label>Accepted formats</label>
        <p class="dim" style="margin:0">
          • One URL per line<br/>
          • <code>Title | https://…</code> or <code>Title · Company · https://…</code><br/>
          • Markdown <code>[Title](https://…)</code><br/>
          • Mixed paste from notes — URLs are picked out automatically
        </p>
      </div>
      <div class="field">
        <label>Links</label>
        <textarea id="links-raw" rows="12" placeholder="https://boards.greenhouse.io/acme/jobs/123
Senior Analyst | https://jobs.lever.co/harbor/uuid
[Research Lead](https://jobs.ashbyhq.com/studio/abc)
https://weworkremotely.com/remote-jobs/…"></textarea>
      </div>
      <p class="dim" id="links-status">Ready.</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="links-cancel">Cancel</button>
        <button type="button" class="btn primary" id="links-go">Fetch, score &amp; import</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (prefill) $('#links-raw', backdrop).value = prefill;

  const close = () => backdrop.remove();
  const status = $('#links-status', backdrop);
  $('#links-cancel', backdrop).onclick = close;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };

  // Probe server once
  checkJobFetch().then((r) => {
    if (!r.ok) {
      status.innerHTML =
        '<span style="color:var(--warn)">Job-fetch API offline — start with <code>./start.sh</code> (not plain <code>python -m http.server</code>). Links can still import as stubs.</span>';
    } else {
      status.textContent = 'Local fetch ready — pages will be loaded through Bootstraps server.';
    }
  });

  $('#links-go', backdrop).onclick = async () => {
    const raw = $('#links-raw', backdrop).value;
    const preview = parseJobLinks(raw);
    if (!preview.length) {
      toast('No URLs found in paste', 'err');
      return;
    }
    if (state.busy) return;
    state.busy = true;
    const go = $('#links-go', backdrop);
    go.disabled = true;
    status.textContent = `0 / ${preview.length}…`;
    try {
      const r = await importJobLinks(
        raw,
        state.profile,
        resumeBody(),
        state.settings.domains,
        (done, total, job) => {
          status.textContent = `${done} / ${total} — ${job.title || '…'} (${job.score ?? 0})`;
        }
      );
      close();
      await reloadAll();
      const failNote = r.failed ? ` · ${r.failed} partial (stub)` : '';
      toast(
        `Links: ${r.added} new · ${r.updated} updated · ${r.total} total${failNote}`,
        r.total ? 'ok' : 'err'
      );
      render();
    } catch (err) {
      toast(err.message || String(err), 'err');
      status.textContent = err.message || String(err);
      go.disabled = false;
    } finally {
      state.busy = false;
    }
  };
}

function openManualJob() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Add job manually</h2>
      <p class="muted">For We Work Remotely, company sites, referrals, etc. Or use Bulk import for many at once.</p>
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
    <button type="button" class="btn ${state.appView === 'pipeline' ? 'primary' : ''}" id="a-pipe">Pipeline</button>
    <button type="button" class="btn ${state.appView === 'list' ? 'primary' : ''}" id="a-list">List</button>
    <button type="button" class="btn" id="a-export">Export MD</button>
    <button type="button" class="btn primary" id="a-new">Log application</button>
  `;
  let apps = state.applications;
  if (state.appDomain) apps = apps.filter((a) => a.domain === state.appDomain);
  if (state.appView === 'list' && state.appFilter !== 'all') {
    apps = apps.filter((a) => a.status === state.appFilter);
  }

  const body =
    state.appView === 'pipeline'
      ? pipelineHtml(apps)
      : `
    <div class="filter-row">
      <button type="button" class="chip ${state.appFilter === 'all' ? 'active' : ''}" data-st="all">All</button>
      ${APPLICATION_STATUSES.map(
        (s) =>
          `<button type="button" class="chip ${state.appFilter === s ? 'active' : ''}" data-st="${esc(s)}">${esc(s)}</button>`
      ).join('')}
    </div>
    <div class="app-list">
      ${
        apps.length
          ? apps.map((a) => appCardHtml(a)).join('')
          : `<div class="empty"><h3>No applications logged</h3><p>Log from a job card or add manually.</p></div>`
      }
    </div>`;

  root.innerHTML = `
    <div class="filter-row">
      <select id="a-dom" style="max-width:11rem">
        <option value="">All domains</option>
        ${(state.settings.domains || [])
          .map((d) => `<option value="${esc(d)}" ${state.appDomain === d ? 'selected' : ''}>${esc(d)}</option>`)
          .join('')}
      </select>
      <span class="dim">${apps.length} shown · drag cards across columns in Pipeline</span>
    </div>
    ${body}
  `;

  $('#a-pipe').onclick = () => {
    state.appView = 'pipeline';
    render();
  };
  $('#a-list').onclick = () => {
    state.appView = 'list';
    render();
  };
  $('#a-new').onclick = () => openAppEditor(null);
  $('#a-export').onclick = () => {
    downloadText('bootstraps-applications.md', applicationsToMarkdown(state.applications), 'text/markdown');
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
  bindAppCardActions(root);
  if (state.appView === 'pipeline') bindPipelineDnD(root);
}

function pipelineHtml(apps) {
  if (!state.applications.length) {
    return `<div class="empty"><h3>No applications yet</h3><p>Log from a job card — then drag across the board as outcomes change.</p></div>`;
  }
  const cols = APPLICATION_STATUSES;
  return `
    <div class="pipeline">
      ${cols
        .map((status) => {
          const colApps = apps.filter((a) => a.status === status);
          return `
        <section class="pipe-col" data-status="${esc(status)}">
          <header class="pipe-col-head">
            <h3>${esc(status)}</h3>
            <span class="dim">${colApps.length}</span>
          </header>
          <div class="pipe-col-body" data-drop-status="${esc(status)}">
            ${
              colApps.length
                ? colApps.map((a) => pipelineCardHtml(a)).join('')
                : `<p class="pipe-empty dim">Drop here</p>`
            }
          </div>
        </section>`;
        })
        .join('')}
    </div>`;
}

function pipelineCardHtml(a) {
  const jdLen = (a.jobDescription || '').trim().length;
  return `
    <article class="pipe-card" draggable="true" data-app-id="${a.id}">
      <h4>${esc(a.title)}</h4>
      <div class="job-meta">${esc(a.company)}</div>
      <div class="pipe-card-meta">
        <span class="tag">${esc(a.domain)}</span>
        ${jdLen ? '<span class="tag working">JD</span>' : '<span class="tag">No JD</span>'}
      </div>
      <div class="pipe-card-actions">
        <button type="button" class="btn ghost" data-edit-app="${a.id}">Edit</button>
        <select class="pipe-status" data-status-app="${a.id}" title="Move">
          ${APPLICATION_STATUSES.map(
            (s) => `<option value="${esc(s)}" ${a.status === s ? 'selected' : ''}>${esc(s)}</option>`
          ).join('')}
        </select>
      </div>
    </article>`;
}

function appCardHtml(a) {
  const jdLen = (a.jobDescription || '').trim().length;
  return `
    <article class="job-card" data-app-id="${a.id}">
      <div>
        <h3>${esc(a.title)}</h3>
        <div class="job-meta">${esc(a.company)} · ${formatDate(a.appliedAt)} · base: ${esc(a.resumeBase || 'working')}</div>
        <div style="margin-top:0.35rem">
          <span class="tag">${esc(a.status)}</span>
          <span class="tag">${esc(a.domain)}</span>
          <span class="tag ${jdLen ? 'working' : ''}">${jdLen ? `JD ${jdLen.toLocaleString()} chars` : 'No JD'}</span>
        </div>
        ${a.notes ? `<p class="dim" style="margin:0.4rem 0 0">${esc(a.notes.slice(0, 180))}</p>` : ''}
      </div>
      <div class="row-actions" style="flex-direction:column;align-items:flex-end">
        ${a.url ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener">URL</a>` : ''}
        <select class="pipe-status" data-status-app="${a.id}">
          ${APPLICATION_STATUSES.map(
            (s) => `<option value="${esc(s)}" ${a.status === s ? 'selected' : ''}>${esc(s)}</option>`
          ).join('')}
        </select>
        <button type="button" class="btn" data-edit-app="${a.id}">Update</button>
        <button type="button" class="btn danger" data-del-app="${a.id}">Delete</button>
      </div>
    </article>`;
}

function bindAppCardActions(root) {
  root.querySelectorAll('[data-edit-app]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openAppEditor(btn.dataset.editApp);
    };
  });
  root.querySelectorAll('[data-del-app]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this application log?')) return;
      await deleteApplication(btn.dataset.delApp);
      await reloadAll();
      render();
    };
  });
  root.querySelectorAll('[data-status-app]').forEach((sel) => {
    sel.onchange = async (e) => {
      e.stopPropagation();
      const id = sel.dataset.statusApp;
      const status = sel.value;
      await updateApplication(id, { status });
      await reloadAll();
      toast(`→ ${status}`, 'ok');
      if (status === 'Offer') {
        setTimeout(() => toast('Offer — if Bootstraps helped, please donate (sidebar ♥)', 'ok'), 600);
      }
      render();
    };
  });
}

function bindPipelineDnD(root) {
  let dragId = null;
  root.querySelectorAll('.pipe-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragId = card.dataset.appId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragId = null;
      root.querySelectorAll('.pipe-col-body').forEach((c) => c.classList.remove('drag-over'));
    });
  });
  root.querySelectorAll('.pipe-col-body').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain') || dragId;
      const status = col.dataset.dropStatus;
      if (!id || !status) return;
      const app = state.applications.find((a) => a.id === id);
      if (!app || app.status === status) return;
      await updateApplication(id, { status });
      await reloadAll();
      toast(`${app.title.slice(0, 32)} → ${status}`, 'ok');
      if (status === 'Offer') {
        setTimeout(() => toast('Offer — if Bootstraps helped, please donate (sidebar ♥)', 'ok'), 600);
      }
      render();
    });
  });
}

function openAppEditor(id) {
  const existing = id ? state.applications.find((a) => a.id === id) : null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>${existing ? 'Update application' : 'Log application'}</h2>
      <p class="muted">Paste the job description when you can — it powers domain analysis later.</p>
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
      <div class="field"><label>Notes</label><textarea id="ap-notes" rows="3">${esc(existing?.notes || '')}</textarea></div>
      <div class="field"><label>Job description (saved for learning loop)</label><textarea id="ap-jd" rows="8" placeholder="Paste the full JD here…">${esc(existing?.jobDescription || '')}</textarea></div>
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
      jobDescription: $('#ap-jd', backdrop).value,
    };
    if (!payload.title) {
      toast('Title required', 'err');
      return;
    }
    if (existing) await updateApplication(existing.id, payload);
    else await putApplication({ ...payload, resumeBase: 'working' });
    close();
    await reloadAll();
    toast(payload.jobDescription?.trim() ? 'Saved (JD stored)' : 'Saved — tip: add JD for better analysis', 'ok');
    if (payload.status === 'Offer') {
      setTimeout(
        () =>
          toast('Offer logged — if Bootstraps helped, please donate (sidebar ♥)', 'ok'),
        700
      );
    }
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
    jobDescription: job.description || '',
    resumeBase: 'working',
  });
  await reloadAll();
  toast(job.description ? 'Logged as Applied · JD saved' : 'Logged as Applied · no JD on this listing', 'ok');
  state.view = 'applications';
  render();
}

// ── Prepare application (local free + optional Grok) ───────

async function prepareForJob(jobId) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (!resumeBody().trim()) {
    toast('Add a Working (or Master) resume first', 'err');
    state.view = 'resumes';
    render();
    return;
  }

  const local = buildLocalPrep({
    workingResume: resumeBody(),
    job,
    profile: state.profile,
  });

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Prepare application</h2>
      <p class="muted">${esc(job.title)} · ${esc(job.company)}</p>
      <p class="dim">Base: <span class="tag working">Working Resume</span> · Free local prep runs offline · Grok optional</p>
      <div class="prep-hints">
        <div class="prep-hint-col">
          <h4>Already covered (${local.coveragePct}%)</h4>
          <p class="dim">${(local.keywordsEmphasized || []).slice(0, 14).map(esc).join(' · ') || '—'}</p>
        </div>
        <div class="prep-hint-col">
          <h4>Gaps (only claim if true)</h4>
          <p class="dim">${(local.keywordsMissing || []).slice(0, 14).map(esc).join(' · ') || '—'}</p>
        </div>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
        <input type="checkbox" id="p-cover" checked /> Include short cover note
      </label>
      <div class="modal-actions" style="justify-content:flex-start">
        <button type="button" class="btn primary" id="p-local">Use free local prep</button>
        <button type="button" class="btn" id="p-run">Polish with Grok (API)</button>
        <button type="button" class="btn ghost" id="p-cancel">Cancel</button>
      </div>
      <div id="p-out">
        <div class="field" style="margin-top:1rem"><label>Prep pack / tailored resume</label><textarea id="p-resume" rows="14"></textarea></div>
        <div class="field"><label>Cover note</label><textarea id="p-note" rows="5"></textarea></div>
        <p class="dim" id="p-summary">${esc(local.changesSummary)}</p>
        <div class="modal-actions">
          <button type="button" class="btn" id="p-copy">Copy pack</button>
          <button type="button" class="btn primary" id="p-log">Save to application log</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#p-cancel', backdrop).onclick = close;

  $('#p-resume', backdrop).value = local.tailoredResume;
  $('#p-note', backdrop).value = local.coverNote;

  $('#p-local', backdrop).onclick = () => {
    const pack = buildLocalPrep({
      workingResume: resumeBody(),
      job,
      profile: state.profile,
    });
    $('#p-resume', backdrop).value = pack.tailoredResume;
    if ($('#p-cover', backdrop).checked) $('#p-note', backdrop).value = pack.coverNote;
    else $('#p-note', backdrop).value = '';
    $('#p-summary', backdrop).textContent = pack.changesSummary;
    toast('Local prep refreshed (no API)', 'ok');
  };

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
      $('#p-resume', backdrop).value = parsed.tailoredResume || content;
      $('#p-note', backdrop).value = includeCover ? parsed.coverNote || '' : '';
      $('#p-summary', backdrop).textContent = (parsed.changesSummary || '') + ' · via Grok';
      state.usage = await getUsageSummary();
      toast('Grok prep ready', 'ok');
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      $('#p-run', backdrop).disabled = false;
      $('#p-run', backdrop).textContent = 'Polish with Grok (API)';
    }
  };

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
        notes: 'Prepared via Bootstraps',
        jobDescription: job.description || '',
        tailoredResume: $('#p-resume', backdrop).value,
        coverNote: $('#p-note', backdrop).value,
        resumeBase: 'working',
      });
      close();
      await reloadAll();
      toast('Saved to applications · JD stored', 'ok');
      state.view = 'applications';
      render();
    }
  });
}

// ── Resumes ────────────────────────────────────────────────

function renderResumes(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="r-diff">Master ↔ Working diff</button>
    <button type="button" class="btn" id="r-export">Export MD</button>
    <button type="button" class="btn" id="r-clone">Working ← Master</button>
  `;
  root.innerHTML = `
    <p class="muted" style="margin-top:0">
      <span class="tag master">Master</span> stable reference ·
      <span class="tag working">Working</span> evolves from rejections & accepted suggestions
    </p>
    <div id="resume-diff-host"></div>
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
      'bootstraps-resumes.md',
      resumesToMarkdown(state.master, state.working),
      'text/markdown'
    );
  };
  $('#r-diff').onclick = () => {
    const host = $('#resume-diff-host');
    if (host.dataset.open === '1') {
      host.innerHTML = '';
      host.dataset.open = '0';
      return;
    }
    const rows = lineDiff(state.master?.body || '', state.working?.body || '');
    const st = diffStats(rows);
    host.dataset.open = '1';
    host.innerHTML = `
      <div class="diff-panel card">
        <div class="diff-head">
          <h3>Master → Working</h3>
          <span class="dim">${st.added} added · ${st.removed} removed · ${st.same} unchanged lines</span>
        </div>
        <p class="dim" style="margin:0 0 0.65rem">Red = only in Master · Green = only in Working · Gray = same</p>
        <div class="diff-body">
          ${
            st.changed === 0
              ? `<p class="muted">No differences — Working matches Master line-for-line.</p>`
              : rows
                  .map((r) => {
                    if (r.type === 'same' && !r.text.trim()) return '';
                    const cls = r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : 'diff-same';
                    const mark = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
                    return `<div class="diff-line ${cls}"><span class="diff-mark">${mark}</span><span class="diff-text">${esc(r.text) || ' '}</span></div>`;
                  })
                  .join('')
          }
        </div>
      </div>`;
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

  /** @type {{ id: string, area: string, change: string, why: string, status: 'pending'|'accepted'|'rejected' }[]} */
  let suggestions = [];

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal wide">
      <h2>Analyze domain failures</h2>
      <p class="muted"><strong>${esc(domain)}</strong> · ${apps.length} application(s)</p>
      <p class="dim">Deep model: ${esc(state.settings.deepModel || AI_DEFAULTS.deepModel)}. Accept or reject each suggestion before applying to Working.</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="an-cancel">Close</button>
        <button type="button" class="btn primary" id="an-run">Run deep analysis</button>
      </div>
      <div id="an-out" hidden style="margin-top:1rem">
        <div class="banner"><h3>Summary</h3><p class="muted" id="an-summary" style="margin:0"></p></div>
        <div class="field"><label>Likely reasons</label><div class="prose" id="an-reasons"></div></div>
        <div class="sug-head">
          <h3 style="font-family:var(--serif);margin:0;font-size:1.05rem">Suggestions</h3>
          <span class="dim" id="sug-count"></span>
        </div>
        <div id="an-suggestions" class="sug-list"></div>
        <div class="modal-actions" style="justify-content:flex-start;margin-top:0.75rem">
          <button type="button" class="btn" id="an-accept-all">Accept all pending</button>
          <button type="button" class="btn" id="an-reject-all">Reject all pending</button>
          <button type="button" class="btn primary" id="an-apply-accepted">Apply accepted → Working</button>
        </div>
        <details class="an-advanced" style="margin-top:1.25rem">
          <summary class="dim">Advanced: full draft & section block</summary>
          <div class="field" style="margin-top:0.75rem"><label>Revised sections (bulk)</label><textarea id="an-sections" rows="8"></textarea></div>
          <div class="field"><label>Full working draft</label><textarea id="an-full" rows="10"></textarea></div>
          <div class="modal-actions">
            <button type="button" class="btn" id="an-sections-only">Append sections to Working</button>
            <button type="button" class="btn primary" id="an-accept">Replace Working with full draft</button>
          </div>
        </details>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#an-cancel', backdrop).onclick = close;

  function renderSuggestions() {
    const host = $('#an-suggestions', backdrop);
    const pending = suggestions.filter((s) => s.status === 'pending').length;
    const accepted = suggestions.filter((s) => s.status === 'accepted').length;
    const rejected = suggestions.filter((s) => s.status === 'rejected').length;
    $('#sug-count', backdrop).textContent = `${accepted} accepted · ${rejected} rejected · ${pending} pending`;
    if (!suggestions.length) {
      host.innerHTML = `<p class="dim">No structured suggestions returned. Use advanced section/draft if available.</p>`;
      return;
    }
    host.innerHTML = suggestions
      .map(
        (s) => `
      <article class="sug-card status-${s.status}" data-sug="${s.id}">
        <div class="sug-card-top">
          <span class="tag">${esc(s.area || 'other')}</span>
          <span class="tag ${s.status === 'accepted' ? 'working' : s.status === 'rejected' ? '' : 'flag'}">${esc(s.status)}</span>
        </div>
        <label class="dim" style="font-size:0.72rem;text-transform:uppercase">Change</label>
        <textarea class="sug-change" data-sug-change="${s.id}" rows="2" ${s.status === 'rejected' ? 'disabled' : ''}>${esc(s.change)}</textarea>
        <p class="dim sug-why"><strong>Why:</strong> ${esc(s.why || '—')}</p>
        <div class="row-actions">
          ${
            s.status === 'pending'
              ? `<button type="button" class="btn primary" data-sug-accept="${s.id}">Accept</button>
                 <button type="button" class="btn" data-sug-reject="${s.id}">Reject</button>`
              : s.status === 'accepted'
                ? `<button type="button" class="btn" data-sug-pending="${s.id}">Undo</button>
                   <button type="button" class="btn" data-sug-reject="${s.id}">Reject</button>`
                : `<button type="button" class="btn" data-sug-pending="${s.id}">Undo reject</button>
                   <button type="button" class="btn primary" data-sug-accept="${s.id}">Accept</button>`
          }
        </div>
      </article>`
      )
      .join('');

    host.querySelectorAll('[data-sug-change]').forEach((ta) => {
      ta.oninput = () => {
        const s = suggestions.find((x) => x.id === ta.dataset.sugChange);
        if (s) s.change = ta.value;
      };
    });
    host.querySelectorAll('[data-sug-accept]').forEach((btn) => {
      btn.onclick = () => {
        const s = suggestions.find((x) => x.id === btn.dataset.sugAccept);
        if (s) s.status = 'accepted';
        renderSuggestions();
      };
    });
    host.querySelectorAll('[data-sug-reject]').forEach((btn) => {
      btn.onclick = () => {
        const s = suggestions.find((x) => x.id === btn.dataset.sugReject);
        if (s) s.status = 'rejected';
        renderSuggestions();
      };
    });
    host.querySelectorAll('[data-sug-pending]').forEach((btn) => {
      btn.onclick = () => {
        const s = suggestions.find((x) => x.id === btn.dataset.sugPending);
        if (s) s.status = 'pending';
        renderSuggestions();
      };
    });
  }

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
      $('#an-reasons', backdrop).textContent = (parsed.likelyReasons || [])
        .map((r, i) => `${i + 1}. ${r}`)
        .join('\n');
      suggestions = (parsed.actionableAdjustments || []).map((a, i) => ({
        id: `s${i}-${Date.now()}`,
        area: a.area || 'other',
        change: a.change || '',
        why: a.why || '',
        status: 'pending',
      }));
      // If model returned no structured items but has revised sections, still useful
      $('#an-sections', backdrop).value = parsed.revisedSections || '';
      $('#an-full', backdrop).value = parsed.fullWorkingResumeDraft || '';
      renderSuggestions();
      state.usage = await getUsageSummary();
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      $('#an-run', backdrop).disabled = false;
      $('#an-run', backdrop).textContent = 'Run deep analysis';
    }
  };

  $('#an-accept-all', backdrop).onclick = () => {
    suggestions.forEach((s) => {
      if (s.status === 'pending') s.status = 'accepted';
    });
    renderSuggestions();
  };
  $('#an-reject-all', backdrop).onclick = () => {
    suggestions.forEach((s) => {
      if (s.status === 'pending') s.status = 'rejected';
    });
    renderSuggestions();
  };

  $('#an-apply-accepted', backdrop).onclick = async () => {
    const accepted = suggestions.filter((s) => s.status === 'accepted' && s.change.trim());
    if (!accepted.length) {
      toast('Accept at least one suggestion first', 'err');
      return;
    }
    const block = accepted
      .map((s) => `### ${s.area}\n${s.change.trim()}\n\n_Why: ${s.why || '—'}_`)
      .join('\n\n');
    const before = state.working?.body || '';
    const after = `${before.trim()}\n\n---\n## Accepted improvements (${domain})\n\n${block}\n`;
    await saveResume('working', after);
    await addResumeHistory({
      reason: `Accepted ${accepted.length} suggestion(s) for ${domain}`,
      domain,
      applicationIds: apps.map((a) => a.id),
      before,
      after,
      source: 'deep_analysis_suggestions',
    });
    close();
    await reloadAll();
    toast(`${accepted.length} suggestion(s) applied to Working`, 'ok');
    state.view = 'resumes';
    render();
  };

  $('#an-accept', backdrop).onclick = async () => {
    const draft = $('#an-full', backdrop).value.trim();
    if (!draft) {
      toast('No full draft — accept individual suggestions or paste a draft', 'err');
      return;
    }
    if (!confirm('Replace entire Working Resume with this draft?')) return;
    const before = state.working?.body || '';
    await saveResume('working', draft);
    await addResumeHistory({
      reason: `Accepted full deep-analysis draft for ${domain}`,
      domain,
      applicationIds: apps.map((a) => a.id),
      before,
      after: draft,
      source: 'deep_analysis',
    });
    close();
    await reloadAll();
    toast('Working resume replaced', 'ok');
    state.view = 'resumes';
    render();
  };

  $('#an-sections-only', backdrop).onclick = async () => {
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
  };
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
    <div class="card" style="max-width:36rem;margin-top:1rem">
      <h3>Support / donations</h3>
      <p class="muted">Shown to you (and later users) so people who land jobs can give back. Set your real Sponsors / Ko-fi URLs.</p>
      <div class="field"><label>GitHub Sponsors URL</label><input id="s-gh" value="${esc(s.supportGithubSponsors || '')}" placeholder="https://github.com/sponsors/yourname" /></div>
      <div class="field"><label>Ko-fi URL</label><input id="s-kofi" value="${esc(s.supportKofi || '')}" placeholder="https://ko-fi.com/yourname" /></div>
      <div class="field"><label>Message</label><textarea id="s-support-note" rows="3">${esc(s.supportNote || '')}</textarea></div>
    </div>
    ${installUiHtml('full')}
    ${supportBlock()}
  `;
  wireInstallButtons(root);
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
      supportGithubSponsors: $('#s-gh').value.trim(),
      supportKofi: $('#s-kofi').value.trim(),
      supportNote: $('#s-support-note').value.trim(),
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
    downloadJson('bootstraps-export.json', data);
    toast('Exported', 'ok');
  };
}
