/**
 * Resume ingest — extract file text → Grok structure → populate Master/Working/Profile.
 */

import { chatCompletion } from '../ai/client.js';
import { parseResumePrompt, parseModelJson } from '../ai/prompts.js';
import { extractResumeFile } from '../lib/extract-document.js';
import {
  saveResume,
  setProfile,
  getProfile,
  addResumeHistory,
  getBothResumes,
  listJobs,
} from '../storage/db.js';
import { rescoreAllJobs } from '../jobs/sources.js';
import { formatAtsPlainText, normalizeExtractedResume } from '../lib/resume-format.js';

/**
 * Lightweight offline heuristic if no API key.
 */
export function heuristicParseResume(text) {
  const cleaned = normalizeExtractedResume(text);
  const lines = String(cleaned || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] || '';
  const email =
    (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
  const phone =
    (text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/) ||
      [])[0] || '';

  // Skills: line after "Skills" heading
  let skills = [];
  const skillIdx = lines.findIndex((l) => /^(skills|technical skills|core competencies)\b/i.test(l));
  if (skillIdx >= 0) {
    const chunk = lines.slice(skillIdx + 1, skillIdx + 6).join(' ');
    skills = chunk
      .split(/[,|•·;/]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 40)
      .slice(0, 24);
  }

  const keywords = [];
  const kwHints = [
    'python',
    'sql',
    'analysis',
    'strategy',
    'research',
    'excel',
    'tableau',
    'javascript',
    'marketing',
    'operations',
    'product',
    'writing',
  ];
  const lower = text.toLowerCase();
  for (const k of kwHints) {
    if (lower.includes(k)) keywords.push(k);
  }

  const nameGuess = /^[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,3}$/.test(first) ? first : '';

  return {
    plainResume: formatAtsPlainText(cleaned || text),
    profile: {
      name: nameGuess,
      skills,
      experienceKeywords: keywords.slice(0, 12),
      preferredDomains: [],
      salaryFloorUsd: null,
      salaryCeilingUsd: null,
      dealBreakers: [],
      remoteOnly: true,
      notes: [email && `Email: ${email}`, phone && `Phone: ${phone}`].filter(Boolean).join(' · '),
      summary: '',
    },
    headline: '',
    yearsExperience: null,
    parseMode: 'heuristic',
  };
}

/**
 * Call Grok to structure resume text.
 */
export async function grokParseResume(text, settings) {
  const { system, user } = parseResumePrompt({ resumeText: text });
  const { content } = await chatCompletion({
    baseUrl: settings.llmBaseUrl,
    apiKey: settings.llmApiKey,
    model: settings.fastModel || settings.deepModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    purpose: 'resume-ingest',
    tier: 'fast',
  });
  const parsed = parseModelJson(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Grok returned unparseable JSON — try again or paste text manually');
  }
  const plain = formatAtsPlainText(String(parsed.plainResume || parsed.resumeText || text));
  const profile = parsed.profile || {};
  return {
    plainResume: plain || formatAtsPlainText(text),
    profile: {
      name: profile.name || '',
      skills: Array.isArray(profile.skills) ? profile.skills.map(String).filter(Boolean) : [],
      experienceKeywords: Array.isArray(profile.experienceKeywords)
        ? profile.experienceKeywords.map(String).filter(Boolean)
        : [],
      preferredDomains: Array.isArray(profile.preferredDomains)
        ? profile.preferredDomains.map(String).filter(Boolean)
        : [],
      salaryFloorUsd:
        profile.salaryFloorUsd != null && profile.salaryFloorUsd !== ''
          ? Number(profile.salaryFloorUsd)
          : null,
      salaryCeilingUsd:
        profile.salaryCeilingUsd != null && profile.salaryCeilingUsd !== ''
          ? Number(profile.salaryCeilingUsd)
          : null,
      dealBreakers: Array.isArray(profile.dealBreakers)
        ? profile.dealBreakers.map(String).filter(Boolean)
        : [],
      remoteOnly: profile.remoteOnly !== false,
      notes: String(profile.notes || ''),
      summary: String(profile.summary || parsed.summary || ''),
    },
    headline: String(parsed.headline || ''),
    yearsExperience: parsed.yearsExperience ?? null,
    parseMode: 'grok',
    raw: parsed,
  };
}

/**
 * Apply parsed package to Master, Working, Profile; rescore jobs.
 * @param {{ plainResume: string, profile: object, parseMode?: string, fileName?: string }} pack
 * @param {{ copyToWorking?: boolean, mergeProfile?: boolean }} opts
 */
