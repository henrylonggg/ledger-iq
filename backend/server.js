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
const { parseSpreadsheet, refineTypes } = require('./layout-map');
const { createCompletion, probe, sendAIError, wordCount, AIError, DEFAULT_MODEL } = require('./openai-client');
const { router: authRouter, requireAuth } = require('./auth');
const usersDb  = require('./users');

// Server-side demo API key — never sent to the client
const DEMO_API_KEY = process.env.DEMO_API_KEY || '';
// auto = ask the AI only when the built-in parser is not confident | always | never
const LAYOUT_AI = ['auto', 'always', 'never'].includes(process.env.LAYOUT_AI) ? process.env.LAYOUT_AI : 'auto';

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.csv', '.xlsx', '.xls', '.txt', '.qbo', '.iif', '.ofx'];
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
app.get('/api/health', async (req, res) => {
  let xlsxOk = false;
  try { require('xlsx'); xlsxOk = true; } catch {}
  let dbOk = false, dbError = null, userCount = 0;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const r = await pool.query('SELECT COUNT(*) FROM users');
    userCount = parseInt(r.rows[0].count);
    dbOk = true;
    await pool.end();
  } catch (err) { dbError = err.message; }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    deps: { xlsx: xlsxOk },
    model: 'gpt-4o-mini',
    db: { ok: dbOk, userCount, error: dbError },
    env: { hasDatabaseUrl: !!process.env.DATABASE_URL }
  });
});

// ─── Demo analysis endpoint ───────────────────────────────────────────────────
// Runs a real GPT-4o mini analysis on the built-in demo files.
// Result is cached in memory so subsequent requests are instant.
let _demoCache = null;
let _demoCacheRunning = false;
let _demoCacheWaiters = [];

