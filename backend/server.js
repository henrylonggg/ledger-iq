/**
 * server.js — Express API server
 *
 * Routes:
 *   POST /api/analyze   — upload files, parse, score with GPT-4o mini
 *   GET  /api/demo      — run real GPT-4o mini analysis on built-in demo files (key server-side)
 *   GET  /api/health    — health check
 *   GET  /              — serves frontend
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { parseFile, computeStats, extractWithAI } = require('./parser');
const { scoreWithClaude }         = require('./claude');
const { createCompletion, probe, sendAIError, wordCount, AIError, DEFAULT_MODEL } = require('./openai-client');
const { router: authRouter, requireAuth } = require('./auth');
const usersDb  = require('./users');

// Server-side demo API key — never sent to the client
const DEMO_API_KEY = process.env.DEMO_API_KEY || '';

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.csv', '.xlsx', '.xls', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

const ALLOWED_ORIGINS = [
  'https://ledger-iq-public.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, true); // also allow any origin for now — tighten if needed
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
// Explicitly handle OPTIONS preflight for all routes
app.options('*', cors());
app.use(express.json());

// Auth + user routes
app.use('/api/auth', authRouter);
app.use('/api/user', authRouter);

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  let xlsxOk = false;
  try { require('xlsx'); xlsxOk = true; } catch {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    deps: { xlsx: xlsxOk },
    model: 'gpt-4o-mini'
  });
});

// ─── Demo analysis endpoint ───────────────────────────────────────────────────
// Runs a real GPT-4o mini analysis on the built-in demo files.
// The API key lives only on the server — it is never sent to or from the client.
app.get('/api/demo', async (req, res) => {
  if (!DEMO_API_KEY) {
    return res.status(503).json({ error: 'Demo not configured on this server.' });
  }

  // Use SSE so the frontend gets live progress (same as /api/analyze)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function emit(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const demoDir = path.join(__dirname, 'demo-files');
    const demoFiles = fs.readdirSync(demoDir).filter(f => f.endsWith('.csv'));

    emit('progress', { step: 'parsing', pct: 5, message: 'Loading demo files…' });

    const parsedFiles = [];
    let totalTx = 0;

    for (let i = 0; i < demoFiles.length; i++) {
      const filename = demoFiles[i];
      const buffer = fs.readFileSync(path.join(demoDir, filename));
      emit('progress', { step: 'parsing', pct: 5 + (i / demoFiles.length) * 30, message: `Parsing ${filename}…` });

      const result = await parseFile(filename, buffer);
      parsedFiles.push(result);
      totalTx += result.count;

      emit('log', {
        type: result.parseError ? 'warn' : 'ok',
        message: result.parseError
          ? `${filename}: parse warning — ${result.parseError}`
          : `${filename}: extracted ${result.count} line items`
      });
    }

    emit('progress', { step: 'stats', pct: 38, message: `Computed ${totalTx} transactions — running heuristics…` });

    const allTx = parsedFiles.flatMap(f => f.transactions);
    const stats = computeStats(allTx);

    emit('log', { type: 'ok', message: `Heuristics: ${stats.redCount} red, ${stats.yellowCount} yellow, ${stats.greenCount} green` });
    emit('progress', { step: 'stats', pct: 45, message: 'Heuristic classification complete' });

    emit('progress', { step: 'claude', pct: 50, message: 'Sending to GPT-4o mini for scoring…' });
    emit('log', { type: 'info', message: `Sending ${totalTx} pre-classified items to GPT-4o mini…` });

    const { report, usage } = await scoreWithClaude(parsedFiles, DEMO_API_KEY);

    emit('log', { type: 'ok', message: `GPT-4o mini complete — ${usage.totalTokens} tokens used` });
    emit('progress', { step: 'claude', pct: 90, message: 'Scoring complete — building report…' });

    report._meta = {
      filesProcessed: parsedFiles.length,
      totalTransactions: totalTx,
      tokenUsage: usage,
      parsedAt: new Date().toISOString(),
      isDemo: true
    };

    emit('progress', { step: 'done', pct: 100, message: 'Demo report ready' });
    emit('result', { report });
    emit('done', { success: true });

  } catch (err) {
    console.error('Demo analysis error:', err);
    emit('error', { message: err.message || 'Demo analysis failed' });
  } finally {
    res.end();
  }
});

// ─── Main analysis endpoint ───────────────────────────────────────────────────
app.post('/api/analyze', upload.array('files', 50), async (req, res) => {
  // Use server-side key only — never trust the client
  const apiKey = DEMO_API_KEY;

  if (!apiKey || !apiKey.startsWith('sk-')) {
    return res.status(503).json({ error: 'API key not configured on this server. Set DEMO_API_KEY env var.' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Credit check: if user is authenticated, verify they have credits
  const authHeader = req.headers.authorization || '';
  let authedUser = null;
  if (authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'ledgeriq-dev-secret-change-me';
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
      authedUser = usersDb.findById(decoded.id);
    } catch { /* invalid token — treat as unauthenticated */ }
  }
  if (authedUser !== null && authedUser.credits < -50) {
    return res.status(402).json({
      error: 'Insufficient credits. Please add credits to your account to run analyses.',
      credits: authedUser.credits
    });
  }

  // Use streaming SSE so the frontend can show step-by-step progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function emit(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    // ── STEP 1: Parse all files (backend only, no Claude) ──────────────────
    emit('progress', { step: 'parsing', pct: 10, message: 'Parsing uploaded files…' });

    const parsedFiles = [];
    let totalTx = 0;

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      emit('progress', { step: 'parsing', pct: 10 + (i / req.files.length) * 25, message: `Parsing ${file.originalname}…` });

      let result;
      try {
        result = await parseFile(file.originalname, file.buffer);
      } catch (parseEx) {
        emit('log', { type: 'err', message: `${file.originalname}: PARSE EXCEPTION — ${parseEx.message}` });
        result = { filename: file.originalname, docType: 'Financial Document', transactions: [], count: 0, parseError: parseEx.message };
      }
      // ── AI EXTRACTION: always use GPT-4o mini to scan every file ──
      if (apiKey) {
        emit('log', { type: 'info', message: `${file.originalname}: AI scanning document…` });
        emit('progress', { step: 'parsing', pct: 10 + (i / req.files.length) * 25, message: `AI-extracting ${file.originalname}…` });

        const ext = (file.originalname.split('.').pop() || '').toLowerCase();
        const aiResult = await extractWithAI(file.originalname, file.buffer, ext, apiKey);

        if (aiResult.aiUsed && aiResult.transactions.length > 0) {
          // Merge: AI results take priority, but keep structured items AI missed
          const aiLabels = new Set(aiResult.transactions.map(t => t.label.toLowerCase()));
          const structuredOnly = result.transactions.filter(t => !aiLabels.has(t.label.toLowerCase()));
          result.transactions = [...aiResult.transactions, ...structuredOnly];
          result.count        = result.transactions.length;
          result.aiExtracted  = true;
          result.aiTokens     = aiResult.tokensUsed;
          if (!result.docType || result.docType === 'Financial Document') {
            result.docType = aiResult.docType || result.docType;
          }
          emit('log', { type: 'ok', message: `${file.originalname}: AI extracted ${aiResult.transactions.length} items + ${structuredOnly.length} structured items (${aiResult.tokensUsed} tokens)` });
        } else if (aiResult.error) {
          emit('log', { type: 'warn', message: `${file.originalname}: AI extraction error — ${aiResult.error} — using structured parse (${result.count} items)` });
        } else {
          emit('log', { type: 'info', message: `${file.originalname}: structured parse used (${result.count} items)` });
        }
      }

      parsedFiles.push(result);
      totalTx += result.count;

      // Log sheet-level breakdown for multi-sheet files
      if (result.sheetSummary && !result.aiExtracted) {
        const used   = result.sheetSummary.filter(s => !s.skipped && s.count > 0);
        const skipped = result.sheetSummary.filter(s => s.skipped);
        emit('log', { type: result.count > 0 ? 'ok' : 'warn',
          message: `${file.originalname}: extracted ${result.count} items across ${used.length} sheets` +
            (skipped.length ? ` (skipped: ${skipped.map(s=>s.name).join(', ')})` : '')
        });
      } else if (!result.aiExtracted) {
        emit('log', {
          type: result.parseError ? 'warn' : 'ok',
          message: result.parseError
            ? `${file.originalname}: parse warning — ${result.parseError}`
            : `${file.originalname}: extracted ${result.count} line items`
        });
      }
    }

    // Track total AI tokens used for extraction fallbacks
    const aiExtractionTokens = parsedFiles.reduce((s, f) => s + (f.aiTokens || 0), 0);
    if (aiExtractionTokens > 0) {
      emit('log', { type: 'info', message: `AI extraction used ${aiExtractionTokens} tokens across messy files` });
    }

    // ── STEP 2: Compute backend stats ──────────────────────────────────────
    emit('progress', { step: 'stats', pct: 38, message: `Computed ${totalTx} transactions — running heuristics…` });

    const allTx = parsedFiles.flatMap(f => f.transactions);
    const stats = computeStats(allTx);

    emit('log', { type: 'ok', message: `Heuristics: ${stats.redCount} red, ${stats.yellowCount} yellow, ${stats.greenCount} green` });
    emit('progress', { step: 'stats', pct: 45, message: 'Heuristic classification complete' });

    // ── STEP 3: Claude scores confidence + QoE (the only Claude call) ──────
    emit('progress', { step: 'claude', pct: 50, message: 'Sending structured summary to GPT-4o mini for scoring…' });
    emit('log', { type: 'info', message: `Sending ${totalTx} pre-classified items to GPT-4o mini for confidence scoring…` });

    let scoreResult;
    try {
      scoreResult = await scoreWithClaude(parsedFiles, apiKey);
    } catch (err) {
      // createCompletion already classified this (quota vs per-minute limit) with a clear message
      throw err;
    }
    const { report, usage } = scoreResult;

    emit('log', { type: 'ok', message: `GPT-4o mini scoring complete — ${usage.totalTokens} tokens used (${usage.inputTokens} in / ${usage.outputTokens} out)` });
    emit('progress', { step: 'claude', pct: 90, message: 'Scoring complete — building report…' });

    // Deduct credits for authenticated users (scoring tokens + AI extraction tokens)
    if (authedUser) {
      const totalBillableTokens = usage.totalTokens + aiExtractionTokens;
      const deductResult = usersDb.deductCredits(authedUser.id, totalBillableTokens);
      if (deductResult.ok) {
        emit('log', { type: 'info', message: `Credits used: $${deductResult.cost.toFixed(4)} (${totalBillableTokens} tokens) — balance: $${deductResult.remaining.toFixed(4)}` });
      }
    }

    // ── STEP 4: Merge backend heuristics into final report ──────────────────
    // Add backend parse metadata to the report
    report._meta = {
      filesProcessed: parsedFiles.length,
      totalTransactions: totalTx,
      tokenUsage: usage,
      parsedAt: new Date().toISOString(),
      backendStats: {
        redHeuristic:    stats.redCount,
        yellowHeuristic: stats.yellowCount,
        greenHeuristic:  stats.greenCount
      }
    };

    emit('progress', { step: 'done', pct: 100, message: 'Report ready' });
    emit('result', { report });
    emit('done', { success: true });

  } catch (err) {
    console.error('Analysis error:', err);
    emit('error', { message: err.message || 'Analysis failed' });
  } finally {
    res.end();
  }
});

