/**
 * openai-client.js — the single gateway to OpenAI.
 *
 * Every OpenAI call in the backend goes through here so that:
 *   - the API key is only ever read server-side (passed in from DEMO_API_KEY)
 *   - a 429 is classified: "out of quota" (retrying is pointless) vs.
 *     "per-minute rate limit" (retrying after a pause works)
 *   - rate-limit retries honour OpenAI's Retry-After / x-ratelimit-reset headers
 *   - errors reaching the browser are friendly and never contain key material
 */

const OpenAI = require('openai');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Optional comma-separated models to try if the primary is rate limited.
const FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_WAIT_MS   = 8000;   // longest single pause between retries
const RETRY_BUDGET  = 24000;  // total time we will spend retrying inside one request
const MAX_ATTEMPTS  = 4;

class AIError extends Error {
  constructor({ code, message, http, retryable, retryAfter, detail }) {
    super(message);
    this.name       = 'AIError';
    this.code       = code;
    this.http       = http;
    this.retryable  = !!retryable;
    this.retryAfter = retryAfter || null;   // seconds
    this.detail     = detail || null;       // safe, short technical detail
  }
}

/** Remove anything that looks like a key from text before it can leave the server. */
function scrub(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-*.]{6,}/g, 'sk-…')
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer …')
    .slice(0, 300);
}

function header(err, name) {
  const h = err?.headers;
  if (!h) return undefined;
  return typeof h.get === 'function' ? h.get(name) : h[name];
}

/** "6m0s", "1.5s", "120ms" -> ms */
function parseDuration(str) {
  if (!str) return null;
  let ms = 0, matched = false;
  for (const m of String(str).matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    matched = true;
    const n = parseFloat(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1e3 : m[2] === 'm' ? n * 6e4 : n * 36e5;
  }
  return matched ? ms : null;
}

/** How long OpenAI wants us to wait, in ms (null if it didn't say). */
function serverWaitMs(err) {
  const ra = header(err, 'retry-after-ms');
  if (ra && !isNaN(+ra)) return +ra;
  const rs = header(err, 'retry-after');
  if (rs && !isNaN(+rs)) return +rs * 1000;
  return parseDuration(header(err, 'x-ratelimit-reset-tokens'))
      ?? parseDuration(header(err, 'x-ratelimit-reset-requests'));
}

/** Turn any SDK / network failure into an AIError with an actionable message. */
function classify(err) {
  if (err instanceof AIError) return err;
  const status = err?.status;
  const code   = err?.code || err?.error?.code || err?.type || err?.error?.type || '';
  const detail = scrub(err?.error?.message || err?.message);

  if (status === 429 && /insufficient_quota|billing/i.test(code + ' ' + detail)) {
    return new AIError({
      code: 'openai_quota', http: 502, retryable: false, detail,
      message: 'OpenAI says the project that owns this API key has no usable balance. ' +
               'Credits on your account do not always apply to the project the key belongs to — ' +
               'check Billing and the project budget limit at platform.openai.com. ' +
               'New credit can take a few minutes to activate.',
    });
  }
  if (status === 429) {
    const waitMs = serverWaitMs(err);
    return new AIError({
      code: 'openai_rate_limit', http: 429, retryable: true, detail,
      retryAfter: Math.max(2, Math.ceil((waitMs || 20000) / 1000)),
      message: 'OpenAI is limiting requests per minute for this key (your credits are fine). ' +
               'The app will retry automatically.',
    });
  }
  if (status === 401) {
    return new AIError({ code: 'openai_auth', http: 502, retryable: false, detail,
      message: 'OpenAI rejected the API key configured on the server. Update DEMO_API_KEY on the backend.' });
  }
  if (status === 403 || status === 404) {
    return new AIError({ code: 'openai_model', http: 502, retryable: false, detail,
      message: 'This API key cannot use the configured model. Set OPENAI_MODEL to one the key can access.' });
  }
  if (status >= 500 || err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError') {
    return new AIError({ code: 'openai_unavailable', http: 503, retryable: true, retryAfter: 10, detail,
      message: 'OpenAI is temporarily unavailable. Please try again shortly.' });
  }
  return new AIError({ code: 'openai_error', http: 500, retryable: false, detail,
    message: detail || 'Generation failed.' });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * chat.completions.create with smart retry. Returns the raw completion
 * (same shape the SDK returns) so existing call sites barely change.
 */
async function createCompletion(apiKey, params, { label = 'openai', log = console } = {}) {
  if (!apiKey) {
    throw new AIError({ code: 'no_key', http: 503, retryable: false,
      message: 'AI is not configured on this server. Set DEMO_API_KEY in the backend environment.' });
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 70000 });
  const models = [params.model || DEFAULT_MODEL, ...FALLBACK_MODELS.filter(m => m !== (params.model || DEFAULT_MODEL))];

  const started = Date.now();
  let last;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // After the first rate limit, rotate through fallback models (separate per-model limits).
    const model = models[Math.min(attempt, models.length - 1)];
    try {
      return await client.chat.completions.create({ ...params, model });
    } catch (raw) {
      last = classify(raw);
      log.warn?.(`[${label}] attempt ${attempt + 1}/${MAX_ATTEMPTS} on ${model}: ${last.code} (${last.detail || 'no detail'})`);
      if (!last.retryable) throw last;

      const hinted = serverWaitMs(raw);
      const wait   = Math.min(MAX_WAIT_MS, hinted ?? 1500 * 2 ** attempt) + Math.random() * 400;
      const lastTry = attempt === MAX_ATTEMPTS - 1;
      if (lastTry || Date.now() - started + wait > RETRY_BUDGET) throw last;
      await sleep(wait);
    }
  }
  throw last;
}

/** One tiny completion to prove the key works. Never returns the key. */
async function probe(apiKey) {
  if (!apiKey) return { configured: false, ok: false, code: 'no_key', message: 'No API key configured on the server.' };
  try {
    const r = await createCompletion(apiKey, {
      model: DEFAULT_MODEL, max_tokens: 1, temperature: 0,
      messages: [{ role: 'user', content: 'ping' }],
    }, { label: 'probe' });
    return { configured: true, ok: true, model: r.model || DEFAULT_MODEL };
  } catch (e) {
    const ae = classify(e);
    return { configured: true, ok: false, code: ae.code, message: ae.message, retryAfter: ae.retryAfter };
  }
}

/** Express helper: send an AIError as clean JSON (+ Retry-After for 429). */
function sendAIError(res, err, label = 'openai') {
  const ae = classify(err);
  console.error(`[${label}] ${ae.code}: ${ae.detail || ae.message}`);
  if (ae.retryAfter) res.set('Retry-After', String(ae.retryAfter));
  res.status(ae.http).json({ error: ae.message, code: ae.code, retryable: ae.retryable, retryAfter: ae.retryAfter });
}

const wordCount = s => (String(s || '').trim().match(/\S+/g) || []).length;

module.exports = { createCompletion, probe, classify, sendAIError, AIError, wordCount, DEFAULT_MODEL };
