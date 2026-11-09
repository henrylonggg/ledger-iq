/**
 * parser.js — Pure backend parsing logic.
 * Extracts and classifies transactions from CSV, PDF, XLSX, TXT.
 * No Claude calls here — that happens in claude.js.
 */

const pdfParse = require('pdf-parse');
const { parse: csvParse } = require('csv-parse/sync');
const XLSX = require('xlsx');

// ─── TRANSACTION TYPES ────────────────────────────────────────────────────────
const TYPE_RULES = [
  { pattern: /revenue|sales|income|turnover|arr|mrr|subscription/i,     type: 'Revenue' },
  { pattern: /ebitda|ebit|operating income|adj.*income/i,                type: 'EBITDA Adj' },
  { pattern: /accounts\s*receivable|ar\b|dso|receivable/i,              type: 'Working Capital' },
  { pattern: /accounts\s*payable|ap\b|dpo|payable/i,                    type: 'Working Capital' },
  { pattern: /inventory|stock|dii\b/i,                                   type: 'Working Capital' },
  { pattern: /capex|capital expenditure|property|plant|equipment|ppe/i, type: 'Capex' },
  { pattern: /one.time|non.recurring|restructur|severance|impair/i,     type: 'One-Time' },
  { pattern: /related.party|intercompany|affiliate|related party/i,      type: 'Intercompany' },
  { pattern: /cash|free cash flow|fcf|operating cash/i,                  type: 'Cash Flow' },
  { pattern: /depreciation|amortization|d&a|da\b/i,                      type: 'D&A' },
  { pattern: /cost of goods|cogs|cost of sales|gross profit|margin/i,   type: 'COGS/Margin' },
  { pattern: /sg&a|selling|general|administrative|overhead/i,            type: 'SG&A' },
  { pattern: /debt|loan|interest|leverage|net debt/i,                    type: 'Debt/Leverage' },
  { pattern: /tax|deferred tax|tax rate/i,                               type: 'Tax' },
];

function classifyType(label) {
  for (const r of TYPE_RULES) {
    if (r.pattern.test(label)) return r.type;
  }
  return 'Other';
}

// ─── SEVERITY RULES (pure heuristics, no AI) ──────────────────────────────────
function heuristicSeverity(item) {
  const { label, values, type, pctChange } = item;

  // Red flags
  if (/related.party|intercompany/i.test(label)) return 'red';
  if (/one.time|non.recurring/i.test(label) && Math.abs(item.absMax||0) > 500000) return 'red';
  if (pctChange !== null && Math.abs(pctChange) > 50) return 'red';
  if (/impair|writeoff|write.off|restructur/i.test(label)) return 'red';

  // Yellow flags
  if (pctChange !== null && Math.abs(pctChange) > 20) return 'yellow';
  if (type === 'One-Time') return 'yellow';
  if (/concentration|customer|single|top.?\d/i.test(label)) return 'yellow';
  if (type === 'Intercompany') return 'yellow';

  return 'green';
}

