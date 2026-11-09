/**
 * parser.js — Pure backend parsing logic.
 * No Claude calls. Handles 25+ QoE document types.
 * Extracts, classifies, and flags transactions/line-items from any financial file.
 */

const pdfParse = require('pdf-parse');
const { parse: csvParse } = require('csv-parse/sync');
const XLSX = require('xlsx');

// ─── DOCUMENT TYPE DETECTION ──────────────────────────────────────────────────
// Detected from filename + content — tells Claude which analytical lens to use

const DOC_TYPE_RULES = [
  // Income / P&L
  { pattern: /income.state|profit.*loss|p&l|pnl|earnings.state/i,          docType: 'Income Statement' },
  // Balance sheet
  { pattern: /balance.sheet|financial.position|assets.*liabilit/i,          docType: 'Balance Sheet' },
  // Cash flow
  { pattern: /cash.flow|statement.of.cash/i,                                 docType: 'Cash Flow Statement' },
  // General ledger
  { pattern: /general.ledger|gl.detail|detailed.gl|ledger.detail/i,          docType: 'General Ledger' },
  // Trial balance
  { pattern: /trial.balance|tb\b/i,                                           docType: 'Trial Balance' },
  // Audited / reviewed financials
  { pattern: /audit|review.*financial|cpa.report|independent.auditor/i,       docType: 'Audited Financials' },
  // Chart of accounts
  { pattern: /chart.of.account|coa\b|account.list|account.schedule/i,         docType: 'Chart of Accounts' },
  // Tax returns
  { pattern: /form.1120|form.1065|form.1040|federal.tax.return|state.tax.return|tax.return/i, docType: 'Tax Return' },
  // Book-to-tax reconciliation
  { pattern: /book.to.tax|btax|tax.reconcil|book.tax.diff/i,                  docType: 'Book-to-Tax Reconciliation' },
  // Sales & use tax
  { pattern: /sales.tax|use.tax|sales.*use.tax/i,                             docType: 'Sales & Use Tax' },
  // Payroll tax
  { pattern: /payroll.tax|form.941|form.940|w-?2|payroll.report/i,            docType: 'Payroll Tax' },
  // Tax audit records
  { pattern: /tax.audit|irs.audit|state.audit.record/i,                       docType: 'Tax Audit Records' },
  // Revenue recognition / customer revenue
  { pattern: /revenue.recogn|rev.rec|customer.*revenue|monthly.*revenue|revenue.*schedule/i, docType: 'Revenue Recognition' },
  // Customer contracts / rate cards
  { pattern: /contract|rate.card|customer.agreement|msa\b|sow\b|pricing.schedule/i, docType: 'Customer Contracts' },
  // Backlog / pipeline
  { pattern: /backlog|pipeline|deal.*stage|sales.pipeline|opportunity/i,      docType: 'Backlog & Pipeline' },
  // Accounts receivable
  { pattern: /accounts.receivable|ar.aging|receivable.aging|ar.schedule/i,    docType: 'Accounts Receivable' },
  // Accounts payable
  { pattern: /accounts.payable|ap.aging|payable.aging|ap.schedule/i,          docType: 'Accounts Payable' },
  // Inventory
  { pattern: /inventor|stock.on.hand|raw.material|work.in.process|wip\b/i,    docType: 'Inventory' },
  // Prepaid / accruals
  { pattern: /prepaid|accrual|deferred.expense|accrued.liabilit/i,            docType: 'Prepaids & Accruals' },
  // Bank statements / proof of cash
  { pattern: /bank.state|proof.of.cash|bank.reconcil|checking|savings.*account/i, docType: 'Bank Statement' },
  // EBITDA adjustments / management adjustments
  { pattern: /ebitda.adj|management.adj|adj.*ebitda|addback|add.back|mgmt.adj/i, docType: 'EBITDA Adjustments' },
  // Owner / exec compensation
  { pattern: /owner.comp|exec.*comp|officer.*comp|compensation.*benefit|benefit.*comp|officer.*salary/i, docType: 'Owner Compensation' },
  // Related party transactions
  { pattern: /related.party|intercompany|related.entity|affiliate.trans/i,    docType: 'Related Party Transactions' },
  // Non-recurring / extraordinary
  { pattern: /non.recurring|extraordinary|one.time|nonrecurring/i,            docType: 'Non-Recurring Items' },
  // Employee census / headcount
  { pattern: /employee.census|headcount|employee.list|staff.list|org.chart|employee.roster/i, docType: 'Employee Census' },
  // Independent contractor
  { pattern: /contractor|1099|independent.contractor|freelance|vendor.roster/i, docType: 'Contractor Roster' },
  // Debt / financing schedules
  { pattern: /debt.schedule|loan.schedule|financing.schedule|amortiz.*schedule|note.*payable.*schedule/i, docType: 'Debt Schedule' },
  // CapEx / fixed assets
  { pattern: /capex|fixed.asset|capital.expenditure|asset.schedule|depreciation.schedule/i, docType: 'CapEx & Fixed Assets' },
  // Monthly financials (generic)
  { pattern: /monthly.financial|month.*statement|monthly.p&l|monthly.income/i, docType: 'Monthly Financials' },
];

