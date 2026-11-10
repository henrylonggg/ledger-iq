/**
 * layout-map.js — teach the AI where things are, then extract locally.
 *
 * Every client formats spreadsheets differently (title rows, headers on row 7,
 * labels in column B, periods running right-to-left, values "in thousands",
 * metrics across the top instead of down the side...). Instead of sending whole
 * files to the model and asking it to re-type every row (slow, truncated,
 * expensive), we:
 *
 *   1. read each sheet locally and, if the existing parser already reads it
 *      confidently, use that result  -> 0 tokens
 *   2. otherwise send a SMALL structural sample (a dozen rows + per-column
 *      stats) and ask the model only for a LAYOUT MAP: header row, label column,
 *      period columns, units, orientation, document type
 *   3. apply that map to every row in plain code (cost does not grow with file size)
 *   4. cache the map by sheet structure, so the next file in the same format is free
 *   5. in one small batched call, classify the line items our rules could not
 *
 * The API key is passed in by the caller and never stored or logged here.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const XLSX   = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');
const P = require('./parser');
const { createCompletion } = require('./openai-client');

const VERSION   = 2;                                   // bump to invalidate every cached map
const CACHE_DIR = process.env.LAYOUT_CACHE_DIR || path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'layout-cache.json');

const TYPES = ['Revenue', 'EBITDA Adj', 'COGS & Margin', 'SG&A', 'Payroll', 'Owner Compensation', 'Non-Recurring',
  'Related Party', 'Accounts Receivable', 'Accounts Payable', 'Inventory', 'Debt & Leverage', 'Tax', 'Cash & Bank',
  'CapEx & Fixed Assets', 'D&A', 'Working Capital', 'Revenue Recognition', 'Backlog & Pipeline',
  'Prepaids & Accruals', 'Contractors', 'Other'];
const DOC_TYPES = [...new Set([...P.DOC_TYPES, 'Income Statement', 'Balance Sheet', 'Financial Document'])];

// Shapes the existing specialised extractors understand (label in column 0, buckets after it).
const SPECIALIZED = {
  'Accounts Receivable': P.extractARAgingRows,
  'Payroll Tax': P.extractPayrollRows,
  'Employee Census': P.extractPayrollRows,
  'Debt Schedule': P.extractDebtRows,
  'EBITDA Adjustments': P.extractEBITDARows,
  'Tax Return': P.extractTaxRows,
  'Book-to-Tax Reconciliation': P.extractTaxRows,
};
const DOCTYPE_TYPE_HINT = { 'Accounts Receivable': 'Accounts Receivable', 'Accounts Payable': 'Accounts Payable',
  'Debt Schedule': 'Debt & Leverage', 'CapEx & Fixed Assets': 'CapEx & Fixed Assets', 'Payroll Tax': 'Payroll',
  'Employee Census': 'Payroll', 'Contractor Roster': 'Contractors', 'Related Party Transactions': 'Related Party',
  'Non-Recurring Items': 'Non-Recurring', 'Tax Return': 'Tax' };

/* ─── cache ─────────────────────────────────────────────────────────────── */
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = null; }
  if (!cache || cache.v !== VERSION) cache = { v: VERSION, layouts: {}, types: {} };
  return cache;
}
function saveCache() {
  const c = loadCache();
  if (Object.keys(c.layouts).length > 3000) c.layouts = {};
  if (Object.keys(c.types).length > 20000)  c.types = {};
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(c));
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch { /* read-only host: caching is an optimisation, never required */ }
}
function _resetCacheForTests() { cache = null; }

/* ─── reading ───────────────────────────────────────────────────────────── */
function readSheets(buffer, ext) {
  if (ext === 'csv') {
    const text = buffer.toString('utf8');
    let rows;
    try { rows = csvParse(text, { skip_empty_lines: true, trim: true, relax_column_count: true }); }
    catch { rows = csvParse(text, { delimiter: '\t', skip_empty_lines: true, trim: true, relax_column_count: true }); }
    return [{ name: 'CSV', rows }];
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) }));
}

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const normCell = c => String(c ?? '').trim().toLowerCase().slice(0, 24).replace(/[0-9]/g, '#');

/** Same format (headers/shape) => same fingerprint, regardless of the numbers inside. */
function fingerprint(sheetName, rows) {
  const lines = []; let first = -1;
  rows.forEach((r, i) => {
    if (lines.length >= 12 || P.isBlankRow(r)) return;
    if (first < 0) first = i;
    lines.push(`${i - first}:` + r.slice(0, 20).map(normCell).join('|'));
  });
  const cols = Math.max(0, ...rows.slice(0, 60).map(r => (r || []).length));
  return sha1(`v${VERSION}::${normCell(sheetName)}::${first}::${cols}::${lines.join('\n')}`);
}