// ─── Shared helper: get authed user from request ──────────────────────────────
function getAuthedUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'ledgeriq-dev-secret-change-me';
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    return usersDb.findById(decoded.id);
  } catch { return null; }
}

// ─── AI status (safe: never returns the key) ─────────────────────────────────
// GET /api/ai-status         -> { configured }           (free, instant)
// GET /api/ai-status?deep=1  -> also pings OpenAI (1 token) and reports exactly what it says
let _probeCache = { at: 0, value: null };
app.get('/api/ai-status', async (req, res) => {
  if (req.query.deep !== '1') {
    return res.json({ configured: !!DEMO_API_KEY, model: DEFAULT_MODEL });
  }
  if (Date.now() - _probeCache.at > 30000) {
    _probeCache = { at: Date.now(), value: await probe(DEMO_API_KEY) };
  }
  res.json({ ..._probeCache.value, model: DEFAULT_MODEL });
});

// ─── Build the fact sheet both generators share ──────────────────────────────
function factSheet(p) {
  const cats = (p.categories || []).map(c => `${c.name}: ${c.score}/100`).join('; ');
  const flags = (p.flags || []).slice(0, 8)
    .map(f => `- [${String(f.severity || '').toUpperCase()}] ${f.title}: ${f.detail}`).join('\n');
  const rej = (p.rejectedItems || [])
    .map(t => `- ${t.item} (${t.type}, ${t.severity}${t.amount ? ', ' + t.amount : ''}): ${t.reason || 'analyst excluded'}`).join('\n');
  const tier = p.score >= 70 ? 'LOW RISK' : p.score >= 45 ? 'MODERATE RISK' : 'HIGH RISK';
  const who = [p.companyName && `COMPANY: ${p.companyName}`, p.period && `PERIOD: ${p.period}`].filter(Boolean).join(' | ');
  return `${who ? who + '\n' : ''}ADJUSTED QoE SCORE: ${p.score}/100 (original AI score ${p.originalScore}/100) — ${tier}
DOCUMENTS: ${p.filesProcessed} | TRANSACTIONS EXTRACTED: ${p.totalTransactions}
AI CONFIDENCE: average ${p.avgConfidence ?? 'n/a'}% across transactions; ${p.lowConfidenceCount ?? 0} items below 75% confidence and queued for human review
ANALYST REVIEW: ${p.reviewedCount || 0} reviewed — ${p.approvedCount || 0} approved, ${p.rejectedCount || 0} excluded
CATEGORY SCORES: ${cats || 'n/a'}
KEY FLAGS:
${flags || 'None'}
ANALYST EXCLUSIONS:
${rej || 'None'}`;
}

