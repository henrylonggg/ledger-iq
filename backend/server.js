/**
 * server.js — Express API server
 *
 * Routes:
 *   POST /api/analyze   — upload files, parse, score with Claude
 *   GET  /api/health    — health check
 *   GET  /              — serves frontend
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const { parseFile, computeStats } = require('./parser');
const { scoreWithClaude }         = require('./claude');

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

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main analysis endpoint ───────────────────────────────────────────────────
app.post('/api/analyze', upload.array('files', 50), async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey;

  if (!apiKey || !apiKey.startsWith('sk-')) {
    return res.status(401).json({ error: 'Valid OpenAI API key required (starts with sk-)' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
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

      const result = await parseFile(file.originalname, file.buffer);
      parsedFiles.push(result);
      totalTx += result.count;

      emit('log', {
        type: result.parseError ? 'warn' : 'ok',
        message: result.parseError
          ? `${file.originalname}: parse warning — ${result.parseError}`
          : `${file.originalname}: extracted ${result.count} line items`
      });
    }

    // ── STEP 2: Compute backend stats ──────────────────────────────────────
    emit('progress', { step: 'stats', pct: 38, message: `Computed ${totalTx} transactions — running heuristics…` });

    const allTx = parsedFiles.flatMap(f => f.transactions);
    const stats = computeStats(allTx);

    emit('log', { type: 'ok', message: `Heuristics: ${stats.redCount} red, ${stats.yellowCount} yellow, ${stats.greenCount} green` });
    emit('progress', { step: 'stats', pct: 45, message: 'Heuristic classification complete' });

    // ── STEP 3: Claude scores confidence + QoE (the only Claude call) ──────
    emit('progress', { step: 'claude', pct: 50, message: 'Sending structured summary to GPT-4o for scoring…' });
    emit('log', { type: 'info', message: `Sending ${totalTx} pre-classified items to GPT-4o for confidence scoring…` });

    const { report, usage } = await scoreWithClaude(parsedFiles, apiKey);

    emit('log', { type: 'ok', message: `GPT-4o scoring complete — ${usage.totalTokens} tokens used (${usage.inputTokens} in / ${usage.outputTokens} out)` });
    emit('progress', { step: 'claude', pct: 90, message: 'Scoring complete — building report…' });

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
