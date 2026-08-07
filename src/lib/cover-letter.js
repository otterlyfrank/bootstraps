/**
 * Cover letter assembly — simple professional template + local draft.
 * Body text (from Grok or local) is wrapped with user-tweakable greeting / sign-off.
 */

/** Default cover-letter prefs (also mirrored in DEFAULT_SETTINGS). */
export const DEFAULT_COVER_SETTINGS = {
  /** simple = Dear / body / Warm Regards / name / contact — no mailing address block */
  coverStyle: 'simple',
  /**
   * Greeting template. Tokens: {company} {title} {name}
   * Example: "Dear {company}," → "Dear Acme,"
   */
  coverGreeting: 'Dear {company},',
  coverGreetingFallback: 'Dear Hiring Manager,',
  coverSignOff: 'Warm Regards,',
  /** Empty → profile.name */
  coverSignatureName: '',
  /**
   * Contact line under signature. Empty → profile email · phone · website/portfolio.
   * Use {email} {phone} {website} {portfolio} tokens if set.
   */
  coverContact: '',
  coverPortfolio: 'https://otterly.global',
  coverIncludeDate: false,
  coverIncludeAddress: false,
  coverAddress: '',
  /** When true, PDF puts cover letter on its own page(s) before the resume */
  coverSeparatePage: true,
};

/**
 * Resolve cover settings from app settings + profile.
 * @param {object} [settings]
 * @param {object} [profile]
 */
export function resolveCoverSettings(settings = {}, profile = {}) {
  const s = { ...DEFAULT_COVER_SETTINGS, ...settings };
  const name =
    String(s.coverSignatureName || '').trim() ||
    String(profile.name || '').trim() ||
    'Applicant';
  const email = String(profile.email || '').trim();
  const phone = String(profile.phone || '').trim();
  const website = String(profile.website || s.coverPortfolio || '').trim();
  const portfolio = String(s.coverPortfolio || website || '').trim();

  let contact = String(s.coverContact || '').trim();
  if (contact) {
    contact = contact
      .replace(/\{email\}/gi, email)
      .replace(/\{phone\}/gi, phone)
      .replace(/\{website\}/gi, website)
      .replace(/\{portfolio\}/gi, portfolio);
  } else {
    contact = [email, phone, portfolio || website].filter(Boolean).join(' · ');
  }

  return {
    ...s,
    signatureName: name,
    contactLine: contact,
    email,
    phone,
    website,
    portfolio,
  };
}

/**
 * Build greeting line from template + job.
 * @param {object} cover — resolveCoverSettings result
 * @param {{ company?: string, title?: string }} job
 */
export function formatGreeting(cover, job = {}) {
  const company = String(job.company || '').trim();
  const title = String(job.title || '').trim();
  const name = cover.signatureName || '';
  let g = String(cover.coverGreeting || DEFAULT_COVER_SETTINGS.coverGreeting);
  if (!company && /\{company\}/i.test(g)) {
    g = cover.coverGreetingFallback || DEFAULT_COVER_SETTINGS.coverGreetingFallback;
  }
  g = g
    .replace(/\{company\}/gi, company || 'Hiring Manager')
    .replace(/\{title\}/gi, title || 'the role')
    .replace(/\{name\}/gi, name);
  g = g.trim();
  if (g && !/[,:]$/.test(g)) g += ',';
  return g;
}

/**
 * Strip model-added greeting/sign-off so we can re-apply user settings.
 * @param {string} text
 */