function detectDocType(filename, text) {
  const combined = `${filename} ${(text || '').slice(0, 2000)}`;
  for (const r of DOC_TYPE_RULES) {
    if (r.pattern.test(combined)) return r.docType;
  }
  return 'Financial Document';
}

// ─── TRANSACTION TYPE RULES ───────────────────────────────────────────────────
const TYPE_RULES = [
  // Revenue
  { pattern: /\brevenue\b|net sales|gross sales|\bsales\b|turnover|\barr\b|\bmrr\b|subscription.*rev|recurring.*rev|contract.*rev|backlog.*rev/i, type: 'Revenue' },
  // EBITDA
  { pattern: /ebitda|ebit\b|operating income|adj.*income|add.?back|management adj|normalized/i, type: 'EBITDA Adj' },
  // Accounts receivable / AR
  { pattern: /accounts.?receivable|\bar aging\b|receivable aging|dso\b|days.*outstanding.*receiv/i, type: 'Accounts Receivable' },
  // Accounts payable / AP
  { pattern: /accounts.?payable|\bap aging\b|payable aging|dpo\b|days.*payable/i, type: 'Accounts Payable' },
  // Inventory
  { pattern: /inventor|\bwip\b|work.in.process|raw material|finished goods|stock.on.hand|days.*inventory|dii\b/i, type: 'Inventory' },
  // CapEx / Fixed Assets
  { pattern: /capex|capital expenditure|property.*plant|plant.*equipment|\bppe\b|fixed asset|asset addition|depreciation.schedule/i, type: 'CapEx & Fixed Assets' },
  // One-time / non-recurring
  { pattern: /one.time|non.?recurring|extraordinary|restructur|impair|write.?off|severance|settlement|legal.*fee|litigation/i, type: 'Non-Recurring' },
  // Related party / intercompany
  { pattern: /related.party|intercompany|affiliate|related entity|owner.*loan|shareholder.*loan|mgmt.*fee|management.*fee.*related/i, type: 'Related Party' },
  // Cash / bank
  { pattern: /\bcash\b|free cash flow|\bfcf\b|operating cash|bank balance|proof of cash|cash.*equivalent/i, type: 'Cash & Bank' },
  // D&A
  { pattern: /depreciation|amortization|\bd&a\b|\bda\b/i, type: 'D&A' },
  // COGS / Gross Profit
  { pattern: /cost of goods|cost of sales|\bcogs\b|gross profit|gross margin|cost of revenue/i, type: 'COGS & Margin' },
  // SG&A / Overhead
  { pattern: /sg&a|selling.*general|general.*admin|overhead|\bopex\b|operating expense/i, type: 'SG&A' },
  // Owner / exec comp
  { pattern: /owner.*comp|exec.*comp|officer.*salary|officer.*comp|shareholder.*salary|distributions.*owner|compensation.*benefit|draw\b/i, type: 'Owner Compensation' },
  // Payroll / headcount
  { pattern: /payroll|\bwages\b|\bsalaries\b|headcount|employee count|benefits.*employee|payroll.*tax|941\b/i, type: 'Payroll' },
  // Contractor / 1099
  { pattern: /contractor|independent.*contractor|1099|freelance|outsourced.*labor|subcontract/i, type: 'Contractors' },
  // Debt / leverage
  { pattern: /\bdebt\b|long.term.*debt|short.term.*debt|\bloan\b|interest.*expense|\bnote\b|leverage|net debt|credit.*facility|revolver/i, type: 'Debt & Leverage' },
  // Tax
  { pattern: /\btax\b|income tax|deferred tax|tax.*provision|tax.*rate|tax.*liability|book.to.tax/i, type: 'Tax' },
  // Working capital (generic)
  { pattern: /working capital|net working capital|\bnwc\b|current ratio|quick ratio/i, type: 'Working Capital' },
  // Revenue recognition / contracts
  { pattern: /deferred revenue|contract liability|unbilled|revenue recogn|rev rec|contract asset/i, type: 'Revenue Recognition' },
  // Prepaids / accruals
  { pattern: /prepaid|accrued|accrual|deferred.*expense/i, type: 'Prepaids & Accruals' },
  // Backlog / pipeline
  { pattern: /backlog|pipeline|deal.*stage|bookings|contracted.*revenue|signed.*contract/i, type: 'Backlog & Pipeline' },
];

