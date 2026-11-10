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
      // Surface rate limit errors with a clear, actionable message
      if (err?.status === 429 || err?.message?.includes('429') || err?.message?.toLowerCase().includes('rate limit') || err?.message?.toLowerCase().includes('quota')) {
        throw new Error('OpenAI rate limit reached (429). Your API key has hit its usage quota or per-minute limit. Please wait 60 seconds and try again, or check your OpenAI billing at platform.openai.com/account/billing.');
      }
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

// ─── POST /api/generate-narrative ────────────────────────────────────────────
app.post('/api/generate-narrative', async (req, res) => {
  if (!DEMO_API_KEY) return res.status(503).json({ error: 'API not configured' });

  const authedUser = getAuthedUser(req);
  if (authedUser !== null && authedUser.credits < -50) {
    return res.status(402).json({ error: 'Insufficient credits', credits: authedUser.credits });
  }

  const payload = req.body || {};
  const {
    score, originalScore, companyName, period, filesProcessed,
    categories = [], flags = [], rejectedItems = [], approvedItems = [],
    reviewedCount, rejectedCount, approvedCount
  } = payload;

  const catSummary = categories.map(c =>
    `${c.name}: ${c.score}/100 (${c.color})`
  ).join('\n');

  const flagSummary = flags.slice(0, 8).map(f =>
    `- [${f.severity?.toUpperCase()}] ${f.title}: ${f.detail}`
  ).join('\n');

  const rejSummary = rejectedItems.map(t =>
    `- ${t.item} (${t.type}, ${t.severity}): ${t.reason || 'analyst excluded'}`
  ).join('\n');

  const prompt = `You are a senior M&A financial analyst writing a Quality of Earnings (QoE) narrative report.

Write a detailed, professional QoE narrative for ${companyName} covering ${period}.

ANALYSIS DATA:
- Adjusted QoE Score: ${score}/100 (original AI score: ${originalScore}/100)
- Files analyzed: ${filesProcessed}
- Transactions reviewed: ${reviewedCount} total (${approvedCount} approved, ${rejectedCount} excluded by analyst)

CATEGORY SCORES (post-review):
${catSummary}

KEY FLAGS IDENTIFIED:
${flagSummary || 'No significant flags.'}

ANALYST EXCLUSIONS (${rejectedCount} items rejected):
${rejSummary || 'None — all items approved.'}

Write a detailed QoE narrative of approximately 500 words covering all five of these areas:
1. Overall earnings quality assessment — what the adjusted score of ${score}/100 means in context, how it compares to the original score, and the high-level earnings quality picture
2. Category-by-category findings — go through every category with specific scores, explaining what drove each result and which pose deal risk
3. Analysis of flagged items — discuss the most significant flags, what they reveal about the business, and their implications for deal pricing or structuring
4. Impact of analyst review decisions — explain which transactions were excluded, why that is significant, and how the ${rejectedCount} exclusions changed the picture from the initial AI assessment
5. Final acquirer considerations — a frank assessment of what the deal team should focus on, potential earnout triggers or price adjustments to consider, and what warrants deeper diligence

Target length: approximately 500 words. Write in a formal senior analyst voice. Be specific to the actual data above — no generic filler. Vary sentence structure. Do not start with "In conclusion". Do not use bullet points or headers.`;

  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: DEMO_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 750,
    });
    const narrative = completion.choices[0].message.content;
    const tokens    = completion.usage?.total_tokens || 0;

    // Deduct credits and return updated balance
    let creditInfo = null;
    if (authedUser) {
      const dr = usersDb.deductCredits(authedUser.id, tokens);
      creditInfo = { cost: dr.cost, remaining: dr.remaining };
      console.log(`[narrative] user ${authedUser.id} used ${tokens} tokens, cost $${dr.cost?.toFixed(4)}, balance $${dr.remaining?.toFixed(4)}`);
    }

    res.json({ narrative, tokens, creditInfo });
  } catch (err) {
    console.error('[generate-narrative] error:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

// ─── POST /api/generate-summary ──────────────────────────────────────────────
app.post('/api/generate-summary', async (req, res) => {
  if (!DEMO_API_KEY) return res.status(503).json({ error: 'API not configured' });

  const authedUser = getAuthedUser(req);
  if (authedUser !== null && authedUser.credits < -50) {
    return res.status(402).json({ error: 'Insufficient credits', credits: authedUser.credits });
  }

  const payload = req.body || {};
  const {
    score, companyName, period, filesProcessed, totalTransactions,
    categories = [], flags = [], rejectedItems = [], approvedItems = [],
    rejectedCount, approvedCount
  } = payload;

  const catLines = categories.map(c =>
    `${c.name}: ${c.score}/100`
  ).join(' | ');

  const topFlags = flags.filter(f => f.severity === 'red').slice(0, 5).map(f => f.title).join('; ');

  const prompt = `You are a senior M&A analyst. Write a concise executive summary for a Quality of Earnings report.

DEAL DATA:
- Company: ${companyName}
- Period: ${period}
- Final QoE Score: ${score}/100
- Risk Tier: ${score >= 70 ? 'LOW RISK' : score >= 45 ? 'MODERATE RISK' : 'HIGH RISK'}
- Documents analyzed: ${filesProcessed} | Total transactions: ${totalTransactions}
- Review: ${approvedCount} items approved, ${rejectedCount} items excluded by analyst

CATEGORY SCORES: ${catLines}
TOP RED FLAGS: ${topFlags || 'None'}

Write a plain-language executive summary of approximately 150 words that a non-financial executive or board member could easily understand. Cover:
1. A simple, plain-English verdict on the deal based on the score — avoid jargon
2. The most important 2–3 things the buyer needs to know, explained in plain terms (not financial jargon)
3. The single most important action the deal team should take next

Rules:
- Write at a 10th-grade reading level — no M&A jargon without explanation
- Be direct and honest about risk; do not soften bad scores
- Target exactly 150 words — no more, no less
- Use short paragraphs; no bullet points
- Write as if briefing a CEO who is not a financial expert`;

  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: DEMO_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 300,
    });
    const summary = completion.choices[0].message.content;
    const tokens  = completion.usage?.total_tokens || 0;

    // Deduct credits and return updated balance
    let creditInfo = null;
    if (authedUser) {
      const dr = usersDb.deductCredits(authedUser.id, tokens);
      creditInfo = { cost: dr.cost, remaining: dr.remaining };
      console.log(`[generate-summary] user ${authedUser.id} used ${tokens} tokens, cost $${dr.cost?.toFixed(4)}, balance $${dr.remaining?.toFixed(4)}`);
    }

    res.json({ summary, tokens, creditInfo });
  } catch (err) {
    console.error('[generate-summary] error:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
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