export async function applyResumeIngest(pack, opts = {}) {
  const copyToWorking = opts.copyToWorking !== false;
  const mergeProfile = opts.mergeProfile !== false;
  const body = formatAtsPlainText(pack.plainResume || '');
  if (!body) throw new Error('No resume text to save');

  await saveResume('master', body, pack.fileName ? `Master (${pack.fileName})` : 'Master Resume');

  if (copyToWorking) {
    const { working: existingWorking } = await getBothResumes();
    const prev = existingWorking?.body || '';
    await saveResume('working', body, 'Working Resume');
    await addResumeHistory({
      reason: `Resume ingest (${pack.parseMode || 'upload'})${pack.fileName ? `: ${pack.fileName}` : ''}`,
      before: prev,
      after: body,
      source: 'resume-ingest',
    });
  }

  const current = await getProfile();
  const p = pack.profile || {};
  const next = {
    ...current,
    name: p.name || current.name || '',
    skills: p.skills?.length ? p.skills : current.skills || [],
    experienceKeywords: p.experienceKeywords?.length
      ? p.experienceKeywords
      : current.experienceKeywords || [],
    preferredDomains: p.preferredDomains?.length
      ? p.preferredDomains
      : current.preferredDomains || [],
    remoteOnly: p.remoteOnly !== undefined ? !!p.remoteOnly : current.remoteOnly !== false,
    dealBreakers: p.dealBreakers?.length ? p.dealBreakers : current.dealBreakers || [],
    notes: mergeProfile
      ? [current.notes, p.notes, p.summary && `Summary: ${p.summary}`].filter(Boolean).join('\n')
      : p.notes || p.summary || current.notes || '',
  };
  if (p.salaryFloorUsd != null && !Number.isNaN(Number(p.salaryFloorUsd))) {
    next.salaryFloorUsd = Number(p.salaryFloorUsd);
  }
  if (p.salaryCeilingUsd != null && !Number.isNaN(Number(p.salaryCeilingUsd))) {
    next.salaryCeilingUsd = Number(p.salaryCeilingUsd);
  }
  // Prefer clean notes from Grok when merge would double-dump
  if (pack.parseMode === 'grok' && (p.notes || p.summary)) {
    next.notes = [p.summary && `Summary: ${p.summary}`, p.notes].filter(Boolean).join('\n');
  }

  await setProfile(next);

  let rescored = 0;
  try {
    const jobs = await listJobs({ dismissed: false });
    if (jobs.length) {
      await rescoreAllJobs(jobs, next, body);
      rescored = jobs.length;
    }
  } catch {
    /* non-fatal */
  }

  return { profile: next, masterChars: body.length, rescored };
}

/**
 * Full pipeline from File.
 */
export async function ingestResumeFile(file, settings, { onProgress, useGrok = true } = {}) {
  onProgress?.({ stage: 'extract', message: 'Extracting text…', percent: 5 });
  const extracted = await extractResumeFile(file, {
    onProgress: (p) =>
      onProgress?.({
        stage: p.stage,
        message: p.message,
        percent: Math.min(45, Math.round((p.percent || 0) * 0.45)),
      }),
  });

  onProgress?.({
    stage: 'extract',
    message: `Extracted ${extracted.chars} characters from ${extracted.fileName}`,
    percent: 50,
  });

  let pack;
  const canGrok = useGrok && settings?.llmApiKey && settings?.llmBaseUrl;
  if (canGrok) {
    onProgress?.({ stage: 'grok', message: 'Grok is structuring your resume & profile…', percent: 60 });
    try {
      pack = await grokParseResume(extracted.text, settings);
      pack.fileName = extracted.fileName;
    } catch (err) {
      onProgress?.({
        stage: 'grok',
        message: `Grok failed (${err.message}) — using local parse…`,
        percent: 70,
      });
      pack = heuristicParseResume(extracted.text);
      pack.fileName = extracted.fileName;
      pack.grokError = err.message;
    }
  } else {
    onProgress?.({
      stage: 'local',
      message: canGrok ? 'Parsing…' : 'No API key — local parse only (add Grok in Settings for full assist)',
      percent: 65,
    });
    pack = heuristicParseResume(extracted.text);
    pack.fileName = extracted.fileName;
  }

  onProgress?.({ stage: 'save', message: 'Saving Master, Working & Profile…', percent: 85 });
  const applied = await applyResumeIngest(pack, { copyToWorking: true, mergeProfile: false });
  onProgress?.({ stage: 'done', message: 'Resume ingested', percent: 100 });

  return {
    ...pack,
    extracted,
    applied,
  };
}