function classifyType(label) {
  for (const r of TYPE_RULES) {
    if (r.pattern.test(label)) return r.type;
  }
  return 'Other';
}

// ─── SEVERITY HEURISTICS ──────────────────────────────────────────────────────
function heuristicSeverity(item) {
  const { label, type, pctChange, absMax, docType } = item;

  // Always red
  if (type === 'Related Party') return 'red';
  if (/impair|write.?off|restructur|extraordinary/i.test(label)) return 'red';
  if (pctChange !== null && Math.abs(pctChange) > 50) return 'red';
  if (type === 'Non-Recurring' && (absMax || 0) > 500000) return 'red';
  if (/concentration|single.*customer|top.*customer.*>/i.test(label)) return 'red';
  if (type === 'Owner Compensation' && (absMax || 0) > 1000000) return 'red';
  if (/fraud|restatement|material.*weakness/i.test(label)) return 'red';

  // Yellow
  if (pctChange !== null && Math.abs(pctChange) > 20) return 'yellow';
  if (type === 'Non-Recurring') return 'yellow';
  if (type === 'Owner Compensation') return 'yellow';
  if (type === 'Contractors' && (absMax || 0) > 250000) return 'yellow';
  if (type === 'Revenue Recognition') return 'yellow';
  if (type === 'Backlog & Pipeline') return 'yellow';
  if (/overdue|past.due|disputed|write.?down/i.test(label)) return 'yellow';
  if (type === 'Tax' && /deferred/i.test(label)) return 'yellow';

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
  if (n === null || n === undefined) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pctChangeFn(a, b) {
  if (a === null || b === null || b === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

// ─── SPECIALIZED EXTRACTORS ───────────────────────────────────────────────────

// AR Aging: extracts buckets (current, 30, 60, 90+ days)
function extractARAgingRows(rows) {
  const txs = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    const nums = row.slice(1).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const total = nums[nums.length - 1] || nums[0];
    const over90 = nums[3] || nums[nums.length - 1];
    const pctOver90 = total ? (over90 / total) * 100 : null;
    const severity = pctOver90 !== null && pctOver90 > 25 ? 'red'
      : pctOver90 !== null && pctOver90 > 10 ? 'yellow' : 'green';
    txs.push({
      label: `AR: ${label}`,
      type: 'Accounts Receivable',
      latestValue: total,
      priorValue: null,
      pctChange: null,
      absMax: Math.abs(total || 0),
      formattedAmount: formatAmount(total),
      severity,
      meta: { over90: formatAmount(over90), pctOver90: pctOver90 ? pctOver90.toFixed(1) + '%' : 'N/A' }
    });
  }
  return txs;
}

// Payroll / headcount: look for employee counts + dollar amounts
function extractPayrollRows(rows) {
  const txs = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    const nums = row.slice(1).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const latest = nums[nums.length - 1];
    const prior  = nums.length >= 2 ? nums[nums.length - 2] : null;
    const type   = /headcount|count|fte|employee/i.test(label) ? 'Payroll' : classifyType(label);
    txs.push({
      label: `Payroll: ${label}`,
      type,
      latestValue: latest,
      priorValue: prior,
      pctChange: pctChangeFn(prior, latest),
      absMax: Math.max(...nums.map(Math.abs)),
      formattedAmount: formatAmount(latest),
      severity: heuristicSeverity({ label, type, pctChange: pctChangeFn(prior, latest), absMax: Math.max(...nums.map(Math.abs)) })
    });
  }
  return txs;
}

// Debt schedule: extract loan balances, interest rates, maturity
function extractDebtRows(rows) {
  const txs = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    const nums = row.slice(1).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const balance = nums[0];
    // Look for interest rate (small decimal %)
    const rate = nums.find(n => n > 0 && n < 30) || null;
    txs.push({
      label: `Debt: ${label}`,
      type: 'Debt & Leverage',
      latestValue: balance,
      priorValue: null,
      pctChange: null,
      absMax: Math.abs(balance || 0),
      formattedAmount: formatAmount(balance),
      severity: (balance || 0) > 5000000 ? 'yellow' : 'green',
      meta: { interestRate: rate ? rate.toFixed(2) + '%' : 'N/A' }
    });
  }
  return txs;
}

