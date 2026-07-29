/**
 * Named hunt presets — save/load/export multi-query board hunts.
 */

export function makePresetId() {
  return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * @param {object} partial
 * @returns {{ id: string, name: string, queries: string[], sources: string[], minScore: number, limit: number, createdAt: number }}
 */
export function normalizePreset(partial = {}) {
  return {
    id: partial.id || makePresetId(),
    name: String(partial.name || 'Untitled hunt').trim().slice(0, 80) || 'Untitled hunt',
    queries: (partial.queries || []).map(String).map((q) => q.trim()).filter(Boolean).slice(0, 8),
    sources: (partial.sources || []).map(String).filter(Boolean),
    minScore: Number(partial.minScore) || 0,
    limit: Math.min(100, Math.max(10, Number(partial.limit) || 50)),
    createdAt: partial.createdAt || Date.now(),
  };
}

export function presetsFromSettings(settings) {
  const list = settings?.huntPresets;
  if (!Array.isArray(list)) return [];
  return list.map(normalizePreset);
}

export function upsertPreset(list, preset) {
  const p = normalizePreset(preset);
  const next = (list || []).filter((x) => x.id !== p.id);
  next.unshift(p);
  return next.slice(0, 24);
}

export function removePreset(list, id) {
  return (list || []).filter((x) => x.id !== id);
}

export function exportPresetsJson(list) {
  return JSON.stringify(
    {
      app: 'bootstraps',
      type: 'hunt-presets',
      exportedAt: new Date().toISOString(),
      presets: (list || []).map(normalizePreset),
    },
    null,
    2
  );
}

export function importPresetsJson(text) {
  const data = JSON.parse(String(text || ''));
  const raw = Array.isArray(data) ? data : data.presets || data.items || [];
  if (!Array.isArray(raw)) throw new Error('Invalid presets file');
  return raw.map(normalizePreset);
}