/** "($ in thousands)" style notes near the top of a sheet. */
function detectUnits(rows) {
  const top = rows.slice(0, 10).flat().map(c => String(c ?? '')).join(' ');
  if (/in\s+millions|\$\s*mm\b|\(\s*mm\s*\)|\$\s*in\s*m\b/i.test(top)) return 1e6;
  if (/in\s+thousands|\$\s*000|\(\s*000s?\s*\)|\$\s*k\b|\(\s*\$?k\s*\)/i.test(top)) return 1e3;
  return 1;
}

/* ─── is the local parse trustworthy? ───────────────────────────────────── */
function candidateRows(rows) {
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    const li = r.findIndex(c => { const s = String(c ?? '').trim(); return s.length >= 2 && P.parseAmount(c) === null; });
    if (li < 0) continue;
    if (P.numericCount(r.filter((_, i) => i !== li)) >= 1) n++;
  }
  return n;
}

function localConfident(rows, txs, docType) {
  if (txs.length < 3) return false;
  if (detectUnits(rows) !== 1) return false;               // amounts need scaling -> let the map handle it
  if (SPECIALIZED[docType]) return true;                    // known schedule shapes keep their dedicated extractors
  if (P.isLongFormat(rows)) return true;
  const cand = candidateRows(rows);
  if (!cand) return false;
  const recall    = txs.length / cand;
  const fallbackH = txs.some(t => (t.periods || []).some(p => /^Period \d+$/.test(p.period)));
  const unique    = new Set(txs.map(t => t.label.toLowerCase())).size / txs.length;
  return recall >= 0.8 && !fallbackH && unique >= 0.6;
}

/* ─── the AI call: describe the layout, extract nothing ─────────────────── */
const cell = v => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 26); return s === '' ? '·' : s; };

function sampleSheet(name, rows, maxRows) {
  const nb   = rows.map((r, i) => [i, r || []]).filter(([, r]) => !P.isBlankRow(r));
  const head = nb.slice(0, maxRows);
  const tail = nb.length > maxRows + 4 ? nb.slice(-4) : [];
  const fullCols = Math.max(0, ...rows.slice(0, 200).map(r => (r || []).length));
  const cols = Math.min(16, fullCols);
  const prof = [];
  for (let c = 0; c < cols; c++) {
    const vals = rows.slice(0, 200).map(r => (r || [])[c]).filter(v => String(v ?? '').trim() !== '');
    const num  = vals.filter(v => P.parseAmount(v) !== null).length;
    prof.push(`c${c}=${vals.length ? Math.round(100 * num / vals.length) : 0}%`);
  }
  const line = ([i, r]) => `r${i}: ` + Array.from({ length: cols }, (_, c) => cell(r[c])).join(' | ');
  return [`### SHEET "${name}" — ${rows.length} rows x ${fullCols} cols${fullCols > cols ? ` (first ${cols} shown)` : ''}`,
    `numeric share per column: ${prof.join(' ')}`,
    ...head.map(line),
    ...(tail.length ? ['... last rows ...', ...tail.map(line)] : [])].join('\n');
}

const MAP_SYSTEM = `You map the LAYOUT of spreadsheets for an M&A financial due-diligence tool. You NEVER extract or retype values. For each sheet, say where the data lives so code can read every row.

Rows and columns are zero-based, exactly as labelled (r12 = row 12, c3 = column 3). Cells show "·" when empty.

Return JSON: {"sheets":[ {
  "sheet": "<exact sheet name>",
  "use": true|false,                      // false for covers, notes, instructions, checks, blank or non-financial sheets
  "docType": one of ${JSON.stringify(DOC_TYPES)},
  "orientation": "periods_in_columns"|"periods_in_rows"|"long",
  "headerRow": <row index of the column headings, or null>,
  "firstDataRow": <first row of real data>,
  "labelCol": <column holding line-item names (for periods_in_rows: the column holding the period/date labels)>,
  "valueCols": [ {"col": <n>, "period": "<heading, e.g. FY2023>"} ],   // numeric columns to read; for periods_in_rows these are the metric columns and "period" is the metric name
  "long": {"labelCol": n, "periodCol": n, "valueCol": n},               // only when orientation is "long"
  "skipLabelContains": ["check", ...],    // lowercase fragments of rows to ignore (check rows, memo lines). Keep real totals.
  "unitsMultiplier": 1|1000|1000000,      // if the sheet says amounts are in thousands / millions
  "periodOrder": "oldest_first"|"newest_first",   // left-to-right (or top-to-bottom) order of the periods
  "confidence": <0..1>
} ]}
Include every sheet shown. Do not include commentary.`;