app.get('/api/demo', async (req, res) => {
  if (!DEMO_API_KEY) {
    return res.status(503).json({ error: 'Demo not configured on this server.' });
  }

  // If we have a cached result, stream it immediately
  if (_demoCache) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'done', pct: 95, message: 'Loading cached demo…' })}\n\n`);
    res.write(`event: result\ndata: ${JSON.stringify({ report: _demoCache })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ success: true })}\n\n`);
    res.end();
    return;
  }

  // If already running, wait for it then serve cache
  if (_demoCacheRunning) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'claude', pct: 50, message: 'Demo analysis in progress, please wait…' })}\n\n`);
    await new Promise(resolve => _demoCacheWaiters.push(resolve));
    res.write(`event: progress\ndata: ${JSON.stringify({ step: 'done', pct: 95, message: 'Demo ready!' })}\n\n`);
    res.write(`event: result\ndata: ${JSON.stringify({ report: _demoCache })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ success: true })}\n\n`);
    res.end();
    return;
  }

  _demoCacheRunning = true;

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
      scoredTransactions: (report.transactions || []).length,
      tokenUsage: usage,
      parsedAt: new Date().toISOString(),
      isDemo: true
    };

    // Cache the result so future requests are instant
    _demoCache = report;
    _demoCacheRunning = false;
    _demoCacheWaiters.forEach(r => r());
    _demoCacheWaiters = [];

    emit('progress', { step: 'done', pct: 100, message: 'Demo report ready' });
    emit('result', { report });
    emit('done', { success: true });

  } catch (err) {
    console.error('Demo analysis error:', err);
    _demoCacheRunning = false;
    _demoCacheWaiters.forEach(r => r());
    _demoCacheWaiters = [];
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
      authedUser = await usersDb.findById(decoded.id);
    } catch { /* invalid token — treat as unauthenticated */ }
  }
  if (authedUser !== null && authedUser?.credits < -50) {
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

      const ext = (file.originalname.split('.').pop() || '').toLowerCase();
      const log = (type, message) => emit('log', { type, message });
      let result;

      if (['xlsx', 'xls', 'csv'].includes(ext)) {
        // Spreadsheets: the AI only learns the LAYOUT from a small sample (or the cache);
        // plain code then reads every row. Files we already read confidently cost nothing.
        try {
          const sp = await parseSpreadsheet(file.originalname, file.buffer, ext, apiKey, { mode: LAYOUT_AI, log });
          result = {
            filename: file.originalname, docType: sp.docType, transactions: sp.transactions,
            count: sp.transactions.length, sheetSummary: sp.sheetSummary, parseError: null,
            aiTokens: sp.tokens, aiExtracted: sp.aiCalls > 0,
          };
          const used = sp.sheetSummary.filter(x => !x.skipped);
          const how = [
            sp.localSheets ? `${sp.localSheets} read locally (no AI)` : '',
            sp.cacheHits   ? `${sp.cacheHits} from saved layouts` : '',
            sp.aiCalls     ? `layout learned by AI (${sp.tokens} tokens)` : '',
          ].filter(Boolean).join(', ');
          log(result.count > 0 ? 'ok' : 'warn',
            `${file.originalname}: ${result.count} line items from ${used.length} sheet${used.length === 1 ? '' : 's'}${how ? ' — ' + how : ''}`);
        } catch (ex) {
          log('err', `${file.originalname}: could not read — ${ex.message}`);
          result = { filename: file.originalname, docType: 'Financial Document', transactions: [], count: 0, parseError: ex.message };
        }
      } else {
        // PDFs / text: no grid to map, so the built-in parser goes first and the AI only steps in
        // when it finds almost nothing.
        try {
          result = await parseFile(file.originalname, file.buffer);
        } catch (parseEx) {
          log('err', `${file.originalname}: PARSE EXCEPTION — ${parseEx.message}`);
          result = { filename: file.originalname, docType: 'Financial Document', transactions: [], count: 0, parseError: parseEx.message };
        }
        if (result.count < 3 && LAYOUT_AI !== 'never') {
          log('info', `${file.originalname}: little structure found — asking AI to read it`);
          const aiResult = await extractWithAI(file.originalname, file.buffer, ext, apiKey);
          if (aiResult.aiUsed && aiResult.transactions.length > 0) {
            result.transactions = [...aiResult.transactions, ...result.transactions];
            result.count = result.transactions.length;
            result.aiExtracted = true;
            result.aiTokens = aiResult.tokensUsed;
            if (!result.docType || result.docType === 'Financial Document') result.docType = aiResult.docType || result.docType;
            log('ok', `${file.originalname}: AI read ${aiResult.transactions.length} line items (${aiResult.tokensUsed} tokens)`);
          } else if (aiResult.error) {
            log('warn', `${file.originalname}: AI reading unavailable — ${aiResult.error}`);
          }
        } else {
          log(result.parseError ? 'warn' : 'ok', result.parseError
            ? `${file.originalname}: parse warning — ${result.parseError}`
            : `${file.originalname}: ${result.count} line items read locally (no AI)`);
        }
      }

      parsedFiles.push(result);
      totalTx += result.count;
    }

    // Line items the keyword rules could not place: one small batched AI call (cached per label)
    let typeTokens = 0;
    if (LAYOUT_AI !== 'never') {
      emit('progress', { step: 'parsing', pct: 36, message: 'Organizing line items…' });
      const rt = await refineTypes(parsedFiles.flatMap(f => f.transactions), apiKey, { log: (t, m) => emit('log', { type: t, message: m }) });
      typeTokens = rt.tokens;
      if (rt.unknown) emit('log', { type: 'info', message: rt.calls ? `AI classified ${rt.changed} unlabelled line items (${rt.tokens} tokens)` : `${rt.unknown} unlabelled items kept as "Other" (below the AI threshold)` });
    }

    // Track total AI tokens used while reading the files
    const aiExtractionTokens = typeTokens + parsedFiles.reduce((s, f) => s + (f.aiTokens || 0), 0);
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
      const deductResult = await usersDb.deductCredits(authedUser.id, totalBillableTokens);
      if (deductResult.ok) {
        emit('log', { type: 'info', message: `Credits used: $${deductResult.cost.toFixed(4)} (${totalBillableTokens} tokens) — balance: $${deductResult.remaining.toFixed(4)}` });
      }
    }

    // ── STEP 4: Merge backend heuristics into final report ──────────────────
    // Add backend parse metadata to the report
    report._meta = {
      filesProcessed: parsedFiles.length,
      totalTransactions: totalTx,
      scoredTransactions: (report.transactions || []).length,
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
async function getAuthedUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'ledgeriq-dev-secret-change-me';
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    return await usersDb.findById(decoded.id);
  } catch { return null; }
}