/** Ask for text; if the length is way off, give the model one chance to fix it. */
async function writeToLength({ system, user, target, min, max, maxTokens, label }) {
  const r1 = await createCompletion(DEMO_API_KEY, {
    temperature: 0.6, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, { label });
  let text = (r1.choices?.[0]?.message?.content || '').trim();
  let tokens = r1.usage?.total_tokens || 0;
  const n = wordCount(text);
  if (n < min || n > max) {
    const r2 = await createCompletion(DEMO_API_KEY, {
      temperature: 0.3, max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\nDRAFT (${n} words — wrong length):\n${text}\n\nRewrite the draft to about ${target} words. Keep every fact. Output only the rewritten text.` },
      ],
    }, { label: label + '-fix' });
    const fixed = (r2.choices?.[0]?.message?.content || '').trim();
    tokens += r2.usage?.total_tokens || 0;
    if (fixed) text = fixed;
  }
  return { text, tokens, words: wordCount(text) };
}

function chargeUser(authedUser, tokens, label) {
  if (!authedUser) return null;
  const dr = usersDb.deductCredits(authedUser.id, tokens);
  console.log(`[${label}] user ${authedUser.id} used ${tokens} tokens, cost $${dr.cost?.toFixed(4)}, balance $${dr.remaining?.toFixed(4)}`);
  return { cost: dr.cost, remaining: dr.remaining };
}

// One-at-a-time queue so a burst of clicks can't trip the per-minute limit.
let _genChain = Promise.resolve();
const inQueue = fn => (_genChain = _genChain.then(fn, fn));

// ─── POST /api/generate-narrative ────────────────────────────────────────────
// ~500-word analyst narrative covering transactions, score and AI confidence.
app.post('/api/generate-narrative', async (req, res) => {
  if (!DEMO_API_KEY) return res.status(503).json({ error: 'AI is not configured on this server.', code: 'no_key', retryable: false });
  const authedUser = getAuthedUser(req);
  if (authedUser !== null && authedUser.credits < -50) {
    return res.status(402).json({ error: 'Insufficient credits', credits: authedUser.credits });
  }
  const p = req.body || {};

  try {
    const out = await inQueue(() => writeToLength({
      label: 'narrative', target: 500, min: 430, max: 590, maxTokens: 1000,
      system: 'You are a senior M&A financial analyst writing the narrative section of a Quality of Earnings (QoE) report. ' +
              'Write in a formal, precise analyst voice, in 4 to 6 paragraphs separated by a blank line, with no bullet points and no headings. ' +
              'Use only the facts provided; never invent figures.',
      user: `Write a narrative of about 500 words for the report below. Cover, in this order:
1. What the adjusted score means and how it moved from the original AI score.
2. The category results — name the strongest and weakest areas with their scores.
3. The most significant flagged transactions and what they imply for price or deal structure.
4. How reviewer decisions (exclusions/approvals) changed the picture.
5. How much to trust the AI's findings, citing the average confidence and the number of low-confidence items.
6. A closing view on what the acquirer should do next.

${factSheet(p)}`,
    }));
    res.json({
      narrative: out.text, words: out.words, tokens: out.tokens,
      creditInfo: chargeUser(authedUser, out.tokens, 'narrative'),
    });
  } catch (err) {
    sendAIError(res, err, 'generate-narrative');
  }
});

// ─── POST /api/generate-summary ──────────────────────────────────────────────
// ~150-word plain-English summary, derived from the narrative when supplied.
app.post('/api/generate-summary', async (req, res) => {
  if (!DEMO_API_KEY) return res.status(503).json({ error: 'AI is not configured on this server.', code: 'no_key', retryable: false });
  const authedUser = getAuthedUser(req);
  if (authedUser !== null && authedUser.credits < -50) {
    return res.status(402).json({ error: 'Insufficient credits', credits: authedUser.credits });
  }
  const p = req.body || {};
  const narrative = typeof p.narrative === 'string' ? p.narrative.slice(0, 6000) : '';

  try {
    const out = await inQueue(() => writeToLength({
      label: 'summary', target: 150, min: 125, max: 180, maxTokens: 400,
      system: 'You explain financial due-diligence results to a smart reader with no finance background. ' +
              'Use short sentences, everyday words, and explain any term you must use. Be honest about risk. No bullet points. Use two short paragraphs separated by a blank line.',
      user: `Write a summary of about 150 words that a non-expert can understand at a glance. State: how healthy the company's earnings look, the two or three things that matter most, and the single best next step.
${narrative ? `\nBase it on this analyst narrative (keep it consistent with it):\n"""${narrative}"""\n` : ''}
FACTS:
${factSheet(p)}`,
    }));
    res.json({
      summary: out.text, words: out.words, tokens: out.tokens,
      creditInfo: chargeUser(authedUser, out.tokens, 'generate-summary'),
    });
  } catch (err) {
    sendAIError(res, err, 'generate-summary');
  }
});

// ─── Catch-all → frontend ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Ledger IQ backend running on http://localhost:${PORT}`);
  console.log(`  POST /api/analyze  — upload & analyze files`);
  console.log(`  GET  /api/health   — health check\n`);
});
