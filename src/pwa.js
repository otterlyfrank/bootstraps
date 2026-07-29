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

/**
 * Sidebar / settings markup for install state.
 * @param {'compact' | 'full'} mode
 */
export function installUiHtml(mode = 'compact') {
  if (isStandalone()) {
    if (mode === 'full') {
      return `
        <div class="card pwa-card" style="max-width:36rem;margin-top:1rem">
          <h3>Installed app</h3>
          <p class="muted">Bootstraps is running as a standalone window. Data stays in this browser profile’s IndexedDB.</p>
        </div>`;
    }
    return `<p class="pwa-status dim">Installed · standalone</p>`;
  }

  const can = canPromptInstall();
  if (mode === 'full') {
    return `
      <div class="card pwa-card" style="max-width:36rem;margin-top:1rem" id="pwa-install-card">
        <h3>Install Bootstraps</h3>
        <p class="muted">One-click install puts Bootstraps in your Applications folder / Start menu and lets you pin it to the Dock or taskbar — no native binary required.</p>
        ${
          can
            ? `<button type="button" class="btn primary" id="pwa-install-btn">Install app</button>`
            : `<p class="dim" id="pwa-install-hint">Use your browser’s install control when it appears, or:</p>
               <ul class="pwa-howto">
                 <li><b>Chrome / Edge (desktop)</b> — menu (⋮) → <i>Install Bootstraps…</i> / <i>Cast, save, and share → Install page as app</i></li>
                 <li><b>Safari (Mac)</b> — File → <i>Add to Dock…</i> (needs a recent Safari)</li>
                 <li><b>iPhone / iPad</b> — Share → <i>Add to Home Screen</i></li>
               </ul>
               <button type="button" class="btn" id="pwa-install-btn" ${can ? '' : 'hidden'}>Install app</button>`
        }
        <p class="dim" style="margin-top:0.75rem">Local data stays on this machine. After you host a public HTTPS URL, the same Install flow works for anyone who opens the site.</p>
      </div>`;
  }

  // compact sidebar
  if (can) {
    return `<button type="button" class="btn primary pwa-install-side" id="pwa-install-btn">Install app</button>`;
  }
  return `<p class="pwa-status dim"><a href="#pwa-install-card" data-nav="settings" class="donate-link">Install as app…</a></p>`;
}

/** Wire #pwa-install-btn after each render. */
export function wireInstallButtons(root = document) {
  root.querySelectorAll('#pwa-install-btn').forEach((btn) => {
    btn.onclick = async () => {
      const r = await promptInstall();
      if (r.ok) return;
      if (r.reason === 'no-prompt') {
        // Scroll to howto in settings if present
        const card = document.getElementById('pwa-install-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
  });
}