// EBITDA adjustments: each addback / adjustment is its own item
function extractEBITDARows(rows) {
  const txs = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    const nums = row.slice(1).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const val   = nums[nums.length - 1];
    const prior = nums.length >= 2 ? nums[nums.length - 2] : null;
    // Any adjustment line is at minimum yellow
    const severity = /related|owner|personal|discretionary/i.test(label) ? 'red' : 'yellow';
    txs.push({
      label: `Adj: ${label}`,
      type: 'EBITDA Adj',
      latestValue: val,
      priorValue: prior,
      pctChange: pctChangeFn(prior, val),
      absMax: Math.max(...nums.map(Math.abs)),
      formattedAmount: formatAmount(val),
      severity
    });
  }
  return txs;
}

// Tax: extract effective rate, deferred amounts, book-to-tax diffs
function extractTaxRows(rows) {
  const txs = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    const nums = row.slice(1).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const val   = nums[nums.length - 1];
    const prior = nums.length >= 2 ? nums[nums.length - 2] : null;
    const type  = classifyType(label) === 'Other' ? 'Tax' : classifyType(label);
    txs.push({
      label: `Tax: ${label}`,
      type,
      latestValue: val,
      priorValue: prior,
      pctChange: pctChangeFn(prior, val),
      absMax: Math.max(...nums.map(Math.abs)),
      formattedAmount: formatAmount(val),
      severity: heuristicSeverity({ label, type, pctChange: pctChangeFn(prior, val), absMax: Math.max(...nums.map(Math.abs)) })
    });
  }
  return txs;
}