// ─── NUMBER HELPERS ───────────────────────────────────────────────────────────
function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).replace(/[$,\s%()]/g, '').replace(/^\((.+)\)$/, '-$1');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function formatAmount(n) {
  if (n === null) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs/1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs/1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pctChangeFn(a, b) {
  if (a === null || b === null || b === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(buffer) {
  const text = buffer.toString('utf8');
  let records;
  try {
    records = csvParse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    // Try tab-separated
    records = csvParse(text, { delimiter: '\t', skip_empty_lines: true, trim: true, relax_column_count: true });
  }
  if (!records.length) return [];
  return extractTransactionsFromTable(records);
}

// ─── XLSX PARSER ──────────────────────────────────────────────────────────────
function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    rows.push(...data);
  }
  return extractTransactionsFromTable(rows);
}

// ─── SHARED TABLE → TRANSACTIONS ─────────────────────────────────────────────
function extractTransactionsFromTable(rows) {
  if (!rows.length) return [];

  // Find header row (first row with mostly non-numeric content)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const nonNum = rows[i].filter(c => isNaN(parseAmount(c)) && String(c).trim()).length;
    if (nonNum >= 2) { headerIdx = i; break; }
  }

  const headers = rows[headerIdx].map(h => String(h).trim());
  const dataRows = rows.slice(headerIdx + 1);

  // Find numeric columns (likely year/period columns)
  const numericColIdxs = [];
  for (let ci = 1; ci < headers.length; ci++) {
    const vals = dataRows.map(r => parseAmount(r[ci])).filter(v => v !== null);
    if (vals.length >= dataRows.length * 0.3) numericColIdxs.push(ci);
  }

  const transactions = [];
  for (const row of dataRows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    if (/^[-=]+$/.test(label)) continue; // skip separator rows

    const vals = numericColIdxs.map(ci => parseAmount(row[ci]));
    const numeric = vals.filter(v => v !== null);
    if (!numeric.length) continue;

    const latest = numeric[numeric.length - 1];
    const prior  = numeric.length >= 2 ? numeric[numeric.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax = Math.max(...numeric.map(Math.abs));
    const type = classifyType(label);

    transactions.push({
      label,
      type,
      latestValue: latest,
      priorValue: prior,
      pctChange,
      absMax,
      formattedAmount: formatAmount(latest),
      periods: numericColIdxs.map((ci, i) => ({
        period: headers[ci] || `Period ${i+1}`,
        value: vals[i],
        formatted: formatAmount(vals[i])
      })),
      severity: heuristicSeverity({ label, type, pctChange, absMax })
    });
  }
  return transactions;
}

// ─── PDF PARSER ───────────────────────────────────────────────────────────────
async function parsePDF(buffer) {
  let text = '';
  try {
    const data = await pdfParse(buffer);
    text = data.text;
  } catch (e) {
    return { transactions: [], rawText: '', error: e.message };
  }

  // Try to find table-like data in PDF text
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  // Simple line-by-line extraction: look for lines with label + number(s)
  const linePattern = /^(.{3,60?}?)\s+([-$()0-9,\.]+(?:\s+[-$()0-9,\.]+)*)\s*$/;

  for (const line of lines) {
    if (line.length > 150) continue;
    const m = line.match(linePattern);
    if (!m) continue;

    const label = m[1].replace(/\.{3,}/g, '').trim();
    if (!label || label.length < 3) continue;

    const numStrs = m[2].trim().split(/\s+/);
    const nums = numStrs.map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;

    const latest = nums[nums.length - 1];
    const prior  = nums.length >= 2 ? nums[nums.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax = Math.max(...nums.map(Math.abs));
    const type = classifyType(label);

    transactions.push({
      label,
      type,
      latestValue: latest,
      priorValue: prior,
      pctChange,
      absMax,
      formattedAmount: formatAmount(latest),
      severity: heuristicSeverity({ label, type, pctChange, absMax })
    });
  }

  return { transactions, rawText: text.slice(0, 8000) };
}

// ─── TXT PARSER ───────────────────────────────────────────────────────────────
function parseTXT(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Check if it looks like CSV
  const commaLines = lines.filter(l => l.includes(',')).length;
  if (commaLines > lines.length * 0.5) {
    return parseCSV(buffer);
  }

  // Otherwise treat like PDF text extraction
  const transactions = [];
  const pattern = /^(.{3,60?}?)\s+([-$()0-9,\.]+(?:\s+[-$()0-9,\.]+)*)\s*$/;
  for (const line of lines) {
    const m = line.match(pattern);
    if (!m) continue;
    const label = m[1].trim();
    const nums = m[2].split(/\s+/).map(parseAmount).filter(v => v !== null);
    if (!nums.length || !label) continue;
    const latest = nums[nums.length - 1];
    const prior  = nums.length >= 2 ? nums[nums.length - 2] : null;
    const type = classifyType(label);
    transactions.push({
      label, type,
      latestValue: latest, priorValue: prior,
      pctChange: pctChangeFn(prior, latest),
      absMax: Math.max(...nums.map(Math.abs)),
      formattedAmount: formatAmount(latest),
      severity: heuristicSeverity({ label, type, pctChange: pctChangeFn(prior, latest), absMax: Math.max(...nums.map(Math.abs)) })
    });
  }
  return transactions;
}

// ─── AGGREGATE STATS (backend-computed) ──────────────────────────────────────
function computeStats(transactions) {
  const byType = {};
  for (const t of transactions) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  const redCount    = transactions.filter(t => t.severity === 'red').length;
  const yellowCount = transactions.filter(t => t.severity === 'yellow').length;
  const greenCount  = transactions.filter(t => t.severity === 'green').length;

  // Find notable items for Claude context
  const topRed    = transactions.filter(t => t.severity === 'red').slice(0, 5);
  const topYellow = transactions.filter(t => t.severity === 'yellow').slice(0, 5);
  const largestByAbs = [...transactions].sort((a,b) => (b.absMax||0)-(a.absMax||0)).slice(0, 10);

  return { byType, redCount, yellowCount, greenCount, topRed, topYellow, largestByAbs };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
async function parseFile(filename, buffer) {
  const ext = filename.split('.').pop().toLowerCase();
  let transactions = [];
  let rawText = '';
  let parseError = null;

  try {
    if (ext === 'pdf') {
      const result = await parsePDF(buffer);
      transactions = result.transactions;
      rawText = result.rawText || '';
      parseError = result.error || null;
    } else if (ext === 'csv') {
      transactions = parseCSV(buffer);
    } else if (['xlsx', 'xls'].includes(ext)) {
      transactions = parseXLSX(buffer);
    } else {
      transactions = parseTXT(buffer);
    }
  } catch (e) {
    parseError = e.message;
  }

  return { filename, transactions, rawText, parseError, count: transactions.length };
}

module.exports = { parseFile, computeStats, formatAmount };
