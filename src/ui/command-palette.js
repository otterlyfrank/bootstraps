/**
 * Command palette — ⌘K / Ctrl+K power navigation.
 */

import { wireDialog } from '../lib/a11y.js';
import { esc } from './dom.js';

/**
 * @typedef {{ id: string, label: string, hint?: string, group?: string, keywords?: string, run: () => void | Promise<void> }} Cmd
 */

/**
 * @param {Cmd[]} commands
 * @param {{ onClose?: () => void }} opts
 */
export function openCommandPalette(commands, opts = {}) {
  if (document.getElementById('cmd-palette-backdrop')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop cmd-palette-backdrop';
  backdrop.id = 'cmd-palette-backdrop';

  let filter = '';
  let active = 0;
  /** @type {Cmd[]} */
  let visible = commands.slice();

  const close = () => {
    release?.();
    backdrop.remove();
    opts.onClose?.();
  };

  let release = null;

  const filtered = () => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands.slice();
    return commands.filter((c) => {
      const blob = `${c.label} ${c.hint || ''} ${c.group || ''} ${c.keywords || ''}`.toLowerCase();
      return q.split(/\s+/).every((part) => blob.includes(part));
    });
  };

  const paint = () => {
    visible = filtered();
    if (active >= visible.length) active = Math.max(0, visible.length - 1);
    const groups = new Map();
    for (const c of visible) {
      const g = c.group || 'Actions';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }

    let idx = 0;
    let listHtml = '';
    for (const [group, items] of groups) {
      listHtml += `<div class="cmd-group-label">${esc(group)}</div>`;
      for (const c of items) {
        const isActive = idx === active;
        listHtml += `<button type="button" class="cmd-item ${isActive ? 'active' : ''}" data-cmd-idx="${idx}" role="option" aria-selected="${isActive}">
          <span class="cmd-item-label">${esc(c.label)}</span>
          ${c.hint ? `<span class="cmd-item-hint">${esc(c.hint)}</span>` : ''}
        </button>`;
        idx++;
      }
    }
    if (!visible.length) {
      listHtml = `<p class="dim cmd-empty">No matches</p>`;
    }

    backdrop.innerHTML = `
      <div class="modal cmd-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input type="search" id="cmd-input" class="cmd-input" placeholder="Jump to… hunt, ATS, settings, upload…" value="${esc(filter)}" autocomplete="off" data-autofocus />
        <div class="cmd-list" role="listbox" id="cmd-list">${listHtml}</div>
        <p class="cmd-foot dim">↑↓ navigate · Enter run · Esc close</p>
      </div>`;

    release?.();
    release = wireDialog(backdrop, { dialogSelector: '.cmd-palette', close });

    const input = backdrop.querySelector('#cmd-input');
    input?.addEventListener('input', (e) => {
      filter = e.target.value;
      active = 0;
      paint();
      // restore focus + caret
      const el = backdrop.querySelector('#cmd-input');
      if (el) {
        el.focus();
        el.value = filter;
        el.setSelectionRange(filter.length, filter.length);
      }
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(visible.length - 1, active + 1);
        paint();
        backdrop.querySelector('#cmd-input')?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, active - 1);
        paint();
        backdrop.querySelector('#cmd-input')?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runActive();
      }
    });

    backdrop.querySelectorAll('[data-cmd-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        active = Number(btn.dataset.cmdIdx);
        runActive();
      });
      btn.addEventListener('mouseenter', () => {
        active = Number(btn.dataset.cmdIdx);
        backdrop.querySelectorAll('.cmd-item').forEach((el, i) => {
          el.classList.toggle('active', i === active);
        });
      });
    });
  };

  const runActive = async () => {
    const cmd = visible[active];
    if (!cmd) return;
    close();
    try {
      await cmd.run();
    } catch (err) {
      console.error(cmd.id, err);
    }
  };

  document.body.appendChild(backdrop);
  paint();
}

/**
 * Build default Bootstraps command list.
 * @param {{
 *   go: (view: string) => void,
 *   hunt: () => void,
 *   upload: () => void,
 *   refreshHunt: () => void,
 *   toggleSession: () => void,
 *   exportData: () => void,
 *   sample: () => void,
 * }} actions
 */
export function buildBootstrapsCommands(actions) {
  /** @type {Cmd[]} */
  return [
    { id: 'home', label: 'Go to Home', group: 'Navigate', keywords: 'dashboard', run: () => actions.go('dashboard') },
    { id: 'hunt', label: 'Go to Hunt', group: 'Navigate', keywords: 'jobs board', run: () => actions.go('jobs') },
    { id: 'ats', label: 'Go to ATS generator', group: 'Navigate', keywords: 'resume tailor', run: () => actions.go('ats') },
    { id: 'pipe', label: 'Go to Pipeline', group: 'Navigate', keywords: 'applications', run: () => actions.go('applications') },
    { id: 'resumes', label: 'Go to Resumes', group: 'Navigate', run: () => actions.go('resumes') },
    { id: 'settings', label: 'Go to Settings', group: 'Navigate', keywords: 'api key theme', run: () => actions.go('settings') },
    { id: 'domains', label: 'Go to Domain intel', group: 'Navigate', run: () => actions.go('domains') },
    { id: 'profile', label: 'Go to Profile', group: 'Navigate', run: () => actions.go('profile') },
    { id: 'digest', label: 'Go to Recommended', group: 'Navigate', run: () => actions.go('digest') },
    { id: 'run-hunt', label: 'Run Hunt from resume', hint: 'H', group: 'Hunt', keywords: 'discover boards', run: () => actions.hunt() },
    { id: 'refresh', label: 'Refresh last hunt', hint: 'R', group: 'Hunt', run: () => actions.refreshHunt() },
    { id: 'upload', label: 'Upload resume PDF', hint: 'U', group: 'Resumes', run: () => actions.upload() },
    { id: 'session', label: 'Toggle session mode', hint: 'Focus', group: 'Focus', keywords: 'ambient deep work', run: () => actions.toggleSession() },
    { id: 'export', label: 'Export backup JSON', group: 'Data', run: () => actions.exportData() },
    { id: 'sample', label: 'Load sample data', group: 'Data', run: () => actions.sample() },
  ];
}