function sanitizeEntry(e, rows) {
  if (!e || typeof e !== 'object') return null;
  const maxC = Math.max(1, ...rows.slice(0, 200).map(r => (r || []).length));
  const int  = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi) ? v : d;
  const out  = {
    use: e.use !== false,
    docType: DOC_TYPES.includes(e.docType) ? e.docType : 'Financial Document',
    orientation: ['periods_in_columns', 'periods_in_rows', 'long'].includes(e.orientation) ? e.orientation : 'periods_in_columns',
    headerRow: int(e.headerRow, 0, rows.length - 1, null),
    labelCol: int(e.labelCol, 0, maxC - 1, 0),
    unitsMultiplier: [1, 1e3, 1e6].includes(e.unitsMultiplier) ? e.unitsMultiplier : 1,
    periodOrder: e.periodOrder === 'newest_first' ? 'newest_first' : 'oldest_first',
    skipLabelContains: (Array.isArray(e.skipLabelContains) ? e.skipLabelContains : [])
      .filter(s => typeof s === 'string' && s.trim()).map(s => s.toLowerCase().slice(0, 40)).slice(0, 12),
    valueCols: [],
  };
  out.firstDataRow = int(e.firstDataRow, 0, rows.length, (out.headerRow ?? -1) + 1);
  const seen = new Set();
  for (const v of (Array.isArray(e.valueCols) ? e.valueCols : []).slice(0, 40)) {
    const col = int(v?.col, 0, maxC - 1, null);
    if (col === null || seen.has(col) || (out.orientation !== 'long' && col === out.labelCol)) continue;
    seen.add(col);
    out.valueCols.push({ col, period: String(v.period ?? `Period ${out.valueCols.length + 1}`).slice(0, 40) });
  }
  if (out.orientation === 'long') {
    const L = e.long || {};
    out.long = { labelCol: int(L.labelCol, 0, maxC - 1, null), periodCol: int(L.periodCol, 0, maxC - 1, null), valueCol: int(L.valueCol, 0, maxC - 1, null) };
    if (Object.values(out.long).some(v => v === null)) return null;
  } else if (!out.valueCols.length) return null;
  return out;
}

