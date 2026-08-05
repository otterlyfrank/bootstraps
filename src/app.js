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
  importAllData,
} from './storage/db.js';
import {
  syncRemotive,
  normalizeManual,
  rescoreAllJobs,
  importBulkJobs,
} from './jobs/sources.js';
import { parseJobLinks } from './jobs/links.js';
import {
  loadSourceCatalog,
  checkDiscovery,
  discoverJobs,
  huntFromResume,
  buildHuntPlan,
  importJobLinksRobust,
  defaultSearchFromProfile,
  DISCOVERY_SOURCES,
  loadCustomSources,
  saveCustomSources,
  clearCustomSources,
} from './jobs/discovery.js';
import { scoreJob, buildDigest, inferDomains } from './jobs/match.js';
import { domainPerformance, appsForDomain } from './jobs/learning.js';
import { buildLocalPrep } from './jobs/hints.js';
import { chatCompletion, checkLlm, formatUsd } from './ai/client.js';
import { prepareApplicationPrompt, domainFailurePrompt, parseModelJson, huntQueriesPrompt } from './ai/prompts.js';
import { ingestResumeFile } from './resume/ingest.js';
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
import {
  filterJobs,
  dealBreakerHits,
  overdueApplications,
  dueThisWeek,
  daysFromNow,
  formatTouchDate,
} from './lib/job-filters.js';
import {
  normalizePreset,
  presetsFromSettings,
  upsertPreset,
  removePreset,
  exportPresetsJson,
  importPresetsJson,
} from './lib/hunt-presets.js';
import { wizardSteps, wizardComplete } from './lib/onboarding-wizard.js';
import { trapFocus, wireDialog, prefersReducedMotion } from './lib/a11y.js';
import { $, esc, toast } from './ui/dom.js';
import {
  scoreBreakdownHtml,
  scoreRingHtml,
  matchChipsHtml,
} from './ui/score-ui.js';
import { jobCardHtml, bindJobCards as bindJobCardsUi } from './ui/job-cards.js';
import { climbTimelineHtml } from './ui/climb-timeline.js';
import { openCommandPalette, buildBootstrapsCommands } from './ui/command-palette.js';
import { openPrintablePack, applicationPackMarkdown } from './ui/print-pack.js';
import { renderDiscoverProgress, clearDiscoverProgress } from './ui/discover-progress.js';
import {
  restoreSessionMode,
  toggleSessionMode,
  isSessionMode,
  sessionHudHtml,
  setSessionMode,
} from './ui/session-mode.js';

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
  /** @type {'all' | 'worth' | 'shortlist'} */
  jobShelf: 'worth',
  appFilter: 'all',
  appDomain: '',
  /** @type {'pipeline' | 'list'} */
  appView: 'pipeline',
  busy: false,
  /** job id for detail drawer */
  drawerJobId: null,
  /** Last hunt summary for results ribbon */
  lastHuntResult: null,
  /** Mobile "More" sheet open */
  mobileMoreOpen: false,
  /** Job list page (0-based) for pagination */
  jobPage: 0,
  /** Session mode prepare counter (local, resets daily via date key) */
  sessionPrepared: 0,
  sessionPreparedDay: '',
};

const JOBS_PER_PAGE = 40;

let rootEl = null;
/** True after first shell build — content-only re-renders after that */
let shellBuilt = false;
/** Active dialog focus-release */
let activeDialogRelease = null;

