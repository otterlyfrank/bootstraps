/**
 * PWA install helpers — service worker + install prompt + standalone detection.
 * Chromium fires beforeinstallprompt; Safari uses manual Share / Dock instructions.
 */

/** @type {any} */
let deferredPrompt = null;
let swRegistered = false;

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    // @ts-expect-error iOS Safari
    Boolean(navigator.standalone)
  );
}

export function canPromptInstall() {
  return Boolean(deferredPrompt);
}

export function initPwa() {
  if (location.protocol === 'file:') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('bootstraps-pwa-change'));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent('bootstraps-pwa-change'));
  });

  if ('serviceWorker' in navigator && !swRegistered) {
    swRegistered = true;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[Bootstraps] service worker registration failed', err);
    });
  }
}

/** Trigger browser install UI when available. */
export async function promptInstall() {
  if (!deferredPrompt) {
    return { ok: false, reason: 'no-prompt' };
  }
  const evt = deferredPrompt;
  deferredPrompt = null;
  evt.prompt();
  const choice = await evt.userChoice;
  window.dispatchEvent(new CustomEvent('bootstraps-pwa-change'));
  return { ok: choice.outcome === 'accepted', reason: choice.outcome };
}

const INSTALL_ICON = `<svg class="pwa-install-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L11 13.2V3h1zm-7 14h14v2H5v-2z"/></svg>`;

/**
 * Sidebar / settings markup for install state.
 * @param {'compact' | 'full'} mode
 */
export function installUiHtml(mode = 'compact') {
  if (isStandalone()) {
    if (mode === 'full') {
      return `
        <div class="card pwa-card" id="pwa-install-card">
          <div class="pwa-card-head">
            <img class="pwa-card-mark" src="./public/bootstraps-logo.jpg" alt="" width="40" height="40" />
            <div>
              <h3>Installed</h3>
              <p class="muted" style="margin:0">Bootstraps is in a standalone window. Hunt data stays in this browser profile.</p>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="pwa-install-block installed">
        <span class="pwa-install-check" aria-hidden="true">✓</span>
        <span>Installed · standalone</span>
      </div>`;
  }

  const can = canPromptInstall();
  if (mode === 'full') {
    return `
      <div class="card pwa-card" id="pwa-install-card">
        <div class="pwa-card-head">
          <img class="pwa-card-mark" src="./public/bootstraps-logo.jpg" alt="" width="44" height="44" />
          <div>
            <h3>Install Bootstraps</h3>
            <p class="muted" style="margin:0">Put the hunt cockpit on your Dock / taskbar — no native binary, data stays local.</p>
          </div>
        </div>
        <button type="button" class="btn primary pwa-install-cta" id="pwa-install-btn">
          ${INSTALL_ICON}
          <span>${can ? 'Install app now' : 'How to install'}</span>
        </button>
        <div class="pwa-howto-wrap" id="pwa-howto" ${can ? 'hidden' : ''}>
          <ul class="pwa-howto">
            <li><b>Chrome / Edge</b> — address-bar install icon, or menu → <i>Install Bootstraps…</i> / <i>Install page as app</i></li>
            <li><b>Safari (Mac)</b> — File → <i>Add to Dock…</i></li>
            <li><b>iPhone / iPad</b> — Share → <i>Add to Home Screen</i></li>
          </ul>
          <p class="dim" style="margin:0.5rem 0 0">If the one-click button is hidden, your browser hasn’t offered a prompt yet — use the steps above after a hard refresh on http://127.0.0.1.</p>
        </div>
        ${can ? `<p class="dim pwa-ready-hint">Install prompt ready — one click uses Chrome/Edge’s native installer.</p>` : ''}
      </div>`;
  }

  // compact sidebar — always a solid button (never a weak text link only)
  return `
    <button type="button" class="btn primary pwa-install-side" id="pwa-install-btn" title="${
      can ? 'Install Bootstraps as an app' : 'Install Bootstraps — opens how-to'
    }">
      ${INSTALL_ICON}
      <span>${can ? 'Install app' : 'Install as app'}</span>
    </button>
    ${can ? '' : `<p class="pwa-status dim">Pin to Dock · taskbar</p>`}
  `;
}

/**
 * Open install card (Settings) or trigger native prompt.
 */
export function openInstallHelp() {
  // Prefer navigating to settings install card if shell supports it
  const card = document.getElementById('pwa-install-card');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const howto = document.getElementById('pwa-howto');
    if (howto) howto.hidden = false;
    card.classList.add('pwa-card-flash');
    setTimeout(() => card.classList.remove('pwa-card-flash'), 1200);
    return;
  }
  // Jump to settings via hash / custom event so shell can react
  window.dispatchEvent(new CustomEvent('bootstraps-open-install'));
}

/** Wire #pwa-install-btn after each render. */
export function wireInstallButtons(root = document) {
  root.querySelectorAll('#pwa-install-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const r = await promptInstall();
      if (r.ok) {
        // toast if available
        window.dispatchEvent(
          new CustomEvent('bootstraps-toast', { detail: { msg: 'Installed — find Bootstraps in Applications / Start', kind: 'ok' } })
        );
        return;
      }
      // No native prompt: show how-to
      if (document.getElementById('pwa-install-card')) {
        const howto = document.getElementById('pwa-howto');
        if (howto) howto.hidden = false;
        document.getElementById('pwa-install-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.getElementById('pwa-install-card')?.classList.add('pwa-card-flash');
        setTimeout(
          () => document.getElementById('pwa-install-card')?.classList.remove('pwa-card-flash'),
          1200
        );
      } else {
        openInstallHelp();
        // Navigate to settings if possible
        const settingsNav = document.querySelector('[data-nav="settings"]');
        if (settingsNav) {
          settingsNav.click();
          requestAnimationFrame(() => {
            setTimeout(() => {
              const card = document.getElementById('pwa-install-card');
              const howto = document.getElementById('pwa-howto');
              if (howto) howto.hidden = false;
              card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 80);
          });
        }
      }
    };
  });
}
