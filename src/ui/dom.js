/**
 * Shared DOM helpers used across shell + views.
 */

import { prefersReducedMotion } from '../lib/a11y.js';

export function $(sel, r = document) {
  return r.querySelector(sel);
}

export function $$(sel, r = document) {
  return [...r.querySelectorAll(sel)];
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Accessible toast notifications.
 * @param {string} msg
 * @param {'' | 'ok' | 'err'} kind
 */
export function toast(msg, kind = '') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(host);
  }
  host.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = msg;
  host.appendChild(el);
  const fadeMs = prefersReducedMotion() ? 0 : 300;
  setTimeout(() => {
    if (fadeMs) {
      el.style.opacity = '0';
      el.style.transition = `opacity ${fadeMs}ms`;
    }
    setTimeout(() => el.remove(), fadeMs || 0);
  }, 3400);
}