export function extractCoverBody(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  // Drop markdown
  s = s.replace(/^```[\s\S]*?```$/m, (m) => m.replace(/```\w*/g, '').trim());
  // Remove leading "Cover letter" labels
  s = s.replace(/^(cover\s*letter|cover\s*note)\s*:?\s*/i, '');
  // Drop leading greeting lines only (short salutation, not body that starts with Hello)
  s = s.replace(/^(dear\s+[^\n,]{1,60},)\s*\n+/i, '');
  s = s.replace(/^(hi\s+[^\n,]{0,40},)\s*\n+/i, '');
  s = s.replace(/^(hello\s+[^\n,]{0,40},)\s*\n+/i, '');
  // Drop trailing sign-offs + signature blocks (from sign-off to end)
  s = s.replace(
    /\n+(warm\s+regards|best\s+regards|kind\s+regards|sincerely|yours\s+truly)[,.]?\s*(\n[\s\S]*)?$/i,
    ''
  );
  return s.trim();
}

/**
 * Assemble full simple cover letter text.
 * @param {{ body: string, job?: object, profile?: object, settings?: object }} opts
 */
export function formatCoverLetter({ body, job = {}, profile = {}, settings = {} }) {
  const cover = resolveCoverSettings(settings, profile);
  const paragraphs = extractCoverBody(body);
  if (!paragraphs && cover.coverStyle === 'simple') {
    return '';
  }

  const lines = [];
  if (cover.coverIncludeDate) {
    lines.push(
      new Date().toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      ''
    );
  }
  if (cover.coverIncludeAddress && String(cover.coverAddress || '').trim()) {
    lines.push(...String(cover.coverAddress).trim().split(/\n+/), '');
  }

  lines.push(formatGreeting(cover, job), '');

  // Normalize body into paragraphs (blank-line separated)
  const paras = paragraphs
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  for (const p of paras) {
    lines.push(p, '');
  }

  const signOff = String(cover.coverSignOff || 'Warm Regards,').trim();
  lines.push(signOff.endsWith(',') ? signOff : `${signOff},`);
  lines.push('');
  lines.push(cover.signatureName);
  if (cover.contactLine) lines.push(cover.contactLine);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Local (no API) cover letter body — draws on resume skills + portfolio.
 * @param {{ job: object, profile?: object, workingResume?: string, settings?: object }} opts
 */
export function buildLocalCoverBody({ job, profile = {}, workingResume = '', settings = {} }) {
  const cover = resolveCoverSettings(settings, profile);
  const title = job.title || 'this role';
  const company = job.company || 'your team';
  const skills = (profile.skills || []).filter(Boolean);
  const fromResume = extractSkillsHint(workingResume);
  const skillList = [...new Set([...skills, ...fromResume])].slice(0, 12);
  const skillPhrase =
    skillList.length >= 3
      ? skillList.slice(0, 8).join(', ')
      : skillList.join(', ') || 'analysis, research, and clear written communication';
  const portfolio = cover.portfolio || cover.website || 'https://otterly.global';

  const p1 = `I am writing to apply for the ${title} position at ${company}. My background spans the skills this role calls for — including ${skillPhrase} — and I am motivated to bring that mix to a team that values practical, remote-ready work.`;

  const p2 = `Across recent projects I have turned messy inputs into decisions stakeholders can use: structuring problems, choosing the right tools, and communicating results without jargon. I am comfortable owning end-to-end analysis, research, and written briefs under async collaboration.`;

  const p3 = `You can see more of my work and ventures at ${portfolio.replace(/^https?:\/\//i, '')}. I would welcome the chance to discuss how my experience maps to ${company}'s needs and to share concrete examples from my resume.`;

  return [p1, p2, p3].join('\n\n');
}

/**
 * @param {string} resume
 * @returns {string[]}
 */
function extractSkillsHint(resume) {
  const text = String(resume || '');
  const m = text.match(/(?:^|\n)\s*SKILLS?\s*\n([\s\S]{0,400}?)(?:\n\s*\n|\n\s*[A-Z]{3,})/i);
  if (!m) return [];
  return m[1]
    .split(/[,·|•\n]/)
    .map((s) => s.replace(/^[-*]\s*/, '').trim())
    .filter((s) => s.length > 1 && s.length < 40)
    .slice(0, 16);
}

/**
 * True if string looks like a full letter (has Dear + sign-off).
 * @param {string} text
 */
export function looksLikeFullCoverLetter(text) {
  const s = String(text || '');
  return /\bdear\b/i.test(s) && /(warm\s+regards|best\s+regards|sincerely|kind\s+regards)/i.test(s);
}