// ─── AI status (safe: never returns the key) ─────────────────────────────────
// GET /api/ai-status         -> { configured }           (free, instant)
// GET /api/ai-status?deep=1  -> also pings OpenAI (1 token) and reports exactly what it says
let _probeCache = { at: 0, value: null };
/* ── Admin: delete user by email (secret in query param for browser use) ── */
app.get('/api/admin/user/delete', async (req, res) => {
  const { email, secret } = req.query;
  const adminSecret = process.env.ADMIN_SECRET || 'ledgeriq-admin-2024';
  if (secret !== adminSecret) return res.status(403).send('Forbidden');
  if (!email) return res.status(400).send('email param required');
  try {
    const deleted = await usersDb.deleteUserByEmail(email);
    if (deleted) {
      console.log(`[admin] deleted user: ${email}`);
      res.send(`<h2>✓ Deleted user: ${email}</h2><p>You can now sign up again.</p>`);
    } else {
      res.send(`<h2>User not found: ${email}</h2>`);
    }
  } catch (err) {
    console.error('[admin] delete user error:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.delete('/api/admin/user', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== (process.env.ADMIN_SECRET || 'ledgeriq-admin-2024')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    const deleted = await usersDb.deleteUserByEmail(email);
    if (deleted) {
      console.log(`[admin] deleted user: ${email}`);
      res.json({ ok: true, message: `User ${email} deleted` });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    console.error('[admin] delete user error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

async function chargeUser(authedUser, tokens, label) {
  if (!authedUser) return null;
  const dr = await usersDb.deductCredits(authedUser.id, tokens);
  console.log(`[${label}] user ${authedUser.id} used ${tokens} tokens, cost $${dr.cost?.toFixed(4)}, balance $${dr.remaining?.toFixed(4)}`);
  return { cost: dr.cost, remaining: dr.remaining };
}

// One-at-a-time queue so a burst of clicks can't trip the per-minute limit.
let _genChain = Promise.resolve();
const inQueue = fn => (_genChain = _genChain.then(fn, fn));

// ─── POST /api/generate-summary ──────────────────────────────────────────────
// The one AI-written report: a 350–500 word plain-English quality-of-earnings breakdown.
// (There is no separate narrative any more, and nothing here can be exported.)
app.post('/api/generate-summary', async (req, res) => {
  if (!DEMO_API_KEY) return res.status(503).json({ error: 'AI is not configured on this server.', code: 'no_key', retryable: false });
  const authedUser = await getAuthedUser(req);
  if (authedUser !== null && authedUser?.credits < -50) {
    return res.status(402).json({ error: 'Insufficient credits', credits: authedUser.credits });
  }
  const p = req.body || {};

  try {
    const out = await inQueue(() => writeToLength({
      label: 'summary', target: 425, min: 350, max: 500, maxTokens: 900,
      system: 'You explain a company\'s quality of earnings to a smart reader with no finance background, such as a first-time buyer or a board member. ' +
              'Use everyday words and short sentences; if you must use a finance term, explain it in the same sentence. ' +
              'Be honest about risk and never soften a weak result. Use only the facts provided and never invent numbers. ' +
              'Write plain paragraphs separated by a blank line. No headings, no bullet points, no bold.',
      user: `Write a clear breakdown of this company's quality of earnings in 350 to 500 words (aim for about 425). "Quality of earnings" means how much of the reported profit is real, repeatable and backed by cash.

Cover these in order, one short paragraph each:
1. The bottom line: what the score says about how trustworthy the profits are.
2. Revenue: how solid and repeatable it looks, using the revenue-related scores and flags.
3. Profit and adjustments: which add-backs or one-off items matter, and which the reviewer excluded and why.
4. Cash and working capital: whether profit turns into cash, using the related scores and flags.
5. The biggest red flags in plain terms, and what each could cost the buyer.
6. How much to trust this analysis: the AI's average confidence and how many items still need a human look.
7. What the buyer should do next.

FACTS:
${factSheet(p)}`,
    }));
    res.json({
      summary: out.text, words: out.words, tokens: out.tokens,
      creditInfo: await chargeUser(authedUser, out.tokens, 'generate-summary'),
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