async function askForMaps(filename, pending, apiKey, log) {
  const many = pending.length > 6;
  const body = pending.map(p => sampleSheet(p.name, p.rows, many ? 12 : 22)).join('\n\n');
  const r = await createCompletion(apiKey, {
    temperature: 0, max_tokens: Math.min(4000, 350 + pending.length * 450),
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: MAP_SYSTEM }, { role: 'user', content: `File: ${filename}\n\n${body}` }],
  }, { label: 'layout-map' });
  const tokens = r.usage?.total_tokens || 0;
  let parsed;
  try { parsed = JSON.parse(r.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
  const byName = new Map((parsed.sheets || []).map(s => [String(s.sheet), s]));
  return { byName, tokens };
}

/* ─── apply a map to every row (no AI, no tokens) ───────────────────────── */
function buildTx(label, series, section, docType, sheetName, order) {
  if (order === 'newest_first') series = series.slice().reverse();
  const nums = series.map(s => s.value).filter(v => v !== null);
  if (!nums.length) return null;
  const latest = nums[nums.length - 1], prior = nums.length >= 2 ? nums[nums.length - 2] : null;
  let type = P.classifyType(label);
  if (type === 'Other' && DOCTYPE_TYPE_HINT[docType]) type = DOCTYPE_TYPE_HINT[docType];
  const pct = P.pctChangeFn(prior, latest), absMax = Math.max(...nums.map(Math.abs));
  return { label, type, section: section || undefined, latestValue: latest, priorValue: prior, pctChange: pct, absMax,
    formattedAmount: P.formatAmount(latest),
    periods: series.map(s => ({ period: s.period, value: s.value, formatted: P.formatAmount(s.value) })),
    severity: P.heuristicSeverity({ label, type, pctChange: pct, absMax, docType }),
    sourceSheet: sheetName, docType, mapped: true };
}

function applyMap(rows, m, sheetName) {
  const mult = m.unitsMultiplier || 1;
  const val  = v => { const n = P.parseAmount(v); return n === null ? null : n * mult; };
  const skip = l => m.skipLabelContains.some(s => l.toLowerCase().includes(s));
  const junk = l => l.length < 2 || /^[-=_*\/]{3,}$/.test(l) || /^(page\s*\d|prepared by|report date|source:|on edgar|view |http)/i.test(l) || skip(l);
  const txs = [];

  if (m.orientation === 'long') {
    const { labelCol, periodCol, valueCol } = m.long, by = new Map();
    for (let i = m.firstDataRow; i < rows.length; i++) {
      const r = rows[i]; if (!r) continue;
      const label = String(r[labelCol] ?? '').trim(), period = String(r[periodCol] ?? '').trim(), v = val(r[valueCol]);
      if (junk(label) || !period || v === null) continue;
      if (!by.has(label)) by.set(label, new Map());
      by.get(label).set(period, v);
    }
    for (const [label, pm] of by) {
      const series = [...pm.keys()].sort().map(p => ({ period: p, value: pm.get(p) }));
      const t = buildTx(label, series, '', m.docType, sheetName, 'oldest_first'); if (t) txs.push(t);
    }
    return txs;
  }

  if (m.orientation === 'periods_in_rows') {
    const hdr = rows[m.headerRow ?? Math.max(0, m.firstDataRow - 1)] || [];
    for (const vc of m.valueCols) {
      const label = String(hdr[vc.col] ?? vc.period ?? '').trim();
      if (junk(label)) continue;
      const series = [];
      for (let i = m.firstDataRow; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const per = String(r[m.labelCol] ?? '').trim(), v = val(r[vc.col]);
        if (!per || v === null || /^(total|average|avg)/i.test(per)) continue;
        series.push({ period: per, value: v });
      }
      const t = buildTx(label, series, '', m.docType, sheetName, m.periodOrder); if (t) txs.push(t);
    }
    return txs;
  }

  // periods_in_columns (the usual shape)
  const special = SPECIALIZED[m.docType];
  if (special) {
    const data = rows.slice(m.firstDataRow).filter(r => r && !P.isBlankRow(r))
      .map(r => [r[m.labelCol], ...m.valueCols.map(vc => r[vc.col])]);
    return special(data).map(t => ({ ...t, sourceSheet: sheetName, docType: m.docType, mapped: true }));
  }
  let section = '';
  for (let i = m.firstDataRow; i < rows.length; i++) {
    const r = rows[i]; if (!r || P.isBlankRow(r)) continue;
    const label = String(r[m.labelCol] ?? '').trim();
    if (junk(label)) continue;
    const series = m.valueCols.map(vc => ({ period: vc.period, value: val(r[vc.col]) }));
    if (!series.some(s => s.value !== null)) { if (label.length < 80) section = label; continue; }
    const t = buildTx(label, series, section, m.docType, sheetName, m.periodOrder); if (t) txs.push(t);
  }
  return txs;
}

/* ─── one spreadsheet / CSV ─────────────────────────────────────────────── */
/**
 * @returns {{transactions, sheetSummary, docType, tokens, aiCalls, cacheHits, localSheets}}
 * mode: 'auto' (default: AI only when needed) | 'always' | 'never'
 */
async function parseSpreadsheet(filename, buffer, ext, apiKey, { mode = 'auto', log = () => {} } = {}) {
  const sheets = readSheets(buffer, ext);
  const plan = [];                                          // one entry per sheet
  for (const sh of sheets) {
    if (P.shouldSkipSheet(sh.name, sh.rows)) { plan.push({ ...sh, skipped: true }); continue; }
    const sample  = sh.name + ' ' + sh.rows.slice(0, 10).flat().map(c => String(c ?? '')).filter(s => s && s.length < 100).join(' ');
    const docType = P.detectDocType(filename + ' ' + sh.name, sample);
    const local   = P.extractTransactionsFromTable(sh.rows, docType);
    const confident = localConfident(sh.rows, local, docType);
    const wantAI    = mode === 'always' || (mode === 'auto' && !confident);
    plan.push({ ...sh, docType, local, confident, wantAI: wantAI && !!apiKey, fp: fingerprint(sh.name, sh.rows) });
  }

  const c = loadCache();
  const pending = plan.filter(p => p.wantAI && !c.layouts[p.fp]);
  let tokens = 0, aiCalls = 0, cacheHits = 0, aiError = null;

  if (pending.length) {
    try {
      const { byName, tokens: t } = await askForMaps(filename, pending, apiKey, log);
      tokens += t; aiCalls++;
      for (const p of pending) {
        const m = sanitizeEntry(byName.get(p.name), p.rows);
        if (m) c.layouts[p.fp] = m;                         // cache even use:false so skipped sheets stay free
      }
      saveCache();
    } catch (e) {
      aiError = e;                                          // fall back to the local parse for these sheets
      log('warn', `${filename}: AI layout mapping unavailable (${e.code || e.message}) — using the built-in parser`);
    }
  }

  const transactions = [], sheetSummary = [];
  let localSheets = 0;
  for (const p of plan) {
    if (p.skipped) { sheetSummary.push({ name: p.name, skipped: true, count: 0 }); continue; }
    const m = p.wantAI ? c.layouts[p.fp] : null;
    let txs = [], method = 'local', docType = p.docType;

    if (m) {
      if (!pending.includes(p)) cacheHits++;
      method = pending.includes(p) ? 'ai' : 'cache';
      if (m.use === false) { sheetSummary.push({ name: p.name, skipped: true, count: 0, method }); continue; }
      docType = m.docType !== 'Financial Document' ? m.docType : p.docType;
      txs = applyMap(p.rows, { ...m, docType }, p.name);
      if (!txs.length) { txs = p.local; method = 'local'; }  // a map that finds nothing is not trusted
    } else {
      txs = p.local;
    }
    if (method === 'local') localSheets++;
    for (const t of txs) { t.sourceSheet = t.sourceSheet || p.name; t.docType = t.docType || docType; }
    transactions.push(...txs);
    sheetSummary.push({ name: p.name, skipped: false, docType, count: txs.length, method });
  }

  const main = sheetSummary.find(s => !s.skipped && s.count > 0);
  return { transactions, sheetSummary, docType: main?.docType || P.detectDocType(filename, ''),
    tokens, aiCalls, cacheHits, localSheets, aiError };
}

/* ─── label classification for what our rules call "Other" ──────────────── */
const normLabel = l => String(l || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * One small batched call (chunks of 120 labels) that assigns a transaction type to labels the
 * keyword rules could not place. Only runs when enough unknowns exist; results are cached per label.
 */
async function refineTypes(transactions, apiKey, { minUnknown = 4, log = () => {} } = {}) {
  const c = loadCache();
  const unknown = new Map();                                // normalised label -> display label (+doc type)
  for (const t of transactions) {
    if (t.type !== 'Other') continue;
    const k = normLabel(t.label);
    if (!k) continue;
    if (c.types[k]) continue;
    if (!unknown.has(k)) unknown.set(k, `${t.label}${t.docType ? `  [${t.docType}]` : ''}`);
  }
  let tokens = 0, calls = 0;
  if (apiKey && unknown.size >= minUnknown) {
    const entries = [...unknown.entries()];
    for (let i = 0; i < entries.length; i += 120) {
      const chunk = entries.slice(i, i + 120);
      try {
        const r = await createCompletion(apiKey, {
          temperature: 0, max_tokens: 1500, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `You classify line items from a company's financial files for a Quality of Earnings review. For each numbered item choose the single best type from ${JSON.stringify(TYPES)}. Use "Other" only if none fit. Return JSON {"types":{"1":"Revenue","2":"SG&A",...}}.` },
            { role: 'user', content: chunk.map(([, d], j) => `${j + 1}. ${d}`).join('\n') },
          ],
        }, { label: 'classify' });
        tokens += r.usage?.total_tokens || 0; calls++;
        let out = {}; try { out = JSON.parse(r.choices?.[0]?.message?.content || '{}').types || {}; } catch {}
        chunk.forEach(([k], j) => { const t = out[String(j + 1)]; if (TYPES.includes(t)) c.types[k] = t; });
      } catch (e) { log('warn', `Line-item classification unavailable (${e.code || e.message}) — keeping rule-based types`); break; }
    }
    if (calls) saveCache();
  }
  let changed = 0;
  for (const t of transactions) {
    if (t.type !== 'Other') continue;
    const nt = c.types[normLabel(t.label)];
    if (nt && nt !== 'Other') {
      t.type = nt; changed++;
      t.severity = P.heuristicSeverity({ label: t.label, type: nt, pctChange: t.pctChange, absMax: t.absMax, docType: t.docType });
    }
  }
  return { tokens, calls, changed, unknown: unknown.size };
}

module.exports = { parseSpreadsheet, refineTypes, applyMap, sanitizeEntry, fingerprint, detectUnits, localConfident, _resetCacheForTests, TYPES };
