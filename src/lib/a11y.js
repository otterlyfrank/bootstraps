/**
 * Accessibility helpers — focus trap, dialog wiring, reduced-motion.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap focus inside root. Returns a disposer.
 * @param {HTMLElement} root
 * @param {{ onEscape?: () => void, initialFocus?: HTMLElement | null }} opts
 */
export function trapFocus(root, opts = {}) {
  if (!root) return () => {};
  const previouslyFocused = document.activeElement;
  const getFocusable = () =>
    [...root.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      opts.onEscape?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = getFocusable();
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  root.addEventListener('keydown', onKey);
  const initial =
    opts.initialFocus ||
    root.querySelector('[data-autofocus]') ||
    getFocusable()[0] ||
    root;
  requestAnimationFrame(() => {
    try {
      initial.focus();
    } catch {
      /* */
    }
  });

  return () => {
    root.removeEventListener('keydown', onKey);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try {
        previouslyFocused.focus();
      } catch {
        /* */
      }
    }
  };
}

/**
 * Wire a backdrop+dialog for a11y (role, escape, focus trap, backdrop click).
 * @param {HTMLElement} backdrop
 * @param {{ dialogSelector?: string, close?: () => void, labelledBy?: string, label?: string }} opts
 */
export function wireDialog(backdrop, opts = {}) {
  const dialog =
    backdrop.querySelector(opts.dialogSelector || '[role="dialog"], .modal, .job-drawer') ||
    backdrop.firstElementChild;
  if (dialog) {
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (opts.labelledBy) dialog.setAttribute('aria-labelledby', opts.labelledBy);
    else if (opts.label) dialog.setAttribute('aria-label', opts.label);
  }

  const close = () => {
    release();
    opts.close?.();
  };

  const release = trapFocus(backdrop, { onEscape: close });

  const onBackdrop = (e) => {
    if (e.target === backdrop) close();
  };
  backdrop.addEventListener('click', onBackdrop);

  return () => {
    backdrop.removeEventListener('click', onBackdrop);
    release();
  };
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