export async function mountApp(root) {
  rootEl = root;
  await reloadAll();
  restoreSessionMode();
  restoreSessionPrepared();
  render();
  // Re-render when browser becomes installable / after install
  window.addEventListener('bootstraps-toast', (e) => {
    const d = e.detail || {};
    if (d.msg) toast(d.msg, d.kind || 'ok');
  });
  window.addEventListener('bootstraps-open-install', () => {
    state.view = 'settings';
    render();
    requestAnimationFrame(() => {
      const card = document.getElementById('pwa-install-card');
      const howto = document.getElementById('pwa-howto');
      if (howto) howto.hidden = false;
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
  window.addEventListener('bootstraps-pwa-change', () => {
    if (rootEl) render();
  });
  window.addEventListener('bootstraps-session-change', () => {
    if (rootEl) render();
  });
  window.addEventListener('keydown', onGlobalKeydown);
  if (!wizardComplete(state) && !state.settings?.onboardingDone) {
    requestAnimationFrame(() => openOnboardingWizard());
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function restoreSessionPrepared() {
  try {
    const raw = localStorage.getItem('bootstraps-session-prep');
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o.day === todayKey()) {
      state.sessionPrepared = Number(o.n) || 0;
      state.sessionPreparedDay = o.day;
    }
  } catch {
    /* */
  }
}

function bumpSessionPrepared() {
  const day = todayKey();
  if (state.sessionPreparedDay !== day) {
    state.sessionPreparedDay = day;
    state.sessionPrepared = 0;
  }
  state.sessionPrepared += 1;
  try {
    localStorage.setItem(
      'bootstraps-session-prep',
      JSON.stringify({ day, n: state.sessionPrepared })
    );
  } catch {
    /* */
  }
}

function goView(view) {
  state.view = view;
  state.mobileMoreOpen = false;
  render();
}

function openPalette() {
  openCommandPalette(
    buildBootstrapsCommands({
      go: (v) => goView(v),
      hunt: () => {
        goView('jobs');
        requestAnimationFrame(() => $('#disc-hunt')?.click() || $('#j-discover')?.click());
      },
      upload: () => {
        goView('resumes');
        requestAnimationFrame(() => $('#resume-file')?.click());
      },
      refreshHunt: () => refreshLastHunt(),
      toggleSession: () => {
        const on = toggleSessionMode();
        toast(on ? 'Session mode on — focus the hunt' : 'Session mode off', 'ok');
        render();
      },
      exportData: async () => {
        const data = await exportAllData();
        downloadJson('bootstraps-export.json', data);
        toast('Exported full backup', 'ok');
      },
      sample: async () => {
        await loadSamplePack();
        await reloadAll();
        toast('Sample loaded', 'ok');
        render();
      },
    })
  );
}

function onGlobalKeydown(e) {
  // Command palette — works even from inputs if meta/ctrl
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
    return;
  }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Don't steal keys while a modal/drawer is open
  if (document.querySelector('.modal-backdrop, .drawer-backdrop, .mobile-more-sheet.open')) return;
  const k = e.key.toLowerCase();
  if (k === 't') {
    e.preventDefault();
    goView('ats');
  } else if (k === 'h') {
    e.preventDefault();
    goView('jobs');
    requestAnimationFrame(() => $('#disc-hunt')?.click() || $('#j-discover')?.click());
  } else if (k === 'u') {
    e.preventDefault();
    goView('resumes');
    requestAnimationFrame(() => $('#resume-file')?.click());
  } else if (k === 'j') {
    e.preventDefault();
    goView('jobs');
  } else if (k === 'a') {
    e.preventDefault();
    goView('applications');
  } else if (k === 'd') {
    e.preventDefault();
    goView('dashboard');
  } else if (k === 'r' && state.settings?.lastHunt) {
    e.preventDefault();
    refreshLastHunt();
  } else if (k === 's') {
    e.preventDefault();
    const on = toggleSessionMode();
    toast(on ? 'Session mode on' : 'Session mode off', 'ok');
    render();
  } else if (k === '?' || k === '/') {
    e.preventDefault();
    toast('⌘K palette · H hunt · T ATS · U upload · J jobs · A pipeline · D home · S session · R refresh', 'ok');
  }
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

/** Visible jobs for board/digest given shelf + settings. */
function visibleJobs(shelf = state.jobShelf) {
  const floor = Number(state.settings?.minJobScore ?? 35);
  const hard = !!state.settings?.hardScoreFilter;
  const minScore =
    shelf === 'shortlist' ? 0 : shelf === 'all' && !hard ? 0 : floor;
  return filterJobs(state.jobs, {
    minScore,
    scoreFloor: floor,
    hardScoreFilter: shelf === 'all' && hard,
    shortlistedOnly: shelf === 'shortlist',
    hideDealBreakers: state.settings?.hideDealBreakers !== false,
    requireEnglish: !!state.settings?.requireEnglish,
    hideApplied: shelf === 'worth',
    appliedIds: appliedJobIds(),
    profile: state.profile,
    q: state.jobQ,
  });
}

function shortlistCount() {
  return state.jobs.filter((j) => j.shortlisted && !j.dismissed).length;
}

async function saveLastHunt(plan, extras = {}) {
  const lastHunt = {
    queries: plan?.queries || extras.queries || [],
    sources: plan?.sources || extras.sources || [],
    minScore: plan?.minScore ?? extras.minScore ?? 35,
    limit: plan?.limit ?? extras.limit ?? 50,
    at: Date.now(),
  };
  state.settings = await setSettings({ lastHunt });
}

async function refreshLastHunt() {
  const h = state.settings?.lastHunt;
  if (!h?.queries?.length && !h?.sources?.length) {
    toast('No saved hunt yet — run Hunt from resume first', 'err');
    state.view = 'jobs';
    render();
    return;
  }
  if (state.busy) return;
  state.busy = true;
  toast('Refreshing last hunt…');
  try {
    const r = await huntFromResume(state.profile, resumeBody(), state.settings.domains, {
      sources: h.sources,
      minScore: h.minScore ?? 35,
      limit: h.limit ?? 50,
      extraQueries: h.queries,
    });
    await saveLastHunt(r.plan || h);
    await reloadAll();
    const floor = h.minScore ?? 35;
    const top = (r.allScored || r.jobs || []).filter((j) => (j.score || 0) >= floor).length;
    state.lastHuntResult = {
      total: r.total || 0,
      added: r.added || 0,
      updated: r.updated || 0,
      aboveFloor: top,
      queries: r.queries || h.queries || [],
      at: Date.now(),
    };
    toast(`Refresh: +${r.added} · ${r.updated} updated · ${r.total} pulled`, r.total ? 'ok' : 'err');
    state.view = 'jobs';
    state.jobShelf = 'worth';
    state.jobPage = 0;
    render();
  } catch (err) {
    toast(err.message || String(err), 'err');
  } finally {
    state.busy = false;
  }
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
      label: 'Upload PDF resume (or paste) — Grok fills profile',
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
      label: 'Run Hunt from resume (or paste links)',
      done: hasJobs,
      view: 'jobs',
    },
    {
      id: 'apply',
      label: 'Shortlist or log your first application',
      done: hasApps || state.jobs.some((j) => j.shortlisted),
      view: hasJobs ? 'jobs' : 'jobs',
    },
    {
      id: 'api',
      label: 'Optional: Grok API key for polish & domain analysis',
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

function huntResultsRibbonHtml() {
  const r = state.lastHuntResult;
  if (!r) return '';
  return `<div class="hunt-ribbon" role="status">
    <div class="hunt-ribbon-nums">
      <span><strong class="count-up" data-n="${r.total || 0}">${r.total || 0}</strong> pulled</span>
      <span><strong>${r.added || 0}</strong> new</span>
      <span><strong>${r.aboveFloor || 0}</strong> ≥ floor</span>
      <span><strong>${r.updated || 0}</strong> updated</span>
    </div>
    <p class="dim hunt-ribbon-q">${esc((r.queries || []).slice(0, 4).join(' · ') || 'Hunt complete')}</p>
    <button type="button" class="btn ghost" id="ribbon-dismiss" aria-label="Dismiss hunt results">Dismiss</button>
  </div>`;
}

function wireHuntRibbon(root) {
  $('#ribbon-dismiss', root)?.addEventListener('click', () => {
    state.lastHuntResult = null;
    render();
  });
}

// ── Shell ──────────────────────────────────────────────────

function moreNavIds() {
  return ['resumes', 'settings', 'digest', 'domains', 'profile'];
}

function navBtn(id, label, extraClass = '') {
  const active = state.view === id;
  const cur = active ? ' aria-current="page"' : '';
  return `<button type="button" class="nav-btn ${active ? 'active' : ''} ${extraClass}" data-nav="${id}"${cur}>${label}</button>`;
}

function mobileNavHtml() {
  const item = (id, label, icon) => {
    const active =
      state.view === id ||
      (id === 'more' && moreNavIds().includes(state.view));
    return `<button type="button" class="mobile-nav-btn ${active ? 'active' : ''}" data-nav="${id}" ${
      active && id !== 'more' ? 'aria-current="page"' : ''
    }>
      <span class="mobile-nav-icon" aria-hidden="true">${icon}</span>
      <span>${label}</span>
    </button>`;
  };
  return `
    <nav class="mobile-nav" aria-label="Primary">
      ${item('dashboard', 'Home', '⌂')}
      ${item('jobs', 'Hunt', '◎')}
      ${item('ats', 'ATS', '✎')}
      ${item('applications', 'Pipeline', '▤')}
      ${item('more', 'More', '⋯')}
    </nav>
    <div class="mobile-more-sheet ${state.mobileMoreOpen ? 'open' : ''}" id="mobile-more-sheet" ${
      state.mobileMoreOpen ? '' : 'hidden'
    }>
      <div class="mobile-more-panel" role="dialog" aria-label="More navigation">
        <p class="mobile-more-title">More</p>
        ${navBtn('resumes', 'Resumes')}
        ${navBtn('settings', 'Settings')}
        ${navBtn('digest', 'Recommended')}
        ${navBtn('domains', 'Domain intel')}
        ${navBtn('profile', 'Profile')}
        <button type="button" class="btn ghost" id="mobile-more-close">Close</button>
      </div>
    </div>`;
}

function wireNavHandlers(scope = rootEl) {
  if (!scope) return;
  scope.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.nav;
      if (id === 'more') {
        state.mobileMoreOpen = !state.mobileMoreOpen;
        render();
        return;
      }
      state.mobileMoreOpen = false;
      state.view = id;
      state.jobPage = 0;
      await reloadAll();
      render();
      if (state.view === 'settings') {
        requestAnimationFrame(() =>
          $('#support')?.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          })
        );
      }
    };
  });
  $('#mobile-more-close', scope)?.addEventListener('click', () => {
    state.mobileMoreOpen = false;
    render();
  });
  $('#mobile-more-sheet', scope)?.addEventListener('click', (e) => {
    if (e.target.id === 'mobile-more-sheet') {
      state.mobileMoreOpen = false;
      render();
    }
  });
}

function updateShellChrome() {
  if (!rootEl) return;
  const title = $('#topbar-title', rootEl);
  if (title) title.textContent = viewTitle();
  const usage = $('#shell-usage', rootEl);
  if (usage) {
    usage.textContent = `AI ~${formatUsd(state.usage.estCostUsd)} · ${state.usage.totalTokens || 0} tok`;
  }
  const sessBtn = $('#shell-session', rootEl);
  if (sessBtn) sessBtn.textContent = isSessionMode() ? 'Exit session' : 'Session';
  // Re-sync active nav states without full shell rebuild
  rootEl.querySelectorAll('[data-nav]').forEach((btn) => {
    const id = btn.dataset.nav;
    if (id === 'more') {
      const on = moreNavIds().includes(state.view) || state.mobileMoreOpen;
      btn.classList.toggle('active', on);
      return;
    }
    const active = state.view === id;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  const sheet = $('#mobile-more-sheet', rootEl);
  if (sheet) {
    sheet.hidden = !state.mobileMoreOpen;
    sheet.classList.toggle('open', state.mobileMoreOpen);
  }
  const pwaSlot = $('.pwa-side-slot', rootEl);
  if (pwaSlot) pwaSlot.innerHTML = installUiHtml('compact');
}

function buildShell() {
  rootEl.innerHTML = `
    <a class="skip-link" href="#view-root">Skip to content</a>
    <aside class="sidebar" aria-label="Sidebar">
      <div class="brand">
        <img class="brand-logo" src="./public/bootstraps-logo.jpg" alt="Bootstraps — pull yourself up by the bootstraps" width="52" height="52" />
        <div>
          <h1>${APP_NAME}</h1>
          <p>Hunt · ATS · climb</p>
        </div>
      </div>
      ${navBtn('dashboard', 'Home')}
      ${navBtn('jobs', 'Hunt')}
      ${navBtn('ats', 'ATS')}
      ${navBtn('applications', 'Pipeline')}
      ${navBtn('resumes', 'Resumes')}
      ${navBtn('settings', 'Settings')}
      <details class="nav-more ${moreNavIds().filter((id) => !['resumes', 'settings'].includes(id)).includes(state.view) ? 'open' : ''}">
        <summary class="nav-more-sum">More</summary>
        ${navBtn('digest', 'Recommended')}
        ${navBtn('domains', 'Domain intel')}
        ${navBtn('profile', 'Profile')}
      </details>
      <div class="sidebar-foot">
        <p>Local-first · optional Grok</p>
        <p class="usage-chip" id="shell-usage" style="display:inline-block;margin-top:0.35rem">
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
        <h2 id="topbar-title">${esc(viewTitle())}</h2>
        <div class="topbar-actions-wrap">
          <button type="button" class="btn ghost" id="shell-palette" title="Command palette (⌘K)">⌘K</button>
          <button type="button" class="btn ghost" id="shell-session" title="Session mode (S)">${
            isSessionMode() ? 'Exit session' : 'Session'
          }</button>
          <div class="topbar-actions" id="top-actions"></div>
        </div>
      </header>
      <div class="content" id="view-root" tabindex="-1"></div>
    </div>
    ${mobileNavHtml()}
  `;
  wireNavHandlers(rootEl);
  $('#shell-palette', rootEl)?.addEventListener('click', () => openPalette());
  $('#shell-session', rootEl)?.addEventListener('click', () => {
    const on = toggleSessionMode();
    toast(on ? 'Session mode on' : 'Session mode off', 'ok');
    render({ forceShell: true });
  });
  shellBuilt = true;
}

function render(opts = {}) {
  if (!rootEl) return;
  if (!shellBuilt || opts.forceShell) {
    buildShell();
  } else {
    updateShellChrome();
    // Rebuild mobile more sheet content if structure drifted
    const sheet = $('#mobile-more-sheet', rootEl);
    if (sheet && state.mobileMoreOpen) {
      sheet.hidden = false;
      sheet.classList.add('open');
    }
  }
  const root = $('#view-root');
  const actions = $('#top-actions');
  if (!root || !actions) {
    buildShell();
    return render({ forceShell: true });
  }
  actions.innerHTML = '';
  root.innerHTML = '';
  const map = {
    dashboard: renderDashboard,
    digest: renderDigest,
    jobs: renderJobs,
    ats: renderAts,
    applications: renderApplications,
    resumes: renderResumes,
    domains: renderDomains,
    profile: renderProfile,
    settings: renderSettings,
  };
  (map[state.view] || renderDashboard)(root, actions);
  wireInstallButtons(rootEl);
  // Ensure nav still wired after shell rebuild
  if (opts.forceShell) wireNavHandlers(rootEl);
  wireSessionHud();
}

function wireSessionHud() {
  let hud = document.getElementById('session-hud-host');
  if (!isSessionMode()) {
    hud?.remove();
    return;
  }
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'session-hud-host';
    document.body.appendChild(hud);
  }
  const worth = visibleJobs('worth').length;
  hud.innerHTML = sessionHudHtml({
    prepareTarget: 5,
    preparedToday: state.sessionPrepared || 0,
    worthCount: worth,
  });
  $('#session-exit', hud)?.addEventListener('click', () => {
    setSessionMode(false);
    toast('Session mode off', 'ok');
    render();
  });
  $('#session-hunt', hud)?.addEventListener('click', () => {
    goView('jobs');
    requestAnimationFrame(() => $('#disc-hunt')?.click() || $('#j-discover')?.click());
  });
  $('#session-worth', hud)?.addEventListener('click', () => {
    state.jobShelf = 'worth';
    goView('jobs');
  });
}

function supportKofiUrl() {
  const raw = (state.settings?.supportKofi || '').trim();
  if (raw && raw !== 'https://ko-fi.com' && raw !== 'https://ko-fi.com/') return raw;
  return 'https://ko-fi.com/otterlyfrank';
}

/** True only when a real Sponsors URL is set (empty / generic placeholder = hide). */
function supportGithubUrl() {
  const raw = (state.settings?.supportGithubSponsors || '').trim();
  if (!raw) return '';
  if (/^https?:\/\/github\.com\/sponsors\/?$/i.test(raw)) return '';
  return raw;
}

function supportBlock() {
  const s = state.settings || {};
  const kofi = supportKofiUrl();
  const gh = supportGithubUrl();
  return `
    <div class="support-card" id="support">
      <h3>If Bootstraps helps you get hired</h3>
      <p>${esc(
        s.supportNote ||
          'This tool is free. If it helps you land a job, get interviews, or sharpen your resume — please donate. It funds continued development.'
      )}</p>
      <div class="support-links">
        <a class="btn primary" href="${esc(kofi)}" target="_blank" rel="noopener">Support on Ko-fi</a>
        ${
          gh
            ? `<a class="btn" href="${esc(gh)}" target="_blank" rel="noopener">GitHub Sponsors</a>`
            : ''
        }
      </div>
      <p class="dim" style="margin:0.75rem 0 0;font-size:0.82rem">Even a one-time coffee after an offer means a lot.</p>
    </div>`;
}

function viewTitle() {
  const t = {
    dashboard: 'Home',
    digest: 'Recommended',
    jobs: 'Hunt',
    ats: 'ATS generator',
    applications: 'Pipeline',
    resumes: 'Resumes',
    domains: 'Domain intel',
    profile: 'Profile',
    settings: 'Settings',
  };
  return t[state.view] || 'Bootstraps';
}

// ── Dashboard ──────────────────────────────────────────────


function openOnboardingWizard() {
  if (document.getElementById('wiz-backdrop')) return;
  const steps = wizardSteps(state);
  let step = Math.max(0, steps.findIndex((s) => !s.done));
  if (step < 0) step = steps.length - 1;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'wiz-backdrop';
  let release = null;
  const closeWizard = () => {
    release?.();
    release = null;
    backdrop.remove();
  };
  const paint = () => {
    const s = steps[step];
    const doneN = steps.filter((x) => x.done).length;
    release?.();
    backdrop.innerHTML = `
      <div class="modal wizard-modal" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
        <p class="dim" style="margin:0 0 0.35rem">Setup ${step + 1}/${steps.length} · ${doneN} complete</p>
        <div class="onboard-progress" aria-hidden="true"><i style="width:${Math.round(((step + 1) / steps.length) * 100)}%"></i></div>
        <h2 id="wiz-title" style="margin:0.75rem 0 0.35rem">${esc(s.title)}</h2>
        <p class="muted">${esc(s.body)}</p>
        <p class="dim">${s.done ? '✓ This step looks done.' : 'Not done yet — use the button below.'}</p>
        <div class="modal-actions" style="margin-top:1rem">
          <button type="button" class="btn ghost" id="wiz-skip">Skip for now</button>
          ${step > 0 ? '<button type="button" class="btn" id="wiz-back">Back</button>' : ''}
          <button type="button" class="btn primary" id="wiz-cta" data-autofocus>${esc(s.cta)}</button>
          <button type="button" class="btn" id="wiz-next">${step >= steps.length - 1 ? 'Finish' : 'Next'}</button>
        </div>
      </div>`;
    release = trapFocus(backdrop, { onEscape: closeWizard });
    $('#wiz-skip', backdrop).onclick = async () => {
      state.settings = await setSettings({ onboardingDone: true });
      closeWizard();
    };
    $('#wiz-back', backdrop)?.addEventListener('click', () => {
      step = Math.max(0, step - 1);
      paint();
    });
    $('#wiz-next', backdrop).onclick = async () => {
      if (step >= steps.length - 1) {
        state.settings = await setSettings({ onboardingDone: true });
        closeWizard();
        toast('Setup complete — daily loop is on the dashboard', 'ok');
        state.view = 'dashboard';
        render();
        return;
      }
      step++;
      paint();
    };
    $('#wiz-cta', backdrop).onclick = async () => {
      closeWizard();
      state.view = s.view;
      render();
      if (s.action === 'upload') {
        requestAnimationFrame(() => $('#resume-file')?.click());
      }
      if (s.action === 'hunt') {
        requestAnimationFrame(() => $('#disc-hunt')?.click());
      }
    };
  };
  document.body.appendChild(backdrop);
  paint();
}

function renderDashboard(root, actions) {
  const hasResume = !!resumeBody().trim();
  const hasKey = !!(state.settings?.llmApiKey || '').trim();
  const hasJobs = state.jobs.length > 0;
  const lastHunt = state.settings?.lastHunt;
  const worth = visibleJobs('worth').slice(0, 5);
  const shortlist = state.jobs.filter((j) => j.shortlisted && !j.dismissed).slice(0, 5);
  const overdue = overdueApplications(state.applications);
  const weekDue = dueThisWeek(state.applications);
  const prepareQueue = worth.slice(0, 3);
  const stats = domainStats();
  const flagged = stats.filter((d) => d.flagged);
  const apps = state.applications;
  const counts = {
    interview: apps.filter((a) => a.status === 'Interview').length,
    rejected: apps.filter((a) => a.status === 'Rejected').length,
    offer: apps.filter((a) => a.status === 'Offer').length,
  };
  const onboard = onboardingSteps();

  actions.innerHTML = `
    ${lastHunt ? `<button type="button" class="btn primary" id="d-refresh-hunt">Refresh hunt</button>` : ''}
    <button type="button" class="btn" id="d-sample">Sample data</button>
  `;

  if (!onboard.complete && !hasJobs) {
    root.innerHTML = `
      <section class="hero">
        <img class="hero-logo" src="./public/bootstraps-logo.jpg" alt="Bootstraps — pull yourself up by the bootstraps" />
        <div class="hero-copy">
          <p class="hero-kicker">${esc(APP_NAME)}</p>
          <h2 class="hero-tagline">${esc(APP_TAGLINE)}</h2>
          <p class="hero-sub muted">Upload → Hunt from resume → shortlist → prepare. The daily loop takes over after that.</p>
        </div>
      </section>
      <div class="first-run-grid">
        <button type="button" class="first-run-card" id="fr-resume">
          <span class="fr-n">1</span>
          <strong>Upload resume</strong>
          <span class="dim">PDF → Master, Working, Profile ${hasResume ? '✓' : ''}</span>
        </button>
        <button type="button" class="first-run-card" id="fr-hunt">
          <span class="fr-n">2</span>
          <strong>Hunt from resume</strong>
          <span class="dim">Public boards scored to you ${hasJobs ? '✓' : ''}</span>
        </button>
        <button type="button" class="first-run-card" id="fr-api">
          <span class="fr-n">3</span>
          <strong>Connect Grok</strong>
          <span class="dim">Optional polish + domain analysis ${hasKey ? '✓' : ''}</span>
        </button>
      </div>
      <p class="dim" style="margin-top:1rem">
        <button type="button" class="btn primary" id="fr-wizard">Guided setup</button>
        Or <button type="button" class="btn" id="onboard-sample">load sample data</button>
      </p>
      ${supportBlock()}
    `;
    $('#fr-api').onclick = () => { state.view = 'settings'; render(); };
    $('#fr-resume').onclick = () => {
      state.view = 'resumes';
      render();
      requestAnimationFrame(() => $('#resume-file')?.click());
    };
    $('#fr-hunt').onclick = () => {
      state.view = 'jobs';
      render();
      requestAnimationFrame(() => $('#disc-hunt')?.click());
    };
    $('#fr-wizard')?.addEventListener('click', () => openOnboardingWizard());
    $('#onboard-sample')?.addEventListener('click', async () => {
      try {
        await loadSamplePack();
        await reloadAll();
        toast('Sample loaded', 'ok');
        render();
      } catch (e) {
        toast(e.message || String(e), 'err');
      }
    });
    $('#d-refresh-hunt')?.addEventListener('click', () => refreshLastHunt());
    $('#d-sample')?.addEventListener('click', () => $('#onboard-sample')?.click());
    return;
  }

  root.innerHTML = `
    <section class="hero compact-hero">
      <img class="hero-logo" src="./public/bootstraps-logo.jpg" alt="Bootstraps — pull yourself up by the bootstraps" />
      <div class="hero-copy">
        <p class="hero-kicker">Daily loop</p>
        <h2 class="hero-tagline">Hunt · shortlist · prepare · follow up</h2>
        <p class="hero-sub muted">Score floor ${state.settings?.minJobScore ?? 35} · shortlist ${shortlistCount()} · overdue ${overdue.length}</p>
      </div>
    </section>
    ${huntResultsRibbonHtml()}

    <div class="daily-loop">
      <div class="loop-step ${hasResume ? 'done' : ''}">
        <span class="loop-n">1</span>
        <div>
          <strong>Resume</strong>
          <p class="dim">${hasResume ? 'Working resume ready' : 'Upload PDF to populate profile'}</p>
        </div>
        <button type="button" class="btn ${hasResume ? '' : 'primary'}" data-go="resumes">${hasResume ? 'Update' : 'Upload'}</button>
      </div>
      <div class="loop-step ${hasJobs ? 'done' : ''}">
        <span class="loop-n">2</span>
        <div>
          <strong>Hunt</strong>
          <p class="dim">${lastHunt ? `Last: ${formatDate(lastHunt.at)}` : 'Multi-board from your resume'}</p>
        </div>
        <div class="row-actions">
          ${lastHunt ? `<button type="button" class="btn primary" id="loop-refresh">Refresh</button>` : ''}
          <button type="button" class="btn primary" id="loop-hunt">Hunt</button>
        </div>
      </div>
      <div class="loop-step">
        <span class="loop-n">3</span>
        <div>
          <strong>Decide</strong>
          <p class="dim">${worth.length} worth applying · ${shortlistCount()} shortlisted</p>
        </div>
        <button type="button" class="btn" data-go="jobs">Board</button>
      </div>
      <div class="loop-step ${overdue.length ? 'warn' : ''}">
        <span class="loop-n">4</span>
        <div>
          <strong>Follow up</strong>
          <p class="dim">${overdue.length} overdue · ${weekDue.length} this week</p>
        </div>
        <button type="button" class="btn" data-go="applications">Apps</button>
      </div>
    </div>

    ${
      overdue.length
        ? `<div class="banner warn">
            <h3>Follow-ups due</h3>
            <ul class="touch-list">
              ${overdue
                .slice(0, 5)
                .map(
                  (a) =>
                    `<li><strong>${esc(a.title)}</strong> · ${esc(a.company)} · ${formatTouchDate(a.nextTouchAt)}
                    <button type="button" class="btn ghost" data-open-app="${a.id}">Open</button></li>`
                )
                .join('')}
            </ul>
          </div>`
        : ''
    }

    ${
      flagged.length
        ? `<div class="banner warn">
            <h3>Domain pressure</h3>
            <p class="muted" style="margin:0 0 0.5rem">${flagged
              .map((f) => `<strong>${esc(f.domain)}</strong>: ${esc(f.reason)}`)
              .join('<br/>')}</p>
            <button type="button" class="btn primary" id="go-domains">Domain intel</button>
          </div>`
        : ''
    }

    <div class="stat-row">
      <div class="stat"><div class="n">${apps.length}</div><div class="l">Applications</div></div>
      <div class="stat"><div class="n">${counts.interview}</div><div class="l">Interviews</div></div>
      <div class="stat"><div class="n">${counts.rejected}</div><div class="l">Rejected</div></div>
      <div class="stat"><div class="n">${counts.offer}</div><div class="l">Offers</div></div>
      <div class="stat"><div class="n">${worth.length}</div><div class="l">Worth applying</div></div>
      <div class="stat"><div class="n">${shortlistCount()}</div><div class="l">Shortlist</div></div>
    </div>

    <div class="dash-split">
      <div>
        <h3 style="font-family:var(--serif);margin:1.1rem 0 0.5rem">Prepare next (${prepareQueue.length})</h3>
        <div class="job-list">
          ${
            prepareQueue.length
              ? prepareQueue.map((j) => jobCardHtml(j, { compact: true })).join('')
              : `<div class="empty"><p>No high-score unapplied roles. Run <strong>Hunt</strong> or lower min score on the Job board.</p></div>`
          }
        </div>
      </div>
      <div>
        <h3 style="font-family:var(--serif);margin:1.1rem 0 0.5rem">Shortlist</h3>
        <div class="job-list">
          ${
            shortlist.length
              ? shortlist.map((j) => jobCardHtml(j, { compact: true })).join('')
              : `<div class="empty"><p>Star roles with ★ on the job board to build a shortlist.</p></div>`
          }
        </div>
      </div>
    </div>
    <div class="weekly-review">
      <h3 style="margin:0 0 0.35rem;font-family:var(--serif)">This week at a glance</h3>
      <p class="muted" style="margin:0">
        Applied ${apps.filter((a) => a.appliedAt && a.appliedAt > Date.now() - 7 * 86400000).length}
        · Interviews ${counts.interview}
        · Rejected ${counts.rejected}
        · Offers ${counts.offer}
        · Flagged domains ${flagged.length}
        · Jobs in library ${state.jobs.length}
      </p>
      <p class="dim" style="margin:0.4rem 0 0">Keys: <kbd>⌘K</kbd> palette · <kbd>H</kbd> hunt · <kbd>S</kbd> session · <kbd>T</kbd> ATS · <kbd>?</kbd> help</p>
    </div>
    ${climbTimelineHtml(state.applications, state.history)}
    ${supportBlock()}
  `;

  $('#d-refresh-hunt')?.addEventListener('click', () => refreshLastHunt());
  $('#d-sample')?.addEventListener('click', async () => {
    try {
      await loadSamplePack();
      await reloadAll();
      toast('Sample loaded', 'ok');
      render();
    } catch (e) {
      toast(e.message || String(e), 'err');
    }
  });
  $('#loop-refresh')?.addEventListener('click', () => refreshLastHunt());
  $('#loop-hunt')?.addEventListener('click', () => {
    state.view = 'jobs';
    render();
    requestAnimationFrame(() => $('#disc-hunt')?.click());
  });
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
  root.querySelectorAll('[data-open-app]').forEach((btn) => {
    btn.onclick = () => {
      state.view = 'applications';
      render();
      requestAnimationFrame(() => openAppEditor(btn.dataset.openApp));
    };
  });
  wireHuntRibbon(root);
  bindJobCards(root);
}

// ── Digest ─────────────────────────────────────────────────

function renderDigest(root, actions) {
  actions.innerHTML = `<button type="button" class="btn primary" id="dig-refresh">Refresh scores</button>`;
  // Worth-applying shelf = digest with score floor + no deal-breakers
  const digest = visibleJobs('worth').slice(0, DIGEST_SIZE.max);
  root.innerHTML = `
    <p class="muted" style="margin-top:0">Worth applying: score ≥ <strong>${state.settings?.minJobScore ?? 35}</strong>, deal-breakers hidden, not yet applied. Aim for ${DIGEST_SIZE.min}–${DIGEST_SIZE.max} intentional apps.</p>
    <div class="job-list">
      ${
        digest.length
          ? digest.map((j) => jobCardHtml(j)).join('')
          : `<div class="empty"><h3>Digest empty</h3><p>Run <strong>Hunt from resume</strong> or lower the min score on the Job board.</p></div>`
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
  const minScore = Number(state.settings?.minJobScore ?? 35);
  const hideDb = state.settings?.hideDealBreakers !== false;
  const requireEn = !!state.settings?.requireEnglish;
  const lastHunt = state.settings?.lastHunt;
  actions.innerHTML = `
    ${lastHunt ? `<button type="button" class="btn" id="j-refresh" title="Re-run last hunt">Refresh</button>` : ''}
    <button type="button" class="btn primary" id="j-discover">Hunt</button>
    <button type="button" class="btn" id="j-links">Links</button>
    <div class="topbar-more">
      <details>
        <summary class="btn">More</summary>
        <div class="topbar-menu">
          <button type="button" class="btn ghost" id="j-bulk">Bulk import</button>
          <button type="button" class="btn ghost" id="j-manual">Add manual</button>
          <button type="button" class="btn ghost" id="j-ats">Open ATS page</button>
        </div>
      </details>
    </div>
  `;
  let jobs = visibleJobs(state.jobShelf);
  const totalJobs = jobs.length;
  const totalPages = Math.max(1, Math.ceil(totalJobs / JOBS_PER_PAGE));
  if (state.jobPage >= totalPages) state.jobPage = Math.max(0, totalPages - 1);
  const pageJobs = jobs.slice(
    state.jobPage * JOBS_PER_PAGE,
    state.jobPage * JOBS_PER_PAGE + JOBS_PER_PAGE
  );
  const shelfBtn = (id, label, count) =>
    `<button type="button" class="btn ${state.jobShelf === id ? 'primary' : ''}" data-shelf="${id}">${label}${count != null ? ` (${count})` : ''}</button>`;
  const worthN = visibleJobs('worth').length;
  const allN = filterJobs(state.jobs, {
    minScore: 0,
    hideDealBreakers: hideDb,
    requireEnglish: requireEn,
    profile: state.profile,
    q: state.jobQ,
  }).length;

  root.innerHTML = `
    ${huntResultsRibbonHtml()}
    <div id="discovery-panel" class="discovery-panel"></div>
    <div class="filter-row job-filter-bar">
      ${shelfBtn('worth', 'Worth applying', worthN)}
      ${shelfBtn('shortlist', 'Shortlist', shortlistCount())}
      ${shelfBtn('all', 'All scored', allN)}
      <label class="filter-inline">Min score
        <input type="number" id="job-minscore" min="0" max="100" value="${minScore}" style="width:4rem" />
      </label>
      <label class="filter-inline check-inline">
        <input type="checkbox" id="job-hidedb" ${hideDb ? 'checked' : ''} /> Hide deal-breakers
      </label>
      <label class="filter-inline check-inline" title="Apply min score even on All scored">
        <input type="checkbox" id="job-hard" ${state.settings?.hardScoreFilter ? 'checked' : ''} /> Hard score filter
      </label>
      <label class="filter-inline check-inline" title="Only roles that mention English / angol requirement (or EN-written JDs on HU boards)">
        <input type="checkbox" id="job-require-en" ${requireEn ? 'checked' : ''} /> English required
      </label>
      <input class="search" id="job-q" placeholder="Filter…" value="${esc(state.jobQ)}" />
      <span class="dim">${totalJobs} shown${totalJobs > JOBS_PER_PAGE ? ` · page ${state.jobPage + 1}/${totalPages}` : ''}</span>
    </div>
    <div class="job-list">
      ${
        pageJobs.length
          ? pageJobs.map((j) => jobCardHtml(j)).join('')
          : `<div class="empty"><h3>Nothing on this shelf</h3>
             <p>${
               state.jobShelf === 'shortlist'
                 ? 'Star jobs with ☆ to shortlist them.'
                 : state.jobShelf === 'worth'
                   ? 'No unapplied roles above the score floor. Run <strong>Hunt from resume</strong>, lower min score, or open <strong>All scored</strong>.'
                   : 'Run <strong>Hunt from resume</strong> or paste links to populate the board.'
             }</p></div>`
      }
    </div>
    ${
      totalPages > 1
        ? `<div class="pager row-actions" style="margin-top:0.75rem">
            <button type="button" class="btn" id="job-prev" ${state.jobPage <= 0 ? 'disabled' : ''}>Previous</button>
            <span class="dim">Page ${state.jobPage + 1} of ${totalPages}</span>
            <button type="button" class="btn" id="job-next" ${state.jobPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
          </div>`
        : ''
    }
    <div id="job-drawer-host"></div>
  `;
  mountDiscoveryPanel($('#discovery-panel'));
  if (state.drawerJobId) openJobDrawer(state.drawerJobId, { skipRender: true, host: $('#job-drawer-host') });
  wireHuntRibbon(root);

  $('#job-prev')?.addEventListener('click', () => {
    state.jobPage = Math.max(0, state.jobPage - 1);
    render();
  });
  $('#job-next')?.addEventListener('click', () => {
    state.jobPage = Math.min(totalPages - 1, state.jobPage + 1);
    render();
  });
  $('#j-refresh')?.addEventListener('click', () => refreshLastHunt());
  $('#j-discover').onclick = () => {
    const panel = $('#discovery-panel');
    if (panel) {
      panel.hidden = false;
      panel.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      });
    }
  };
  $('#j-manual').onclick = () => openManualJob();
  $('#j-bulk').onclick = () => openBulkImport();
  $('#j-links').onclick = () => openPasteLinks();
  $('#j-ats')?.addEventListener('click', () => {
    state.view = 'ats';
    render();
  });
  root.querySelectorAll('[data-shelf]').forEach((btn) => {
    btn.onclick = () => {
      state.jobShelf = btn.dataset.shelf;
      state.jobPage = 0;
      render();
    };
  });
  $('#job-minscore').onchange = async (e) => {
    state.settings = await setSettings({ minJobScore: Number(e.target.value) || 0 });
    state.jobPage = 0;
    render();
  };
  $('#job-require-en')?.addEventListener('change', async (e) => {
    state.settings = await setSettings({ requireEnglish: !!e.target.checked });
    state.jobPage = 0;
    render();
  });
  $('#job-hidedb').onchange = async (e) => {
    state.settings = await setSettings({ hideDealBreakers: e.target.checked });
    state.jobPage = 0;
    render();
  };
  $('#job-hard')?.addEventListener('change', async (e) => {
    state.settings = await setSettings({ hardScoreFilter: e.target.checked });
    state.jobPage = 0;
    render();
  });
  let jobQTimer = null;
  $('#job-q').addEventListener('input', (e) => {
    clearTimeout(jobQTimer);
    jobQTimer = setTimeout(() => {
      state.jobQ = e.target.value.trim();
      state.jobPage = 0;
      render();
    }, 220);
  });
  $('#job-q').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      clearTimeout(jobQTimer);
      state.jobQ = e.target.value.trim();
      state.jobPage = 0;
      render();
    }
  });
  bindJobCards(root);
}

function bindJobCards(root) {
  bindJobCardsUi(root, {
    jobs: state.jobs,
    prepareForJob,
    logApplyFromJob,
    openJobDrawer,
    onDismiss: async (job) => {
      await putJob({ ...job, dismissed: true });
      await reloadAll();
      render();
    },
    onStar: async (job) => {
      await putJob({ ...job, shortlisted: !job.shortlisted });
      await reloadAll();
      render();
    },
  });
}

async function mountDiscoveryPanel(host) {
  if (!host) return;
  const catalog = await loadSourceCatalog();
  const health = await checkDiscovery();
  const plan = buildHuntPlan(state.profile, resumeBody());
  const defaultSearch = defaultSearchFromProfile(state.profile);
  const sources = catalog.length ? catalog : DISCOVERY_SOURCES;
  const hasResume = !!resumeBody().trim();
  const lastHunt = state.settings?.lastHunt;
  const presets = presetsFromSettings(state.settings);
  let sourceHealth = {};
  try {
    const hr = await fetch('/api/source-health');
    if (hr.ok) {
      const hd = await hr.json();
      sourceHealth = hd.health || {};
    }
  } catch {
    /* offline */
  }

  host.hidden = false;
  host.innerHTML = `
    <div class="card discovery-card">
      <div class="discovery-head">
        <div>
          <h3 style="margin:0">Automated job hunt</h3>
          <p class="dim" style="margin:0.25rem 0 0">
            Public remote boards only (not LinkedIn/Indeed). Queries from your resume + profile, then local scoring.
          </p>
        </div>
        <span class="tag ${health.discover ? '' : 'soft'}">${
          health.discover ? 'API ready' : esc(health.reason || 'restart ./start.sh')
        }</span>
      </div>

      <div class="hunt-plan">
        <div class="hunt-plan-label">Hunt plan</div>
        <div class="hunt-queries">
          ${
            plan.queries.length
              ? plan.queries.map((q) => `<span class="tag hunt-q">${esc(q)}</span>`).join('')
              : '<span class="dim">Upload a resume or fill Profile skills first</span>'
          }
        </div>
        <p class="dim" style="margin:0.4rem 0 0">
          Min score <strong id="plan-minscore-label">${state.settings?.minJobScore ?? plan.minScore}</strong>
          ${hasResume ? '' : ' · <span style="color:var(--warn)">no Working resume</span>'}
          ${lastHunt ? ` · last run ${formatDate(lastHunt.at)}` : ''}
        </p>
      </div>

      <div class="field" style="margin-top:0.75rem">
        <label>Hunt presets</label>
        <div class="row-actions" style="flex-wrap:wrap;gap:0.4rem;align-items:center">
          <select id="disc-preset" style="max-width:14rem">
            <option value="">— load preset —</option>
            ${presets.map((pr) => `<option value="${esc(pr.id)}">${esc(pr.name)}</option>`).join('')}
          </select>
          <button type="button" class="btn" id="disc-load-preset">Load</button>
          <button type="button" class="btn" id="disc-save-preset">Save current as preset</button>
          <button type="button" class="btn ghost" id="disc-del-preset">Delete</button>
        </div>
      </div>

      <div class="row-actions" style="margin-top:0.85rem;flex-wrap:wrap;gap:0.5rem">
        <button type="button" class="btn primary" id="disc-hunt" ${
          !hasResume || !health.discover ? 'disabled' : ''
        }>Hunt from resume</button>
        ${lastHunt ? `<button type="button" class="btn primary" id="disc-refresh">Refresh last hunt</button>` : ''}
        <button type="button" class="btn" id="disc-run">Custom discover</button>
        <button type="button" class="btn ghost" id="disc-grok-q">Grok refine queries</button>
        <button type="button" class="btn" id="disc-links">Paste links…</button>
        <button type="button" class="btn ghost" id="disc-hide">Hide</button>
      </div>

      <details class="disc-advanced" style="margin-top:0.85rem">
        <summary>Advanced — sources &amp; limits</summary>
        <div class="field" style="margin-top:0.75rem">
          <label>Extra keywords (comma-separated)</label>
          <input id="disc-search" value="${esc(defaultSearch)}" />
        </div>
        <div class="field">
          <label>Sources</label>
          <div class="source-grid">
            ${sources
              .map(
                (s) => `
              <label class="source-chip ${s.local ? 'tier-research' : s.tier === 'research' ? 'tier-research' : s.custom || s.tier === 'custom' ? 'tier-custom' : ''}">
                <input type="checkbox" data-source="${esc(s.id)}" ${s.default ? 'checked' : ''} />
                <span><strong>${esc(s.name)}</strong>
                  ${
                    s.local
                      ? '<span class="tag soft" style="font-size:0.65rem;margin-left:0.25rem">local</span>'
                      : s.tier === 'research'
                        ? '<span class="tag soft" style="font-size:0.65rem;margin-left:0.25rem">research</span>'
                        : s.custom || s.tier === 'custom'
                          ? '<span class="tag soft" style="font-size:0.65rem;margin-left:0.25rem">custom</span>'
                          : ''
                  }
                  <span class="src-health ${sourceHealth[s.id]?.ok ? 'ok' : sourceHealth[s.id] ? 'err' : ''}" title="${esc(sourceHealth[s.id]?.error || (sourceHealth[s.id]?.ok ? 'ok' : 'unknown'))}">${
                    sourceHealth[s.id]?.ok ? '●' : sourceHealth[s.id] ? '○' : '·'
                  }</span>
                  <br/><span class="dim">${esc(s.blurb || '')}</span></span>
              </label>`
              )
              .join('')}
          </div>
          <p class="dim" style="margin:0.45rem 0 0;font-size:0.8rem">
            Public boards default on. <strong>Research</strong> boards (Workew, RWFA, Solana, BlackRock Budapest) stay off unless you check them.
            <strong>Custom</strong> sources come from your uploaded scrape pack (below).
          </p>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Max roles</label>
            <input id="disc-limit" type="number" min="10" max="100" value="50" />
          </div>
          <div class="field">
            <label>Min score floor</label>
            <input id="disc-minscore" type="number" min="0" max="100" value="${state.settings?.minJobScore ?? plan.minScore}" />
          </div>
        </div>
        <div class="field custom-sources-panel" style="margin-top:1rem">
          <label>Custom scrape sources (upload for any board)</label>
          <p class="dim" style="margin:0.25rem 0 0.5rem;font-size:0.82rem">
            Dual path: research boards above are built in for local hunts; GitHub users can also
            <strong>upload</strong> RSS / sitemap+JSON-LD / Getro / TalentBrew boards as JSON. Saved to
            <code>data/custom_sources.json</code> on this machine only (not committed).
            Kinds: <code>rss</code> · <code>sitemap_jsonld</code> · <code>getro</code> · <code>talentbrew</code>
            (e.g. BlackRock — use site root + location, not <code>/job/budapest/</code> which 404s).
          </p>
          <textarea id="disc-custom-json" rows="8" spellcheck="false" placeholder='{ "sources": [ { "id": "my-rss", "name": "My board", "kind": "rss", "url": "https://…/feed" } ] }' style="font-family:ui-monospace,monospace;font-size:0.78rem;width:100%"></textarea>
          <div class="row-actions" style="margin-top:0.45rem;flex-wrap:wrap;gap:0.4rem">
            <button type="button" class="btn primary" id="disc-custom-save">Save upload</button>
            <button type="button" class="btn" id="disc-custom-example">Load example JSON</button>
            <button type="button" class="btn" id="disc-custom-reload">Reload from disk</button>
            <button type="button" class="btn ghost" id="disc-custom-clear">Clear custom</button>
            <label class="btn ghost" style="cursor:pointer;margin:0">
              Import file
              <input type="file" id="disc-custom-file" accept="application/json,.json" hidden />
            </label>
          </div>
          <p class="dim" id="disc-custom-status" style="margin:0.4rem 0 0;font-size:0.8rem"></p>
        </div>
      </details>
      <div id="disc-progress-host" hidden></div>
      <p class="dim" id="disc-status" style="margin:0.65rem 0 0"></p>
    </div>
  `;

  const selectedSources = () =>
    [...host.querySelectorAll('[data-source]:checked')].map((el) => el.dataset.source);
  const progressHost = $('#disc-progress-host', host);

  $('#disc-hide', host).onclick = () => {
    host.hidden = true;
  };
  $('#disc-links', host).onclick = () => openPasteLinks();
  $('#disc-refresh', host)?.addEventListener('click', () => refreshLastHunt());

  const customStatus = $('#disc-custom-status', host);
  const customTa = $('#disc-custom-json', host);
  const setCustomStatus = (msg, ok = true) => {
    if (customStatus) {
      customStatus.textContent = msg;
      customStatus.style.color = ok ? 'var(--muted)' : 'var(--danger, #c44)';
    }
  };
  const fillCustomEditor = async () => {
    try {
      const data = await loadCustomSources();
      const pack = {
        version: 1,
        sources: (data.sources || []).map((s) => {
          const row = {
            id: s.id,
            name: s.name,
            blurb: s.blurb || '',
            kind: s.kind,
            default: !!s.default,
          };
          if (s.kind === 'getro') row.collectionId = s.collectionId;
          else if (s.url) row.url = s.url;
          if (s.kind === 'sitemap_jsonld') row.jobPathPrefix = s.jobPathPrefix || '/jobs/';
          if (s.kind === 'talentbrew') {
            if (s.location) row.location = s.location;
            if (s.locationId) row.locationId = s.locationId;
            if (s.locationDisplay) row.locationDisplay = s.locationDisplay;
            if (s.company) row.company = s.company;
          }
          return row;
        }),
      };
      if (customTa) {
        customTa.value = pack.sources.length
          ? JSON.stringify(pack, null, 2)
          : JSON.stringify(data.example || { version: 1, sources: [] }, null, 2);
      }
      setCustomStatus(
        pack.sources.length
          ? `${pack.sources.length} custom source(s) on disk`
          : 'No custom sources yet — load example or paste JSON'
      );
    } catch (e) {
      setCustomStatus(e.message || String(e), false);
    }
  };
  fillCustomEditor();

  $('#disc-custom-example', host)?.addEventListener('click', async () => {
    try {
      const data = await loadCustomSources();
      if (customTa) customTa.value = JSON.stringify(data.example || { sources: [] }, null, 2);
      setCustomStatus('Example loaded into editor — click Save upload to apply');
    } catch (e) {
      setCustomStatus(e.message || String(e), false);
    }
  });
  $('#disc-custom-reload', host)?.addEventListener('click', () => fillCustomEditor());
  $('#disc-custom-save', host)?.addEventListener('click', async () => {
    try {
      let parsed;
      try {
        parsed = JSON.parse(customTa?.value || '{}');
      } catch {
        throw new Error('Invalid JSON — fix syntax then retry');
      }
      const list = Array.isArray(parsed) ? parsed : parsed.sources;
      if (!Array.isArray(list)) throw new Error('JSON must be { "sources": [ ... ] }');
      const r = await saveCustomSources(list);
      toast(r.message || `Saved ${r.sources?.length || 0} custom source(s)`, 'ok');
      setCustomStatus(r.message || 'Saved');
      // Remount panel so checkboxes pick up new catalog
      await mountDiscoveryPanel(host);
    } catch (e) {
      toast(e.message || String(e), 'err');
      setCustomStatus(e.message || String(e), false);
    }
  });
  $('#disc-custom-clear', host)?.addEventListener('click', async () => {
    if (!confirm('Remove all uploaded custom scrape sources from this machine?')) return;
    try {
      await clearCustomSources();
      toast('Custom sources cleared', 'ok');
      await mountDiscoveryPanel(host);
    } catch (e) {
      toast(e.message || String(e), 'err');
    }
  });
  $('#disc-custom-file', host)?.addEventListener('change', async (ev) => {
    const file = ev.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (customTa) customTa.value = text;
      setCustomStatus(`Loaded ${file.name} — click Save upload to apply`);
    } catch (e) {
      setCustomStatus(e.message || String(e), false);
    }
    ev.target.value = '';
  });

  const runHunt = async (mode) => {
    if (state.busy) return;
    const selected = selectedSources();
    if (!selected.length) {
      toast('Pick at least one source (Advanced)', 'err');
      return;
    }
    if (mode === 'hunt' && !resumeBody().trim()) {
      toast('Upload a resume first', 'err');
      return;
    }
    state.busy = true;
    const huntBtn = $('#disc-hunt', host);
    const customBtn = $('#disc-run', host);
    const status = $('#disc-status', host);
    if (huntBtn) huntBtn.disabled = true;
    if (customBtn) customBtn.disabled = true;
    status.textContent = mode === 'hunt' ? 'Hunting from resume…' : 'Querying boards…';
    renderDiscoverProgress(progressHost, {
      phase: 'fetch',
      label: mode === 'hunt' ? 'Pulling boards from hunt plan…' : 'Querying selected boards…',
      sources: selected,
    });
    try {
      const limit = Number($('#disc-limit', host)?.value) || 50;
      const minScore = Number($('#disc-minscore', host)?.value) || 0;
      state.settings = await setSettings({ minJobScore: minScore });
      const extra = ($('#disc-search', host)?.value || '')
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      let r;
      /** @type {Record<string, number>} */
      let liveCounts = {};
      /** @type {Record<string, string>} */
      let liveErrors = {};
      const onProgress = (done, total, job, meta) => {
        if (meta?.phase === 'plan') {
          status.textContent = `Plan: ${(meta.plan?.queries || []).join(' · ')}`;
          renderDiscoverProgress(progressHost, {
            phase: 'plan',
            label: `Plan: ${(meta.plan?.queries || []).join(' · ')}`,
            sources: selected,
          });
          return;
        }
        if (meta?.phase === 'boards') {
          if (meta?.counts) liveCounts = meta.counts;
          if (meta?.errors) liveErrors = meta.errors;
          status.textContent = `Boards returned · scoring ${total || 0} roles…`;
          renderDiscoverProgress(progressHost, {
            phase: 'boards',
            label: `Boards returned · ${total || 0} to score`,
            sources: selected,
            counts: liveCounts,
            errors: liveErrors,
            scored: 0,
            total: total || 0,
          });
          return;
        }
        if (meta?.counts) liveCounts = meta.counts;
        if (meta?.errors) liveErrors = meta.errors;
        if (job) status.textContent = `Scoring ${done}/${total} — ${job.title || '…'} (${job.score ?? 0})`;
        renderDiscoverProgress(progressHost, {
          phase: 'score',
          label: total ? `Scoring matches ${done}/${total}` : 'Scoring…',
          sources: selected,
          counts: liveCounts,
          errors: liveErrors,
          scored: done,
          total: total || 0,
        });
      };
      if (mode === 'hunt') {
        r = await huntFromResume(state.profile, resumeBody(), state.settings.domains, {
          sources: selected,
          minScore,
          limit,
          extraQueries: extra,
          onProgress,
        });
      } else {
        const queries = extra.length ? extra : plan.queries;
        r = await discoverJobs(
          { sources: selected, queries, search: queries[0] || '', limit, minScore },
          state.profile,
          resumeBody(),
          state.settings.domains,
          (done, total, job, data) => onProgress(done, total, job, data)
        );
        r.plan = { queries, sources: selected, minScore, limit };
      }
      renderDiscoverProgress(progressHost, {
        phase: 'done',
        label: `Done — ${r.total || 0} pulled · +${r.added || 0} new`,
        sources: selected,
        counts: r.counts || {},
        errors: r.errors || {},
        scored: r.total || 0,
        total: r.total || 0,
      });

      await saveLastHunt(r.plan || { queries: r.queries, sources: selected, minScore, limit });
      await reloadAll();
      state.jobShelf = 'worth';
      state.jobPage = 0;
      const top = (r.allScored || r.jobs || []).filter((j) => (j.score || 0) >= minScore).length;
      const errKeys = Object.keys(r.errors || {});
      state.lastHuntResult = {
        total: r.total || 0,
        added: r.added || 0,
        updated: r.updated || 0,
        aboveFloor: top,
        queries: r.queries || r.plan?.queries || [],
        at: Date.now(),
      };
      toast(
        `Hunt: +${r.added} new · ${r.updated} updated · ${r.total} pulled · ${top} ≥ ${minScore}`,
        r.total ? 'ok' : 'err'
      );
      status.textContent = `Queries: ${(r.queries || []).join(' · ')} · ${Object.entries(r.counts || {})
        .map(([k, v]) => k + ':' + v)
        .join(' · ')}${errKeys.length ? ' · issues: ' + errKeys.join(', ') : ''}`;
      // Source-level progress already in counts/errors
      if (errKeys.length && !r.total) {
        status.textContent +=
          ' — Tip: run ./start.sh (not plain http.server) so /api/discover is available.';
      }
      render();
    } catch (err) {
      const msg = err.message || String(err);
      toast(msg, 'err');
      status.textContent =
        msg +
        (/fetch|network|Failed/i.test(msg)
          ? ' — Is Bootstraps server running? Use ./start.sh on port 8792.'
          : '');
      clearDiscoverProgress(progressHost);
    } finally {
      state.busy = false;
      if (huntBtn) huntBtn.disabled = false;
      if (customBtn) customBtn.disabled = false;
    }
  };

  const currentHuntConfig = () => {
    const extra = ($('#disc-search', host)?.value || '')
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const plan = buildHuntPlan(state.profile, resumeBody());
    return {
      queries: extra.length ? extra : plan.queries,
      sources: selectedSources(),
      minScore: Number($('#disc-minscore', host)?.value) || 0,
      limit: Number($('#disc-limit', host)?.value) || 50,
    };
  };

  $('#disc-save-preset', host)?.addEventListener('click', async () => {
    const name = prompt('Preset name', 'My hunt');
    if (!name) return;
    const cfg = currentHuntConfig();
    const list = upsertPreset(presetsFromSettings(state.settings), {
      name,
      ...cfg,
    });
    state.settings = await setSettings({ huntPresets: list });
    toast('Preset saved', 'ok');
    render();
  });
  $('#disc-load-preset', host)?.addEventListener('click', () => {
    const id = $('#disc-preset', host)?.value;
    const pr = presetsFromSettings(state.settings).find((x) => x.id === id);
    if (!pr) {
      toast('Pick a preset', 'err');
      return;
    }
    const inp = $('#disc-search', host);
    if (inp) inp.value = (pr.queries || []).join(', ');
    if ($('#disc-minscore', host)) $('#disc-minscore', host).value = pr.minScore ?? 35;
    if ($('#disc-limit', host)) $('#disc-limit', host).value = pr.limit ?? 50;
    host.querySelectorAll('[data-source]').forEach((el) => {
      el.checked = (pr.sources || []).includes(el.dataset.source);
    });
    const planEl = host.querySelector('.hunt-queries');
    if (planEl && pr.queries?.length) {
      planEl.innerHTML = pr.queries.map((q) => `<span class="tag hunt-q">${esc(q)}</span>`).join('');
    }
    toast(`Loaded “${pr.name}” — run Hunt or Custom`, 'ok');
  });
  $('#disc-del-preset', host)?.addEventListener('click', async () => {
    const id = $('#disc-preset', host)?.value;
    if (!id) return;
    if (!confirm('Delete this preset?')) return;
    const list = removePreset(presetsFromSettings(state.settings), id);
    state.settings = await setSettings({ huntPresets: list });
    toast('Preset deleted', 'ok');
    render();
  });

  $('#disc-hunt', host).onclick = () => runHunt('hunt');

  $('#disc-run', host).onclick = () => runHunt('custom');

  $('#disc-grok-q', host)?.addEventListener('click', async () => {
    if (!state.settings?.llmApiKey) {
      toast('Add Grok API key in Settings first', 'err');
      return;
    }
    const status = $('#disc-status', host);
    status.textContent = 'Grok is refining hunt queries…';
    try {
      const { system, user } = huntQueriesPrompt({
        profile: state.profile,
        resumeText: resumeBody(),
      });
      const { content } = await chatCompletion({
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
        model: state.settings.fastModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        purpose: 'hunt-queries',
        tier: 'fast',
      });
      const parsed = parseModelJson(content);
      const qs = (parsed.queries || []).map(String).filter(Boolean);
      if (!qs.length) throw new Error('No queries returned');
      const inp = $('#disc-search', host);
      if (inp) inp.value = qs.join(', ');
      const planEl = host.querySelector('.hunt-queries');
      if (planEl) {
        planEl.innerHTML = qs.map((q) => `<span class="tag hunt-q">${esc(q)}</span>`).join('');
      }
      status.textContent = `Grok queries: ${qs.join(' · ')} — click Hunt or Custom discover`;
      toast('Queries refined — run Hunt', 'ok');
    } catch (err) {
      status.textContent = err.message || String(err);
      toast(err.message || String(err), 'err');
    }
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
  checkDiscovery().then((r) => {
    if (!r.jobFetch) {
      status.innerHTML =
        '<span style="color:var(--warn)">Job-fetch API offline — start with <code>./start.sh</code> (not plain <code>python -m http.server</code>). Links can still import as stubs. Greenhouse/Lever/Ashby resolve best with the full server.</span>';
    } else {
      status.textContent =
        'Local fetch ready — ATS APIs (Greenhouse, Lever, Ashby) + HTML extract via Bootstraps server.';
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
      const r = await importJobLinksRobust(
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

/** Attach Escape / focus trap / backdrop click to a modal root */
function attachModal(backdrop, closeFn) {
  if (activeDialogRelease) {
    try {
      activeDialogRelease();
    } catch {
      /* */
    }
    activeDialogRelease = null;
  }
  const close = () => {
    activeDialogRelease?.();
    activeDialogRelease = null;
    closeFn();
  };
  activeDialogRelease = wireDialog(backdrop, {
    dialogSelector: '.modal',
    close,
  });
  return close;
}

function openManualJob() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-heading">
      <h2 id="m-heading">Add job manually</h2>
      <p class="muted">For We Work Remotely, company sites, referrals, etc. Or use Bulk import for many at once.</p>
      <div class="field"><label>Title</label><input id="m-title" data-autofocus /></div>
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
  const close = attachModal(backdrop, () => backdrop.remove());
  $('#m-cancel', backdrop).onclick = close;
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
    <button type="button" class="btn ${state.appView === 'pipeline' ? 'primary' : ''}" id="a-pipe">Board</button>
    <button type="button" class="btn ${state.appView === 'list' ? 'primary' : ''}" id="a-list">List</button>
    <button type="button" class="btn primary" id="a-ats">+ ATS pack</button>
    <button type="button" class="btn" id="a-new">Log manual</button>
    <button type="button" class="btn ghost" id="a-export">Export</button>
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
          : `<div class="empty"><h3>No applications yet</h3><p>Use <strong>ATS</strong> to generate a tailored pack, or log from Hunt.</p></div>`
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
  $('#a-ats')?.addEventListener('click', () => { state.view = 'ats'; render(); });
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
    return `<div class="empty"><h3>No applications yet</h3><p>Generate via <strong>ATS</strong> or log from Hunt — then drag across the board.</p></div>`;
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
        ${a.tailoredResume ? '<span class="tag master">ATS</span>' : ''}
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
          ${a.tailoredResume ? '<span class="tag master">ATS pack</span>' : ''}
          ${a.nextTouchAt ? `<span class="tag">Follow-up ${formatTouchDate(a.nextTouchAt)}</span>` : ''}
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
      <div class="field"><label>Next follow-up</label>
        <input type="date" id="ap-touch" value="${existing?.nextTouchAt ? new Date(existing.nextTouchAt).toISOString().slice(0, 10) : ''}" />
        <p class="dim" style="margin:0.25rem 0 0">
          Quick: <button type="button" class="btn ghost" data-touch-days="1" type="button">+1d</button>
          <button type="button" class="btn ghost" data-touch-days="3">+3d</button>
          <button type="button" class="btn ghost" data-touch-days="7">+7d</button>
          <button type="button" class="btn ghost" data-touch-days="0">Clear</button>
        </p>
      </div>
      <div class="field"><label>Job description (saved for learning loop)</label><textarea id="ap-jd" rows="8" placeholder="Paste the full JD here…">${esc(existing?.jobDescription || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="ap-cancel">Cancel</button>
        <button type="button" class="btn primary" id="ap-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('#ap-cancel', backdrop).onclick = close;
  backdrop.querySelectorAll('[data-touch-days]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const n = Number(btn.dataset.touchDays);
      const inp = $('#ap-touch', backdrop);
      if (!inp) return;
      if (n === 0) {
        inp.value = '';
        return;
      }
      const d = new Date(daysFromNow(n));
      inp.value = d.toISOString().slice(0, 10);
    };
  });
  $('#ap-save', backdrop).onclick = async () => {
    const payload = {
      title: $('#ap-title', backdrop).value.trim(),
      company: $('#ap-company', backdrop).value.trim(),
      url: $('#ap-url', backdrop).value.trim(),
      domain: $('#ap-domain', backdrop).value,
      status: $('#ap-status', backdrop).value,
      notes: $('#ap-notes', backdrop).value,
      jobDescription: $('#ap-jd', backdrop).value,
      nextTouchAt: (() => {
        const v = $('#ap-touch', backdrop)?.value;
        if (!v) return null;
        const d = new Date(v + 'T12:00:00');
        return Number.isNaN(d.getTime()) ? null : d.getTime();
      })(),
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
    nextTouchAt: daysFromNow(7),
  });
  await reloadAll();
  toast(job.description ? 'Logged as Applied · JD saved' : 'Logged as Applied · no JD on this listing', 'ok');
  state.view = 'applications';
  render();
}


function openJobDrawer(jobId, opts = {}) {
  if (!jobId) return;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  state.drawerJobId = jobId;
  const host = opts.host || document.getElementById('job-drawer-host') || (() => {
    const d = document.createElement('div');
    d.id = 'job-drawer-host';
    document.body.appendChild(d);
    return d;
  })();
  if (activeDialogRelease) {
    activeDialogRelease();
    activeDialogRelease = null;
  }
  const br = job.scoreBreakdown || {};
  const dbHits = dealBreakerHits(job, state.profile);
  const why = [];
  if (br.skillOverlap != null) why.push(`Skills overlap ${(br.skillOverlap * 100).toFixed(0)}%`);
  if (br.keywordOverlap != null) why.push(`Keywords ${(br.keywordOverlap * 100).toFixed(0)}%`);
  if (br.domainBoost != null) why.push(`Domain fit ${(br.domainBoost * 100).toFixed(0)}%`);
  if (br.salaryFit != null) why.push(`Salary fit ${(br.salaryFit * 100).toFixed(0)}%`);
  if (br.penalty) why.push(`Penalties −${(br.penalty * 100).toFixed(0)}%`);
  if (dbHits.length) why.push(`Deal-breakers: ${dbHits.join(', ')}`);

  host.innerHTML = `
    <div class="drawer-backdrop" id="drawer-bg">
      <aside class="job-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header class="drawer-head">
          <div>
            <h2 id="drawer-title" style="margin:0">${esc(job.title)}</h2>
            <p class="dim" style="margin:0.25rem 0 0">${esc(job.company)} · ${esc(job.source)} · score ${job.score ?? 0}</p>
          </div>
          <button type="button" class="btn ghost" id="drawer-close" data-autofocus>Close</button>
        </header>
        <div class="drawer-body">
          <div class="drawer-score-row">${scoreRingHtml(job.score || 0)}${matchChipsHtml(job)}</div>
          <p class="muted"><strong>Why this matched</strong></p>
          <ul class="why-list">${why.map((w) => `<li>${esc(w)}</li>`).join('') || '<li class="dim">No breakdown</li>'}</ul>
          ${scoreBreakdownHtml(job)}
          <p class="muted" style="margin-top:1rem"><strong>Description</strong></p>
          <pre class="jd-pre">${esc((job.description || '').slice(0, 8000))}</pre>
        </div>
        <footer class="drawer-foot row-actions">
          <button type="button" class="btn ghost" data-star-drawer="${job.id}">${job.shortlisted ? '★ Shortlisted' : '☆ Shortlist'}</button>
          <button type="button" class="btn primary" id="drawer-prep">Prepare</button>
          <button type="button" class="btn" id="drawer-apply">Log apply</button>
          ${job.url ? `<a class="btn" href="${esc(job.url)}" target="_blank" rel="noopener">Open listing</a>` : ''}
        </footer>
      </aside>
    </div>`;
  const close = () => {
    activeDialogRelease?.();
    activeDialogRelease = null;
    state.drawerJobId = null;
    host.innerHTML = '';
  };
  const bg = $('#drawer-bg', host);
  activeDialogRelease = wireDialog(bg, {
    dialogSelector: '.job-drawer',
    close,
    labelledBy: 'drawer-title',
  });
  $('#drawer-close', host).onclick = close;
  $('#drawer-prep', host).onclick = () => {
    close();
    prepareForJob(job.id);
  };
  $('#drawer-apply', host).onclick = () => {
    close();
    logApplyFromJob(job.id);
  };
  host.querySelector('[data-star-drawer]')?.addEventListener('click', async () => {
    await putJob({ ...job, shortlisted: !job.shortlisted });
    await reloadAll();
    openJobDrawer(job.id, { host });
  });
}


// ── ATS generator (master → tailored, save to pipeline) ─────

function masterResumeBody() {
  return state.master?.body || state.working?.body || '';
}

function renderAts(root, actions) {
  actions.innerHTML = `
    <button type="button" class="btn" id="ats-to-pipe">Open pipeline</button>
  `;
  const hasMaster = !!masterResumeBody().trim();
  const hasKey = !!(state.settings?.llmApiKey || '').trim();
  const prefill = state.atsDraft || { url: '', title: '', company: '', description: '', domain: '' };

  root.innerHTML = `
    <div class="ats-layout">
      <div class="card ats-form-card">
        <h3 style="margin:0 0 0.35rem;font-family:var(--serif)">ATS-ready resume</h3>
        <p class="muted" style="margin:0 0 0.85rem">
          Paste a job <strong>link</strong> and/or <strong>description</strong>. We tailor your
          <span class="tag master">Master</span> resume for ATS keyword fit, then save it to your
          <strong>Pipeline</strong> (applications list).
        </p>
        ${
          !hasMaster
            ? `<div class="banner warn"><p style="margin:0">Upload a Master resume first (Resumes tab).</p>
               <button type="button" class="btn primary" id="ats-go-resume">Upload resume</button></div>`
            : ''
        }
        <div class="field">
          <label>Job URL <span class="dim">(optional — fetch fills title/company/JD when possible)</span></label>
          <div class="row-actions" style="gap:0.4rem">
            <input id="ats-url" value="${esc(prefill.url)}" placeholder="https://boards.greenhouse.io/… or any job link" style="flex:1" />
            <button type="button" class="btn" id="ats-fetch" ${!hasMaster ? 'disabled' : ''}>Fetch</button>
          </div>
        </div>
        <div class="grid-2">
          <div class="field"><label>Title</label><input id="ats-title" value="${esc(prefill.title)}" placeholder="e.g. Data Analyst" /></div>
          <div class="field"><label>Company</label><input id="ats-company" value="${esc(prefill.company)}" placeholder="e.g. Acme" /></div>
        </div>
        <div class="field">
          <label>Domain</label>
          <select id="ats-domain">
            ${(state.settings.domains || [])
              .map((d) => `<option value="${esc(d)}" ${prefill.domain === d ? 'selected' : ''}>${esc(d)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>Job description</label>
          <textarea id="ats-jd" rows="12" placeholder="Paste the full JD here for best ATS keyword alignment…">${esc(prefill.description)}</textarea>
        </div>
        <label class="check-inline" style="margin-bottom:0.75rem">
          <input type="checkbox" id="ats-cover" checked /> Include short cover note
        </label>
        <div class="row-actions" style="flex-wrap:wrap;gap:0.5rem">
          <button type="button" class="btn" id="ats-local" ${!hasMaster ? 'disabled' : ''}>Local prep (free)</button>
          <button type="button" class="btn primary" id="ats-grok" ${!hasMaster || !hasKey ? 'disabled' : ''} title="${hasKey ? '' : 'Add API key in Settings'}">Generate with Grok</button>
        </div>
        <p class="dim" id="ats-status" style="margin:0.65rem 0 0">
          ${hasKey ? 'Grok ready.' : 'No API key — local prep still works; add key in Settings for full ATS rewrite.'}
        </p>
      </div>

      <div class="card ats-out-card">
        <h3 style="margin:0 0 0.35rem;font-family:var(--serif)">Output</h3>
        <p class="dim" id="ats-summary" style="margin:0 0 0.65rem">Generate to see tailored resume.</p>
        <div class="field"><label>ATS resume</label><textarea id="ats-resume" rows="16" placeholder="Tailored resume appears here…"></textarea></div>
        <div class="field"><label>Cover note</label><textarea id="ats-note" rows="5" placeholder="Optional cover note…"></textarea></div>
        <div class="row-actions" style="flex-wrap:wrap;gap:0.5rem">
          <button type="button" class="btn" id="ats-copy">Copy resume</button>
          <button type="button" class="btn" id="ats-export">Export MD</button>
          <button type="button" class="btn" id="ats-print" title="Printable paper preview">Application pack</button>
          <button type="button" class="btn primary" id="ats-save">Save to Pipeline</button>
        </div>
        <div class="ats-paper-preview" id="ats-paper" hidden>
          <p class="ats-paper-brand">Bootstraps · application pack</p>
          <h4 id="ats-paper-title" class="ats-paper-title">—</h4>
          <p class="dim" id="ats-paper-meta"></p>
          <div class="ats-paper-body" id="ats-paper-body"></div>
        </div>
      </div>
    </div>
  `;

  $('#ats-to-pipe').onclick = () => {
    state.view = 'applications';
    render();
  };
  $('#ats-go-resume')?.addEventListener('click', () => {
    state.view = 'resumes';
    render();
  });

  const readJob = () => ({
    title: $('#ats-title').value.trim() || 'Untitled role',
    company: $('#ats-company').value.trim() || '',
    url: $('#ats-url').value.trim() || '',
    description: $('#ats-jd').value.trim() || '',
    domain: $('#ats-domain').value,
    domains: [$('#ats-domain').value].filter(Boolean),
    remote: true,
    source: 'ats',
  });

  const persistDraft = () => {
    state.atsDraft = {
      url: $('#ats-url').value,
      title: $('#ats-title').value,
      company: $('#ats-company').value,
      description: $('#ats-jd').value,
      domain: $('#ats-domain').value,
    };
  };
  ['ats-url', 'ats-title', 'ats-company', 'ats-jd', 'ats-domain'].forEach((id) => {
    $(`#${id}`)?.addEventListener('change', persistDraft);
    $(`#${id}`)?.addEventListener('input', persistDraft);
  });

  $('#ats-fetch').onclick = async () => {
    const url = $('#ats-url').value.trim();
    if (!url) {
      toast('Paste a job URL first', 'err');
      return;
    }
    const status = $('#ats-status');
    status.textContent = 'Fetching listing…';
    try {
      const { fetchJobFromLink } = await import('./jobs/links.js');
      const stub = await fetchJobFromLink(url, {});
      if (stub.title) $('#ats-title').value = stub.title;
      if (stub.company) $('#ats-company').value = stub.company;
      if (stub.description) $('#ats-jd').value = stub.description;
      persistDraft();
      status.textContent = stub.fetchError
        ? `Fetched with gaps (${stub.fetchError}). Paste JD if thin.`
        : 'Listing loaded — review fields, then generate.';
      toast('Job fields filled', 'ok');
    } catch (err) {
      status.textContent = err.message || String(err);
      toast(err.message || String(err), 'err');
    }
  };

  const updatePaperPreview = () => {
    const job = readJob();
    const resume = $('#ats-resume')?.value || '';
    const note = $('#ats-note')?.value || '';
    const paper = $('#ats-paper');
    if (!paper) return;
    if (!resume.trim()) {
      paper.hidden = true;
      return;
    }
    paper.hidden = false;
    $('#ats-paper-title').textContent = job.title + (job.company ? ` @ ${job.company}` : '');
    $('#ats-paper-meta').textContent = job.url || 'No listing URL';
    const body = [];
    if (note.trim()) body.push('COVER NOTE\n\n' + note.trim(), '\n\n———\n\n');
    body.push(resume.trim());
    $('#ats-paper-body').textContent = body.join('');
  };

  const runLocal = () => {
    const job = readJob();
    if (!job.description && !job.url) {
      toast('Add a job description or URL', 'err');
      return;
    }
    const pack = buildLocalPrep({
      workingResume: masterResumeBody(),
      job,
      profile: state.profile,
    });
    $('#ats-resume').value = pack.tailoredResume;
    $('#ats-note').value = $('#ats-cover').checked ? pack.coverNote : '';
    $('#ats-summary').textContent = pack.changesSummary + ' · local (no API)';
    updatePaperPreview();
    bumpSessionPrepared();
    toast('Local ATS pack ready', 'ok');
  };

  const runGrok = async () => {
    const job = readJob();
    if (!job.description || job.description.length < 40) {
      toast('Paste a fuller job description for Grok ATS rewrite', 'err');
      return;
    }
    if (!state.settings?.llmApiKey) {
      toast('Add API key in Settings', 'err');
      return;
    }
    const includeCover = $('#ats-cover').checked;
    const { system, user } = prepareApplicationPrompt({
      workingResume: masterResumeBody(),
      job,
      profile: state.profile,
      includeCover,
    });
    // Bias prompt toward master + ATS in user message note
    const userAts =
      user +
      `\n\nIMPORTANT: Base resume above is the MASTER resume. Optimize for ATS parsing: clear headings, standard section names, keyword density from the JD without inventing experience.`;
    const btn = $('#ats-grok');
    const status = $('#ats-status');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    status.textContent = 'Grok is writing ATS-ready resume from Master…';
    try {
      const { content } = await chatCompletion({
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
        model: state.settings.fastModel || AI_DEFAULTS.fastModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userAts },
        ],
        purpose: 'ats_generate',
        tier: 'fast',
      });
      const parsed = parseModelJson(content);
      $('#ats-resume').value = parsed.tailoredResume || content;
      $('#ats-note').value = includeCover ? parsed.coverNote || '' : '';
      $('#ats-summary').textContent = (parsed.changesSummary || 'ATS resume ready') + ' · via Grok · Master base';
      state.usage = await getUsageSummary();
      updatePaperPreview();
      bumpSessionPrepared();
      toast('ATS resume ready', 'ok');
      status.textContent = 'Done — copy, export, print pack, or save to Pipeline.';
    } catch (err) {
      status.textContent = err.message || String(err);
      toast(err.message || String(err), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate with Grok';
    }
  };

  $('#ats-local').onclick = runLocal;
  $('#ats-grok').onclick = runGrok;
  $('#ats-resume')?.addEventListener('input', updatePaperPreview);
  $('#ats-note')?.addEventListener('input', updatePaperPreview);

  $('#ats-copy').onclick = async () => {
    const text = $('#ats-resume').value || '';
    if (!text.trim()) {
      toast('Nothing to copy yet', 'err');
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('Copied ATS resume', 'ok');
  };
  $('#ats-export').onclick = () => {
    const job = readJob();
    const resume = $('#ats-resume').value || '';
    const note = $('#ats-note').value || '';
    if (!resume.trim()) {
      toast('Generate first', 'err');
      return;
    }
    const md = applicationPackMarkdown({
      title: job.title,
      company: job.company,
      url: job.url,
      resume,
      coverNote: note,
    });
    downloadText(
      `ats-${(job.company || 'role').replace(/\s+/g, '-').slice(0, 40)}.md`,
      md,
      'text/markdown'
    );
    toast('Exported', 'ok');
  };
  $('#ats-print')?.addEventListener('click', () => {
    const job = readJob();
    const resume = $('#ats-resume').value || '';
    const note = $('#ats-note').value || '';
    if (!resume.trim()) {
      toast('Generate first', 'err');
      return;
    }
    const result = openPrintablePack({
      title: job.title,
      company: job.company,
      url: job.url,
      resume,
      coverNote: note,
    });
    toast(result.mode === 'download' ? 'Pack downloaded (popup blocked)' : 'Application pack opened', 'ok');
  });
  $('#ats-save').onclick = async () => {
    const job = readJob();
    const tailored = $('#ats-resume').value.trim();
    if (!tailored) {
      toast('Generate an ATS resume first', 'err');
      return;
    }
    if (!job.title || job.title === 'Untitled role') {
      if (!confirm('Title is empty/Untitled — save anyway?')) return;
    }
    await putApplication({
      jobId: null,
      title: job.title,
      company: job.company,
      url: job.url,
      domain: job.domain || 'Other',
      status: 'Applied',
      notes: 'ATS pack from generator',
      jobDescription: job.description || '',
      tailoredResume: tailored,
      coverNote: $('#ats-note').value || '',
      resumeBase: 'master',
      nextTouchAt: daysFromNow(7),
    });
    state.atsDraft = null;
    await reloadAll();
    toast('Saved to Pipeline', 'ok');
    state.view = 'applications';
    render();
  };
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
          <button type="button" class="btn" id="p-export-md">Export MD pack</button>
          <button type="button" class="btn" id="p-print">Application pack</button>
          <button type="button" class="btn primary" id="p-log">Save to application log</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = attachModal(backdrop, () => backdrop.remove());
  $('#p-cancel', backdrop).onclick = close;

  $('#p-resume', backdrop).value = local.tailoredResume;
  $('#p-note', backdrop).value = local.coverNote;
  bumpSessionPrepared();

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

  $('#p-print', backdrop)?.addEventListener('click', () => {
    openPrintablePack({
      title: job.title,
      company: job.company,
      url: job.url,
      resume: $('#p-resume', backdrop).value,
      coverNote: $('#p-note', backdrop).value,
      score: job.score,
    });
  });

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
    if (t?.id === 'p-export-md') {
      const resume = $('#p-resume', backdrop).value || '';
      const note = $('#p-note', backdrop).value || '';
      const md = `# ${job.title} — ${job.company}\n\nURL: ${job.url || '—'}\nScore: ${job.score ?? '—'}\n\n## Cover note\n\n${note || '_none_'}\n\n## Tailored resume\n\n${resume}\n`;
      downloadText(
        `prep-${(job.company || 'role').replace(/\s+/g, '-').slice(0, 40)}.md`,
        md,
        'text/markdown'
      );
      toast('Exported prep pack', 'ok');
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
    <button type="button" class="btn primary" id="r-upload">Upload resume (PDF)</button>
    <button type="button" class="btn" id="r-diff">Master ↔ Working diff</button>
    <button type="button" class="btn" id="r-export">Export MD</button>
    <button type="button" class="btn" id="r-clone">Working ← Master</button>
  `;
  root.innerHTML = `
    <p class="muted" style="margin-top:0">
      <span class="tag master">Master</span> stable reference ·
      <span class="tag working">Working</span> evolves from rejections & accepted suggestions
    </p>
    <div class="card resume-upload-card" id="resume-upload-card">
      <div class="resume-upload-inner">
        <div>
          <h3 style="margin:0 0 0.35rem;font-family:var(--serif)">Upload &amp; process resume</h3>
          <p class="dim" style="margin:0;max-width:36rem">
            Drop a <strong>PDF</strong> or <strong>DOCX</strong> (or <strong>.txt</strong>). Text is extracted on your machine.
            With a Grok API key in Settings, Bootstraps structures a clean Master resume, copies Working,
            and fills Profile (skills, keywords, domains) so discovery &amp; matching improve immediately.
          </p>
        </div>
        <div class="resume-upload-actions">
          <input type="file" id="resume-file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden />
          <button type="button" class="btn primary" id="resume-pick">Choose PDF / DOCX</button>
          <label class="check-inline"><input type="checkbox" id="resume-use-grok" ${
            state.settings?.llmApiKey ? 'checked' : ''
          } /> Use Grok assist</label>
        </div>
      </div>
      <p class="dim" id="resume-ingest-status" style="margin:0.75rem 0 0"></p>
      <div class="resume-drop" id="resume-drop" tabindex="0">Drop resume here</div>
    </div>
    <div id="resume-diff-host"></div>
    <div class="grid-2">
      <div class="resume-panel master">
        <header>
          <h3>Master / Default</h3>
          <button type="button" class="btn primary" id="save-master">Save master</button>
        </header>
        <div class="body">
          <textarea class="resume-editor" id="master-body" placeholder="Upload a PDF or paste your clean base resume…">${esc(state.master?.body || '')}</textarea>
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
  wireResumeUpload(root);
  $('#r-upload').onclick = () => $('#resume-file')?.click();
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

function wireResumeUpload(root) {
  const fileInput = $('#resume-file', root);
  const pick = $('#resume-pick', root);
  const drop = $('#resume-drop', root);
  const status = $('#resume-ingest-status', root);
  if (!fileInput || !pick) return;

  pick.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (f) await runResumeIngest(f, status);
    fileInput.value = '';
  };

  if (drop) {
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        stop(e);
        drop.classList.add('drag');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        stop(e);
        drop.classList.remove('drag');
      })
    );
    drop.addEventListener('drop', async (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) await runResumeIngest(f, status);
    });
    drop.addEventListener('click', () => fileInput.click());
  }
}

async function runResumeIngest(file, statusEl) {
  if (state.busy) return;
  state.busy = true;
  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };
  setStatus(`Starting ${file.name}…`);
  try {
    const useGrok = $('#resume-use-grok')?.checked !== false;
    if (useGrok && !state.settings?.llmApiKey) {
      toast('Add Grok API key in Settings for full assist — using local parse for now', 'err');
    }
    const result = await ingestResumeFile(file, state.settings, {
      useGrok,
      onProgress: (p) => setStatus(`${p.message || ''} (${p.percent ?? 0}%)`),
    });
    await reloadAll();
    const mode = result.parseMode === 'grok' ? 'Grok' : 'local';
    const skills = result.profile?.skills?.length || 0;
    toast(
      `Resume ingested (${mode}) · ${result.applied?.masterChars || 0} chars · ${skills} skills · ${result.applied?.rescored || 0} jobs rescored`,
      'ok'
    );
    if (result.grokError) {
      setStatus(`Saved with local parse. Grok error: ${result.grokError}`);
    } else {
      setStatus(
        `Done (${mode}). Profile: ${result.profile?.name || '—'} · skills ${skills}. Next: Job board → Hunt from resume.`
      );
    }
    render();
    // Offer automated hunt after successful ingest
    if (resumeBody().trim() && confirm('Resume saved. Run automated job hunt from your resume now?')) {
      state.view = 'jobs';
      render();
      requestAnimationFrame(() => $('#disc-hunt')?.click());
    }
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 'err');
    setStatus(err.message || String(err));
  } finally {
    state.busy = false;
  }
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
  actions.innerHTML = `
    <button type="button" class="btn" id="pf-from-resume">Fill from resume upload</button>
    <button type="button" class="btn primary" id="pf-save">Save profile</button>
  `;
  const p = state.profile;
  root.innerHTML = `
    <p class="muted" style="margin-top:0">Targeting signals for match scoring. Prefer <strong>Resumes → Upload PDF</strong> so Grok fills these from your CV; edit anything here afterward.</p>
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
  $('#pf-from-resume').onclick = () => {
    state.view = 'resumes';
    render();
    requestAnimationFrame(() => $('#resume-file')?.click());
  };
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
    <label class="btn" style="cursor:pointer">Import JSON<input type="file" id="s-import" accept="application/json,.json" hidden /></label>
    <button type="button" class="btn primary" id="s-save">Save settings</button>
  `;
  const s = state.settings;
  root.innerHTML = `
    <div class="card" style="max-width:40rem">
      <h3>Backup &amp; restore</h3>
      <p class="muted" style="margin-top:0">
        Export saves jobs, applications, resumes, profile, and settings (API key is redacted).
        Import restores them into this browser. Use this before clearing site data or switching devices.
      </p>
      <div class="row-actions" style="flex-wrap:wrap;gap:0.45rem">
        <button type="button" class="btn" id="s-export-2">Export all data</button>
        <label class="btn">Import backup<input type="file" id="s-import-2" accept="application/json,.json" hidden /></label>
      </div>
      <p class="dim" style="margin:0.55rem 0 0">Your Grok key stays local and is kept when import file has a redacted key.</p>
    </div>
    <div class="card" style="max-width:40rem;margin-top:1rem">
      <h3>Appearance</h3>
      <p class="muted" style="margin-top:0">Warm, soft-contrast palette tuned for long sessions (no pure black/white, reduced blue glare). Pick the mode that matches your room lighting.</p>
      <div class="field"><label>Theme</label>
        <select id="s-theme">
          <option value="dark" ${s.theme !== 'light' ? 'selected' : ''}>Dark (evening / low light)</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light (day / bright room)</option>
        </select>
      </div>
      <div class="field" style="margin-top:0.75rem">
        <label class="check-inline"><input type="checkbox" id="s-hard" ${s.hardScoreFilter ? 'checked' : ''} /> Hard score filter (min score applies to All scored too)</label>
      </div>
      <div class="field" style="margin-top:0.45rem">
        <label class="check-inline" title="Board filter: only roles that mention English / angol, or EN-written JDs on HU boards">
          <input type="checkbox" id="s-require-en" ${s.requireEnglish ? 'checked' : ''} /> English required (language filter)
        </label>
      </div>
      <div class="row-actions" style="margin-top:0.65rem">
        <button type="button" class="btn" id="s-wizard">Replay guided setup</button>
      </div>
    </div>

    <div class="card" style="max-width:40rem;margin-top:1rem">
      <h3>Hunt presets</h3>
      <p class="muted" style="margin-top:0">Save multi-query board hunts (e.g. “Data analyst remote”). Load them on the Job board. Export to share or back up.</p>
      <div id="s-presets-list" class="presets-list">
        ${(presetsFromSettings(s).length
          ? presetsFromSettings(s)
              .map(
                (pr) => `
          <div class="preset-row">
            <div>
              <strong>${esc(pr.name)}</strong>
              <div class="dim">${esc((pr.queries || []).join(' · '))}</div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn ghost" data-preset-run="${esc(pr.id)}">Run</button>
              <button type="button" class="btn ghost" data-preset-del="${esc(pr.id)}">Delete</button>
            </div>
          </div>`
              )
              .join('')
          : '<p class="dim">No presets yet — save one from Job board → Hunt presets.</p>')}
      </div>
      <div class="row-actions" style="margin-top:0.65rem;flex-wrap:wrap;gap:0.4rem">
        <button type="button" class="btn" id="s-preset-export">Export presets JSON</button>
        <label class="btn">Import JSON<input type="file" id="s-preset-import" accept="application/json,.json" hidden /></label>
      </div>
    </div>

    <div class="card settings-api-card" style="max-width:40rem;margin-top:1rem">
      <h3>Grok / xAI API setup</h3>
      <p class="muted" style="margin-top:0">Powers resume ingest, Prepare polish, and domain analysis. Your key stays in <strong>this browser’s IndexedDB only</strong> — never sent to Bootstraps (there is no Bootstraps cloud).</p>

      <div class="setup-guide-box">
        <h4 class="setup-guide-title">Quick start (≈ 2 minutes)</h4>
        <ol class="setup-steps">
          <li>
            <strong>Create an xAI account</strong> at
            <a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a>
            (sign in with the account you use for Grok / xAI).
          </li>
          <li>
            Open <strong>API Keys</strong> (or <strong>Keys</strong>) in the console and
            <strong>Create API key</strong>. Copy it once — it won’t be shown again in full.
          </li>
          <li>
            Confirm billing / credits are enabled if the console asks (API usage is separate from
            SuperGrok chat subscription).
          </li>
          <li>
            Paste below:
            <ul>
              <li><strong>Base URL</strong> — leave as <code>https://api.x.ai/v1</code></li>
              <li><strong>API key</strong> — paste the key from step 2</li>
              <li><strong>Fast model</strong> — prep &amp; resume parse (cheaper)</li>
              <li><strong>Deep model</strong> — rejection / domain analysis</li>
            </ul>
          </li>
          <li>
            Click <strong>Save settings</strong>, then <strong>Test connection</strong>.
            You should see “Connection OK” (or “endpoint reachable”).
          </li>
          <li>
            Go to <strong>Resumes → Upload PDF</strong> with “Use Grok assist” checked, or
            prepare a job with polish.
          </li>
        </ol>
        <p class="dim setup-note">
          <strong>Not the same as SuperGrok.</strong> Chat access on grok.com does not automatically
          unlock the API — you need a key from console.x.ai.
          Other OpenAI-compatible providers work too (change Base URL + model ids).
          Docs: <a href="https://docs.x.ai" target="_blank" rel="noopener">docs.x.ai</a>
        </p>
      </div>

      <div class="field"><label>Base URL</label><input id="s-url" value="${esc(s.llmBaseUrl || '')}" placeholder="https://api.x.ai/v1" autocomplete="off" /></div>
      <div class="field"><label>API key</label><input id="s-key" type="password" value="${esc(s.llmApiKey || '')}" placeholder="xai-…" autocomplete="off" /></div>
      <div class="field"><label>Fast model</label><input id="s-fast" value="${esc(s.fastModel || '')}" placeholder="${esc(AI_DEFAULTS.fastModel)}" /></div>
      <div class="field"><label>Deep model</label><input id="s-deep" value="${esc(s.deepModel || '')}" placeholder="${esc(AI_DEFAULTS.deepModel)}" /></div>
      <div class="row-actions" style="gap:0.5rem;flex-wrap:wrap">
        <button type="button" class="btn primary" id="s-test">Test connection</button>
        <button type="button" class="btn ghost" id="s-fill-defaults">Fill xAI defaults</button>
      </div>
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
      <p class="muted">Shown in-app so people who land jobs can give back. Ko-fi is the primary link; leave GitHub Sponsors blank to hide it.</p>
      <div class="field"><label>Ko-fi URL</label><input id="s-kofi" value="${esc(s.supportKofi || 'https://ko-fi.com/otterlyfrank')}" placeholder="https://ko-fi.com/otterlyfrank" /></div>
      <div class="field"><label>GitHub Sponsors URL <span class="dim">(optional — leave empty to hide)</span></label><input id="s-gh" value="${esc(supportGithubUrl() || '')}" placeholder="(not used)" /></div>
      <div class="field"><label>Message</label><textarea id="s-support-note" rows="3">${esc(s.supportNote || '')}</textarea></div>
    </div>
    ${installUiHtml('full')}
    ${supportBlock()}
  `;
  wireInstallButtons(root);
  $('#s-wizard')?.addEventListener('click', () => openOnboardingWizard());
  $('#s-preset-export')?.addEventListener('click', () => {
    downloadText(
      'bootstraps-hunt-presets.json',
      exportPresetsJson(presetsFromSettings(state.settings)),
      'application/json'
    );
    toast('Exported presets', 'ok');
  });
  $('#s-preset-import')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const incoming = importPresetsJson(text);
      let list = presetsFromSettings(state.settings);
      for (const pr of incoming) list = upsertPreset(list, pr);
      state.settings = await setSettings({ huntPresets: list });
      toast(`Imported ${incoming.length} presets`, 'ok');
      render();
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
    e.target.value = '';
  });
  root.querySelectorAll('[data-preset-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete preset?')) return;
      const list = removePreset(presetsFromSettings(state.settings), btn.dataset.presetDel);
      state.settings = await setSettings({ huntPresets: list });
      render();
    };
  });
  root.querySelectorAll('[data-preset-run]').forEach((btn) => {
    btn.onclick = async () => {
      const pr = presetsFromSettings(state.settings).find((x) => x.id === btn.dataset.presetRun);
      if (!pr) return;
      state.view = 'jobs';
      render();
      requestAnimationFrame(async () => {
        // load into panel and run custom
        const host = $('#discovery-panel');
        if (!host) return;
        const inp = $('#disc-search', host);
        if (inp) inp.value = (pr.queries || []).join(', ');
        if ($('#disc-minscore', host)) $('#disc-minscore', host).value = pr.minScore ?? 35;
        if ($('#disc-limit', host)) $('#disc-limit', host).value = pr.limit ?? 50;
        host.querySelectorAll('[data-source]').forEach((el) => {
          el.checked = !(pr.sources || []).length || pr.sources.includes(el.dataset.source);
        });
        $('#disc-run', host)?.click();
      });
    };
  });
  $('#s-save').onclick = async () => {
    const domains = $('#s-domains')
      .value.split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    state.settings = await setSettings({
      theme: $('#s-theme').value,
      hardScoreFilter: !!$('#s-hard')?.checked,
      requireEnglish: !!$('#s-require-en')?.checked,
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
  $('#s-fill-defaults')?.addEventListener('click', () => {
    $('#s-url').value = AI_DEFAULTS.baseUrl;
    if (!$('#s-fast').value.trim()) $('#s-fast').value = AI_DEFAULTS.fastModel;
    if (!$('#s-deep').value.trim()) $('#s-deep').value = AI_DEFAULTS.deepModel;
    toast('xAI defaults filled — paste your API key, Save, then Test', 'ok');
  });
  $('#s-test').onclick = async () => {
    const r = await checkLlm($('#s-url').value.trim(), $('#s-key').value.trim());
    $('#s-test-out').textContent = r.ok
      ? `✓ ${r.message}`
      : `✗ ${r.reason} — check key at console.x.ai and that Base URL is https://api.x.ai/v1`;
    toast(r.ok ? 'Connection OK' : r.reason, r.ok ? 'ok' : 'err');
  };
  const doExport = async () => {
    const data = await exportAllData();
    downloadJson('bootstraps-export.json', data);
    toast('Exported full backup', 'ok');
  };
  const doImport = async (file) => {
    if (!file) return;
    if (
      !confirm(
        'Import will replace jobs, applications, resume history, and merge settings/profile/resumes. Continue?'
      )
    ) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await importAllData(payload, { keepApiKey: true });
      await reloadAll();
      toast(
        `Imported ${result.jobs} jobs · ${result.applications} apps · ${result.history} history`,
        'ok'
      );
      render({ forceShell: true });
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  };
  $('#s-export').onclick = doExport;
  $('#s-export-2')?.addEventListener('click', doExport);
  const onImportFile = async (e) => {
    const f = e.target.files?.[0];
    await doImport(f);
    e.target.value = '';
  };
  $('#s-import')?.addEventListener('change', onImportFile);
  $('#s-import-2')?.addEventListener('change', onImportFile);
}