// ─── GENERIC TABLE EXTRACTOR ──────────────────────────────────────────────────
function extractTransactionsFromTable(rows, docType) {
  if (!rows || !rows.length) return [];

  // Find header row
  let headerIdx = 0;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const row = rows[i];
    if (!row) continue;
    const nonNum = row.filter(c => isNaN(parseAmount(c)) && String(c || '').trim().length > 0).length;
    if (nonNum >= 2) { headerIdx = i; break; }
  }

  const headers   = (rows[headerIdx] || []).map(h => String(h || '').trim());
  const dataRows  = rows.slice(headerIdx + 1);

  // Find numeric columns
  const numericColIdxs = [];
  for (let ci = 1; ci < headers.length; ci++) {
    const vals = dataRows.map(r => parseAmount((r || [])[ci])).filter(v => v !== null);
    if (vals.length >= dataRows.length * 0.25) numericColIdxs.push(ci);
  }

  // Route to specialized extractors based on docType
  if (docType === 'Accounts Receivable') return extractARAgingRows(dataRows);
  if (docType === 'Payroll Tax' || docType === 'Employee Census') return extractPayrollRows(dataRows);
  if (docType === 'Debt Schedule') return extractDebtRows(dataRows);
  if (docType === 'EBITDA Adjustments') return extractEBITDARows(dataRows);
  if (docType === 'Tax Return' || docType === 'Book-to-Tax Reconciliation') return extractTaxRows(dataRows);

  // Generic extraction
  const transactions = [];
  for (const row of dataRows) {
    if (!row) continue;
    const label = String(row[0] || '').trim();
    if (!label || label.length < 2) continue;
    if (/^[-=_*]+$/.test(label)) continue;
    if (/^(total|subtotal|sum|grand total)/i.test(label) && label.length < 20) {
      // Keep totals but mark them
    }

    const vals    = numericColIdxs.map(ci => parseAmount(row[ci]));
    const numeric = vals.filter(v => v !== null);
    if (!numeric.length) continue;

    const latest  = numeric[numeric.length - 1];
    const prior   = numeric.length >= 2 ? numeric[numeric.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax  = Math.max(...numeric.map(Math.abs));
    const type    = classifyType(label);

    transactions.push({
      label,
      type,
      latestValue: latest,
      priorValue: prior,
      pctChange,
      absMax,
      formattedAmount: formatAmount(latest),
      periods: numericColIdxs.map((ci, i) => ({
        period: headers[ci] || `Period ${i + 1}`,
        value:  vals[i],
        formatted: formatAmount(vals[i])
      })),
      severity: heuristicSeverity({ label, type, pctChange, absMax, docType })
    });
  }
  return transactions;
}

