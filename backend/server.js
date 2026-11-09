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
const { parseFile, computeStats } = require('./parser');
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

app.use(cors());
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
  if (authedUser !== null && authedUser.credits <= 0) {
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
      parsedFiles.push(result);
      totalTx += result.count;

      // Log sheet-level breakdown for multi-sheet files
      if (result.sheetSummary) {
        const used   = result.sheetSummary.filter(s => !s.skipped && s.count > 0);
        const skipped = result.sheetSummary.filter(s => s.skipped);
        emit('log', { type: result.count > 0 ? 'ok' : 'warn',
          message: `${file.originalname}: extracted ${result.count} items across ${used.length} sheets` +
            (skipped.length ? ` (skipped: ${skipped.map(s=>s.name).join(', ')})` : '')
        });
      } else {
        emit('log', {
          type: result.parseError ? 'warn' : 'ok',
          message: result.parseError
            ? `${file.originalname}: parse warning — ${result.parseError}`
            : `${file.originalname}: extracted ${result.count} line items`
        });
      }
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

    const { report, usage } = await scoreWithClaude(parsedFiles, apiKey);

    emit('log', { type: 'ok', message: `GPT-4o mini scoring complete — ${usage.totalTokens} tokens used (${usage.inputTokens} in / ${usage.outputTokens} out)` });
    emit('progress', { step: 'claude', pct: 90, message: 'Scoring complete — building report…' });

    // Deduct credits for authenticated users
    if (authedUser) {
      const deductResult = usersDb.deductCredits(authedUser.id, usage.totalTokens);
      if (deductResult.ok) {
        emit('log', { type: 'info', message: `Credits used: $${deductResult.cost.toFixed(4)} — balance: $${deductResult.remaining.toFixed(2)}` });
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
