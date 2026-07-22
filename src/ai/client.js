/**
 * OpenAI-compatible chat client (xAI Grok) + cost estimation.
 */

import { TOKEN_COST_USD } from '../config.js';
import { recordUsage } from '../storage/db.js';

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, messages: {role:string,content:string}[], temperature?: number, purpose?: string, tier?: string }} opts
 */
export async function chatCompletion(opts) {
  const base = (opts.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Add an API base URL in Settings (e.g. https://api.x.ai/v1)');
  if (!opts.apiKey) throw new Error('Add your API key in Settings');
  if (!opts.model) throw new Error('Select a model in Settings');

  const url = `${base}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
    }),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`API returned non-JSON (${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || res.statusText;
    throw new Error(msg || `API error ${res.status}`);
  }

  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  const estCostUsd =
    (promptTokens / 1e6) * TOKEN_COST_USD.inputPer1M +
    (completionTokens / 1e6) * TOKEN_COST_USD.outputPer1M;

  await recordUsage({
    tier: opts.tier || 'fast',
    model: opts.model,
    purpose: opts.purpose || 'chat',
    promptTokens,
    completionTokens,
    totalTokens,
    estCostUsd,
  });

  return { content, usage: { promptTokens, completionTokens, totalTokens, estCostUsd }, raw: data };
}

export async function checkLlm(baseUrl, apiKey) {
  if (!baseUrl) return { ok: false, reason: 'No base URL' };
  if (!apiKey) return { ok: false, reason: 'No API key' };
  try {
    const base = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true, message: 'Connection OK' };
    // some providers block /models — still might work for chat
    if (res.status === 404 || res.status === 405) {
      return { ok: true, message: 'Endpoint reachable (models list unavailable)' };
    }
    const t = await res.text();
    return { ok: false, reason: `${res.status}: ${t.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

export function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
