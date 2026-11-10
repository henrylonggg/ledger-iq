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

// Utility: check if a row is essentially blank
function isBlankRow(row) {
  if (!row || !row.length) return true;
  return row.every(c => c === null || c === undefined || String(c).trim() === '');
}

// Utility: count how many cells in a row are non-empty
function nonEmptyCount(row) {
  return (row || []).filter(c => c !== null && c !== undefined && String(c).trim() !== '').length;
}

// Utility: how many cells parse as a number
function numericCount(row) {
  return (row || []).filter(c => parseAmount(c) !== null && String(c).trim() !== '').length;
}

// Detect if a sheet is a "long" format table (each row is label/period/value)
function isLongFormat(rows) {
  if (!rows || rows.length < 3) return false;
  // Look for column headers that suggest long format
  const headerCandidates = rows.slice(0, 5).find(r => !isBlankRow(r));
  if (!headerCandidates) return false;
  const hdrs = headerCandidates.map(h => String(h || '').toLowerCase());
  const hasLabel = hdrs.some(h => /label|item|description|name|account/.test(h));
  const hasYear  = hdrs.some(h => /fiscal.?year|year|period|fy/.test(h));
  const hasValue = hdrs.some(h => /value|amount|balance/.test(h));
  return hasLabel && hasYear && hasValue;
}

// Parse long-format sheet (each row = one data point with period + value columns)
function extractLongFormat(rows) {
  const txs = [];
  if (!rows || rows.length < 2) return txs;

  // Find header row
  let headerRow = rows.find(r => !isBlankRow(r));
  if (!headerRow) return txs;
  const headers = headerRow.map(h => String(h || '').toLowerCase().trim());

  const labelCol = headers.findIndex(h => /label|item|description|name|account/.test(h));
  const yearCol  = headers.findIndex(h => /fiscal.?year|year/.test(h));
  const valCol   = headers.findIndex(h => /^value$|^amount$|^balance$/.test(h));
  if (labelCol < 0 || yearCol < 0 || valCol < 0) return txs;

  // Group by label, collect per-year values
  const byLabel = {};
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const label = String(row[labelCol] || '').trim();
    const year  = String(row[yearCol]  || '').trim();
    const val   = parseAmount(row[valCol]);
    if (!label || !year || val === null) continue;
    if (label === headers[labelCol]) continue; // header row
    if (!byLabel[label]) byLabel[label] = {};
    byLabel[label][year] = val;
  }

  for (const [label, yearMap] of Object.entries(byLabel)) {
    const years   = Object.keys(yearMap).sort();
    const nums    = years.map(y => yearMap[y]);
    if (!nums.length) continue;
    const latest  = nums[nums.length - 1];
    const prior   = nums.length >= 2 ? nums[nums.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax  = Math.max(...nums.map(Math.abs));
    const type    = classifyType(label);
    txs.push({
      label, type,
      latestValue: latest, priorValue: prior,
      pctChange, absMax,
      formattedAmount: formatAmount(latest),
      periods: years.map((y, i) => ({ period: y, value: nums[i], formatted: formatAmount(nums[i]) })),
      severity: heuristicSeverity({ label, type, pctChange, absMax })
    });
  }
  return txs;
}

// Find the best header row in a messy sheet (look up to 15 rows deep)
function findHeaderRow(rows, maxScan) {
  const limit = Math.min(maxScan || 15, rows.length);
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || isBlankRow(row)) continue;
    // Score: more non-numeric text cells = better header
    const textCells = row.filter(c => {
      const s = String(c || '').trim();
      return s.length > 0 && parseAmount(c) === null;
    }).length;
    // Penalise rows that look like metadata (URL, long sentences)
    const hasURL = row.some(c => /http|View |On EDGAR|Source:|©/i.test(String(c)));
    if (hasURL) continue;
    // Prefer rows that have period-like text in them (FY, year, 20xx, Q1)
    const hasPeriod = row.some(c => /FY\d{4}|20\d{2}|Q[1-4]/i.test(String(c || '')));
    const score = textCells + (hasPeriod ? 10 : 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx >= 0 ? bestIdx : 0;
}

