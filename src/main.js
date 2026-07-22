import { openDb } from './storage/db.js';
import { mountApp } from './app.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function boot() {
  const root = document.getElementById('app');
  if (!root) return;
  if (location.protocol === 'file:') {
    root.innerHTML = `
      <div class="boot">
        <p class="boot-mark">Bootstraps</p>
        <p class="muted">Open via the local server, not as a file.</p>
        <p class="dim">Run <code>./start.sh</code> then visit http://127.0.0.1:8790</p>
      </div>`;
    return;
  }
  try {
    await openDb();
    await mountApp(root);
  } catch (err) {
    console.error(err);
    root.innerHTML = `
      <div class="boot">
        <p class="boot-mark">Bootstraps</p>
        <p class="muted">Couldn’t start</p>
        <p class="dim">${esc(err.message || String(err))}</p>
      </div>`;
  }
}

boot();
