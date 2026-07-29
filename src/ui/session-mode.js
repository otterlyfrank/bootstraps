/**
 * Ambient session mode — dim chrome, focus the hunt loop.
 */

const CLASS = 'session-mode';
const KEY = 'bootstraps-session-mode';

export function isSessionMode() {
  return document.body.classList.contains(CLASS);
}

export function setSessionMode(on, { persist = true } = {}) {
  document.body.classList.toggle(CLASS, !!on);
  if (persist) {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* */
    }
  }
  window.dispatchEvent(new CustomEvent('bootstraps-session-change', { detail: { on: !!on } }));
  return !!on;
}

export function toggleSessionMode() {
  return setSessionMode(!isSessionMode());
}

export function restoreSessionMode() {
  try {
    if (localStorage.getItem(KEY) === '1') setSessionMode(true, { persist: false });
  } catch {
    /* */
  }
}

/**
 * Floating session HUD HTML.
 * @param {{ prepareTarget?: number, preparedToday?: number, worthCount?: number }} stats
 */
export function sessionHudHtml(stats = {}) {
  const target = stats.prepareTarget ?? 5;
  const done = stats.preparedToday ?? 0;
  const worth = stats.worthCount ?? 0;
  const pct = Math.min(100, Math.round((done / Math.max(1, target)) * 100));
  return `
    <div class="session-hud" id="session-hud">
      <div class="session-hud-top">
        <strong>Session</strong>
        <button type="button" class="btn ghost" id="session-exit" title="Exit session mode">Exit</button>
      </div>
      <p class="dim" style="margin:0.2rem 0 0.45rem">Worth applying: ${worth} · prepare goal ${done}/${target}</p>
      <div class="session-ring-track" aria-hidden="true"><i style="width:${pct}%"></i></div>
      <div class="row-actions" style="margin-top:0.45rem">
        <button type="button" class="btn primary" id="session-hunt">Hunt</button>
        <button type="button" class="btn" id="session-worth">Worth shelf</button>
      </div>
    </div>`;
}