// ─── PDF PARSER ───────────────────────────────────────────────────────────────
async function parsePDF(buffer, filename) {
  let text = '';
  try {
    const data = await pdfParse(buffer);
    text = data.text;
  } catch (e) {
    return { transactions: [], rawText: '', error: e.message };
  }

  const docType = detectDocType(filename || '', text);
  const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  // Try to reconstruct table rows from PDF lines
  // PDF text is flat — we look for lines with label + 1-4 numbers
  const linePattern = /^(.{3,80?}?)\s{2,}([-$()0-9,\.]+(?:\s{2,}[-$()0-9,\.]+)*)\s*$/;

  for (const line of lines) {
    if (line.length > 200) continue;
    const m = line.match(linePattern);
    if (!m) continue;

    const label = m[1].replace(/\.{3,}/g, '').trim();
    if (!label || label.length < 3) continue;
    if (/^(page|date|prepared|report|schedule|\d+)$/i.test(label)) continue;

    const numStrs = m[2].trim().split(/\s{2,}/);
    const nums    = numStrs.map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;

    const latest  = nums[nums.length - 1];
    const prior   = nums.length >= 2 ? nums[nums.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax  = Math.max(...nums.map(Math.abs));
    const type    = classifyType(label);

    transactions.push({
      label,
      type,
      latestValue: latest,
      priorValue: prior,
      pctChange,
      absMax,
      formattedAmount: formatAmount(latest),
      severity: heuristicSeverity({ label, type, pctChange, absMax, docType })
    });
  }

  return { transactions, rawText: text.slice(0, 10000), docType };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(buffer, filename) {
  const text   = buffer.toString('utf8');
  const docType = detectDocType(filename || '', text);
  let records;
  try {
    records = csvParse(text, { skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    try {
      records = csvParse(text, { delimiter: '\t', skip_empty_lines: true, trim: true, relax_column_count: true });
    } catch {
      return [];
    }
  }
  if (!records.length) return [];
  return extractTransactionsFromTable(records, docType);
}

// ─── XLSX PARSER ──────────────────────────────────────────────────────────────
function parseXLSX(buffer, filename) {
  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  let textSample = '';
  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    textSample += sheetName + ' ' + (data.slice(0, 5).flat().join(' '));
    rows.push(...data);
  }
  const docType = detectDocType(filename || '', textSample);
  return extractTransactionsFromTable(rows, docType);
}

// ─── TXT PARSER ───────────────────────────────────────────────────────────────
function parseTXT(buffer, filename) {
  const text   = buffer.toString('utf8');
  const docType = detectDocType(filename || '', text);
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Check if CSV-like
  const commaLines = lines.filter(l => l.includes(',')).length;
  if (commaLines > lines.length * 0.5) {
    return parseCSV(buffer, filename);
  }

  const transactions = [];
  const pattern = /^(.{3,80?}?)\s{2,}([-$()0-9,\.]+(?:\s+[-$()0-9,\.]+)*)\s*$/;
  for (const line of lines) {
    const m = line.match(pattern);
    if (!m) continue;
    const label = m[1].trim();
    if (!label) continue;
    const nums  = m[2].split(/\s+/).map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    const latest   = nums[nums.length - 1];
    const prior    = nums.length >= 2 ? nums[nums.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax   = Math.max(...nums.map(Math.abs));
    const type     = classifyType(label);
    transactions.push({
      label, type,
      latestValue: latest, priorValue: prior,
      pctChange, absMax,
      formattedAmount: formatAmount(latest),
      severity: heuristicSeverity({ label, type, pctChange, absMax, docType })
    });
  }
  return transactions;
}

// ─── AGGREGATE STATS ─────────────────────────────────────────────────────────
function computeStats(transactions) {
  const byType = {};
  for (const t of transactions) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }
  const redCount    = transactions.filter(t => t.severity === 'red').length;
  const yellowCount = transactions.filter(t => t.severity === 'yellow').length;
  const greenCount  = transactions.filter(t => t.severity === 'green').length;
  const topRed      = transactions.filter(t => t.severity === 'red').slice(0, 8);
  const topYellow   = transactions.filter(t => t.severity === 'yellow').slice(0, 8);
  const largestByAbs = [...transactions].sort((a, b) => (b.absMax || 0) - (a.absMax || 0)).slice(0, 10);
  return { byType, redCount, yellowCount, greenCount, topRed, topYellow, largestByAbs };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
async function parseFile(filename, buffer) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let transactions = [];
  let rawText      = '';
  let parseError   = null;
  let docType      = 'Financial Document';

  try {
    if (ext === 'pdf') {
      const result = await parsePDF(buffer, filename);
      transactions = result.transactions || [];
      rawText      = result.rawText      || '';
      parseError   = result.error        || null;
      docType      = result.docType      || docType;
    } else if (ext === 'csv') {
      transactions = parseCSV(buffer, filename);
      docType      = detectDocType(filename, buffer.toString('utf8').slice(0, 2000));
    } else if (['xlsx', 'xls'].includes(ext)) {
      transactions = parseXLSX(buffer, filename);
      docType      = detectDocType(filename, '');
    } else {
      transactions = parseTXT(buffer, filename);
      docType      = detectDocType(filename, buffer.toString('utf8').slice(0, 2000));
    }
  } catch (e) {
    parseError = e.message;
    transactions = [];
  }

  return { filename, docType, transactions, rawText, parseError, count: transactions.length };
}

module.exports = { parseFile, computeStats, formatAmount, detectDocType };