// Find the label column (usually 0, but can be non-zero if there's an index/outline col)
function findLabelCol(headerRow, dataRows) {
  if (!headerRow) return 0;
  // Col 0 is label unless col 0 is entirely numeric
  const col0Header = String((headerRow || [])[0] || '').trim().toLowerCase();
  if (/line.?item|description|account|label|item|name/.test(col0Header)) return 0;
  // Check if col 0 data are all numeric (index column) — if so, use col 1
  const col0Nums = dataRows.slice(0, 10).filter(r => r && parseAmount(r[0]) !== null).length;
  const col0Pop  = dataRows.slice(0, 10).filter(r => r && String(r[0] || '').trim()).length;
  if (col0Pop > 3 && col0Nums / col0Pop > 0.7) return 1;
  return 0;
}

function extractTransactionsFromTable(rows, docType) {
  if (!rows || !rows.length) return [];

  // Long-format detection
  if (isLongFormat(rows)) return extractLongFormat(rows);

  // Find header row (look up to 15 rows into the sheet)
  const headerIdx = findHeaderRow(rows, 15);
  const headers   = (rows[headerIdx] || []).map(h => String(h || '').trim());
  const dataRows  = rows.slice(headerIdx + 1).filter(r => r && nonEmptyCount(r) > 0);

  const labelCol  = findLabelCol(rows[headerIdx], dataRows);

  // Find numeric columns: allow sparse data (10% threshold instead of 25%)
  const numericColIdxs = [];
  for (let ci = 0; ci < headers.length; ci++) {
    if (ci === labelCol) continue;
    const vals = dataRows.map(r => parseAmount((r || [])[ci])).filter(v => v !== null);
    if (vals.length >= Math.max(2, dataRows.length * 0.10)) numericColIdxs.push(ci);
  }

  // Route to specialized extractors based on docType
  if (docType === 'Accounts Receivable') return extractARAgingRows(dataRows);
  if (docType === 'Payroll Tax' || docType === 'Employee Census') return extractPayrollRows(dataRows);
  if (docType === 'Debt Schedule') return extractDebtRows(dataRows);
  if (docType === 'EBITDA Adjustments') return extractEBITDARows(dataRows);
  if (docType === 'Tax Return' || docType === 'Book-to-Tax Reconciliation') return extractTaxRows(dataRows);

  // Generic extraction
  const transactions = [];
  let currentSection = ''; // track mid-sheet section headers

  for (const row of dataRows) {
    if (!row) continue;
    const rawLabel = String(row[labelCol] || '').trim();
    if (!rawLabel || rawLabel.length < 2) continue;
    if (/^[-=_*\/]{3,}$/.test(rawLabel)) continue;
    // Skip obvious metadata rows
    if (/^(page\s*\d|prepared by|report date|source:|on edgar|view |http)/i.test(rawLabel)) continue;

    const vals    = numericColIdxs.map(ci => parseAmount(row[ci]));
    const numeric = vals.filter(v => v !== null);

    // If this row has no numbers, it may be a section header — track for context
    if (!numeric.length) {
      if (rawLabel.length > 2 && rawLabel.length < 80) currentSection = rawLabel;
      continue;
    }

    // Build contextual label: prepend section if it's not already in the label
    const label = (currentSection && !rawLabel.toLowerCase().includes(currentSection.toLowerCase().slice(0, 10)))
      ? rawLabel
      : rawLabel;

    const latest  = numeric[numeric.length - 1];
    const prior   = numeric.length >= 2 ? numeric[numeric.length - 2] : null;
    const pctChange = pctChangeFn(prior, latest);
    const absMax  = Math.max(...numeric.map(Math.abs));
    const type    = classifyType(label);

    transactions.push({
      label,
      type,
      section: currentSection || undefined,
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

  // Try to reconstruct table rows from PDF lines.
  // PDF text is flat — we look for lines with label + 1-N numbers.
  // Pattern 1: label then numbers separated by 2+ spaces (most common)
  // Pattern 2: leader dots "..........." before numbers
  // Pattern 3: indented label (leading spaces) — still valid
  const linePattern = /^(.{2,80?}?)(?:\.{3,}|\s{2,})([-$()0-9,\.]+(?:(?:\s{1,4}|\s*,\s*)[-$()0-9,\.]+)*)\s*$/;

  for (const line of lines) {
    if (line.length > 300) continue;
    // Strip common PDF artifacts: page numbers, URLs, section breaks
    if (/^[=\-_]{5,}$/.test(line)) continue;
    if (/^(page\s*\d|www\.|http|\d{1,3}$)/i.test(line)) continue;

    const m = line.match(linePattern);
    if (!m) continue;

    const label = m[1].replace(/\.{3,}/g, '').replace(/^\s+/, '').trim();
    if (!label || label.length < 3) continue;
    if (/^(page|date|prepared|report|schedule)$/i.test(label)) continue;
    // Skip pure-number "labels" (e.g. row indices)
    if (/^\d+$/.test(label)) continue;

    // Parse numbers — allow single-space separation between adjacent numbers
    const numStrs = m[2].trim().split(/\s{2,}|\s*,\s*/);
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

// Sheets to skip — metadata, checks, aliases, instructions
const SKIP_SHEET_PATTERNS = [
  /read.?me|instructions?|notes?|cover|about/i,
  /master.?check|check.?sheet|reconcil.*check/i,
  /tag.?alias|xbrl|taxonomy/i,
  /template|example|sample/i,
  /^\s*sheet\d+\s*$/i,
];

function shouldSkipSheet(name, rows) {
  // Name-based skip
  if (SKIP_SHEET_PATTERNS.some(p => p.test(name))) return true;
  // Skip tiny sheets (< 3 rows with data)
  const datRows = (rows || []).filter(r => !isBlankRow(r));
  if (datRows.length < 3) return true;
  // Skip sheets that have no numeric data at all
  const totalNums = datRows.reduce((s, r) => s + numericCount(r), 0);
  if (totalNums === 0) return true;
  return false;
}

function parseXLSX(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const allTransactions = [];

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (shouldSkipSheet(sheetName, data)) continue;

    // Detect doc type per-sheet using sheet name + first content rows
    const contentSample = sheetName + ' ' + data.slice(0, 10).flat()
      .map(c => String(c || ''))
      .filter(s => s.length > 0 && s.length < 100)
      .join(' ');
    const docType = detectDocType(filename + ' ' + sheetName, contentSample);

    const txs = extractTransactionsFromTable(data, docType);

    // Tag each transaction with its source sheet
    for (const tx of txs) {
      tx.sourceSheet = sheetName;
      if (!tx.docType) tx.docType = docType;
    }

    allTransactions.push(...txs);
  }

  return allTransactions;
}

// Also export a multi-sheet version that returns per-sheet results (for server.js logging)
function parseXLSXDetailed(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheets = [];

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (shouldSkipSheet(sheetName, data)) {
      sheets.push({ sheetName, skipped: true, transactions: [] });
      continue;
    }

    const contentSample = sheetName + ' ' + data.slice(0, 10).flat()
      .map(c => String(c || ''))
      .filter(s => s.length > 0 && s.length < 100)
      .join(' ');
    const docType = detectDocType(filename + ' ' + sheetName, contentSample);
    const txs = extractTransactionsFromTable(data, docType);
    for (const tx of txs) { tx.sourceSheet = sheetName; tx.docType = docType; }

    sheets.push({ sheetName, docType, transactions: txs, count: txs.length });
  }

  return sheets;
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
      const sheets = parseXLSXDetailed(buffer, filename);
      transactions = sheets.flatMap(s => s.transactions || []);
      // Pick the most representative sheet's docType
      const primary = sheets.find(s => !s.skipped && s.count > 0);
      docType = (primary && primary.docType) || detectDocType(filename, '');
      // Attach sheet summary to result
      parseError = null;
      return {
        filename, docType, transactions,
        rawText: '',
        sheetSummary: sheets.map(s => ({
          name: s.sheetName,
          skipped: s.skipped || false,
          docType: s.docType,
          count: s.count || 0
        })),
        parseError: null,
        count: transactions.length
      };
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

// ─── AI FALLBACK EXTRACTOR ───────────────────────────────────────────────────
// Called by server.js when structured parsing yields too few results.
// apiKey is passed in (never stored here) so the key stays server-side only.

async function extractWithAI(filename, buffer, ext, apiKey) {
  if (!apiKey) return { transactions: [], tokensUsed: 0, aiUsed: false };

  // Convert file to readable text
  let rawText = '';
  try {
    if (ext === 'pdf') {
      const data = await pdfParse(buffer);
      rawText = data.text || '';
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const name of wb.SheetNames.slice(0, 10)) {
        const ws   = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        parts.push(`=== Sheet: ${name} ===`);
        parts.push(rows.slice(0, 300).map(r => r.join('\t')).join('\n'));
      }
      rawText = parts.join('\n\n');
    } else if (ext === 'csv') {
      rawText = buffer.toString('utf8');
    } else {
      rawText = buffer.toString('utf8');
    }
  } catch (e) {
    return { transactions: [], tokensUsed: 0, aiUsed: false, error: e.message };
  }

  // Truncate to stay within token budget (~60k chars ≈ 15k tokens)
  const truncated = rawText.slice(0, 60000);
  const docType   = detectDocType(filename, truncated.slice(0, 3000));

  const systemPrompt = `You are a financial data extraction expert for M&A Quality of Earnings analysis.
Extract ALL financial line items from the document. Return a JSON object with an "items" array.

Each item in the array must follow this exact shape:
{
  "label": "string — the line item name exactly as it appears (include section context, e.g. 'Revenue: Product Sales')",
  "latestValue": number or null,
  "priorValue": number or null,
  "type": "one of: Revenue | EBITDA Adj | COGS & Margin | SG&A | Payroll | Owner Compensation | Non-Recurring | Related Party | Accounts Receivable | Accounts Payable | Inventory | Debt & Leverage | Tax | Cash & Bank | CapEx & Fixed Assets | D&A | Working Capital | Revenue Recognition | Backlog & Pipeline | Prepaids & Accruals | Contractors | Other",
  "note": "optional brief note about significance for QoE"
}

CRITICAL RULES:
- The document may be messy, poorly formatted, or use non-standard layouts — extract everything anyway
- latestValue and priorValue are plain numbers only (no $ signs, no commas). Negative numbers = losses/expenses shown in parentheses
- For percentages (margins, rates), store as the percentage number (e.g. 42.5 for 42.5%)
- If only one time period exists, set priorValue to null
- Extract EVERY row that has at least one dollar amount, count, or percentage — even small items matter
- For multi-period data (e.g. FY2022, FY2023), use FY2023 as latestValue and FY2022 as priorValue
- Never skip rows due to formatting — if you can read a number, include it
- If the document has no financial data at all, return {"items": []}
- Always return JSON with an "items" key`;

  const userPrompt = `File: ${filename}
Document type detected: ${docType}

RAW CONTENT:
${truncated}

Extract all financial line items as a JSON array.`;

  try {
    const { createCompletion } = require('./openai-client');
    const completion = await createCompletion(apiKey, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }, { label: 'extract' });

    const tokensUsed = completion.usage?.total_tokens || 0;
    let items = [];
    try {
      const parsed = JSON.parse(completion.choices[0].message.content);
      // Accept { items: [...] } or { transactions: [...] } or bare array
      if (Array.isArray(parsed))             items = parsed;
      else if (Array.isArray(parsed.items))  items = parsed.items;
      else if (Array.isArray(parsed.transactions)) items = parsed.transactions;
      else {
        // Try first array-valued key
        const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
        if (arrKey) items = parsed[arrKey];
      }
    } catch { items = []; }

    // Map to standard transaction format
    const transactions = items
      .filter(it => it && it.label && it.label.trim().length > 0)  // keep everything with a label, including zeros and null values
      .map(it => {
        const latestValue  = typeof it.latestValue === 'number' ? it.latestValue : parseAmount(it.latestValue);
        const priorValue   = typeof it.priorValue  === 'number' ? it.priorValue  : parseAmount(it.priorValue);
        const pctChange    = pctChangeFn(priorValue, latestValue);
        const absMax       = Math.max(Math.abs(latestValue || 0), Math.abs(priorValue || 0));
        const type         = it.type && it.type !== 'Other' ? it.type : classifyType(it.label);
        return {
          label:          String(it.label).trim(),
          type,
          latestValue,
          priorValue,
          pctChange,
          absMax,
          formattedAmount: formatAmount(latestValue),
          severity: heuristicSeverity({ label: it.label, type, pctChange, absMax }),
          aiExtracted:    true,
          note:           it.note || undefined,
          docType,
        };
      });

    return { transactions, tokensUsed, aiUsed: true, docType };
  } catch (err) {
    return { transactions: [], tokensUsed: 0, aiUsed: false, error: err.message };
  }
}

module.exports = { parseFile, computeStats, formatAmount, detectDocType, parseXLSXDetailed, extractWithAI };
