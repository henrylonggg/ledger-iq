/**
 * claude.js — The ONLY file that calls Claude.
 * Receives a pre-parsed, pre-classified summary from parser.js.
 * Claude scores ONLY based on what documents were actually uploaded.
 * Missing document types do NOT penalize the score.
 */

const Anthropic = require('@anthropic-ai/sdk');

// ─── All QoE document categories Claude understands ──────────────────────────
const ALL_DOC_CATEGORIES = [
  'Income Statement', 'Balance Sheet', 'Cash Flow Statement',
  'General Ledger', 'Trial Balance', 'Audited Financials',
  'Chart of Accounts', 'Tax Return', 'Book-to-Tax Reconciliation',
  'Sales & Use Tax', 'Payroll Tax', 'Tax Audit Records',
  'Revenue Recognition', 'Customer Contracts', 'Backlog & Pipeline',
  'Accounts Receivable', 'Accounts Payable', 'Inventory',
  'Prepaids & Accruals', 'Bank Statement', 'EBITDA Adjustments',
  'Owner Compensation', 'Related Party Transactions', 'Non-Recurring Items',
  'Employee Census', 'Contractor Roster', 'Debt Schedule',
  'CapEx & Fixed Assets', 'Monthly Financials', 'Financial Document'
];

// Map doc types to QoE categories for the prompt context
const DOC_TO_QOE_CATEGORY = {
  'Income Statement':          'Revenue Quality, EBITDA Quality',
  'Monthly Financials':        'Revenue Quality, EBITDA Quality',
  'General Ledger':            'Revenue Quality, EBITDA Quality, Accounting Quality',
  'Trial Balance':             'Revenue Quality, EBITDA Quality, Balance Sheet',
  'Audited Financials':        'All categories — high reliability signal',
  'Revenue Recognition':       'Revenue Quality',
  'Customer Contracts':        'Revenue Quality, Backlog & Pipeline',
  'Backlog & Pipeline':        'Revenue Quality, Working Capital',
  'Accounts Receivable':       'Working Capital, Cash Conversion',
  'Accounts Payable':          'Working Capital, Cash Conversion',
  'Inventory':                 'Working Capital, Balance Sheet',
  'Bank Statement':            'Cash Conversion, Cash Quality',
  'EBITDA Adjustments':        'EBITDA Quality',
  'Owner Compensation':        'EBITDA Quality, Normalization',
  'Related Party Transactions':'EBITDA Quality, Accounting Quality',
  'Non-Recurring Items':       'EBITDA Quality, Normalization',
  'Tax Return':                'Tax Quality, Accounting Quality',
  'Book-to-Tax Reconciliation':'Tax Quality, Accounting Quality',
  'Payroll Tax':               'EBITDA Quality, Working Capital',
  'Employee Census':           'EBITDA Quality',
  'Contractor Roster':         'EBITDA Quality',
  'Debt Schedule':             'Balance Sheet, Leverage',
  'CapEx & Fixed Assets':      'Balance Sheet, CapEx Quality',
  'Prepaids & Accruals':       'Balance Sheet, Accounting Quality',
  'Balance Sheet':             'Balance Sheet, Working Capital',
  'Cash Flow Statement':       'Cash Conversion',
  'Chart of Accounts':         'Accounting Quality',
  'Sales & Use Tax':           'Tax Quality',
  'Tax Audit Records':         'Tax Quality',
};

/**
 * Build a compact summary for Claude from parsed files.
 * Includes what documents WERE uploaded so Claude can calibrate its analysis.
 */
function buildClaudeSummary(parsedFiles) {
  const allTx = parsedFiles.flatMap(f => f.transactions);

  // Group transactions by type
  const byType = {};
  for (const t of allTx) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  const typeOverview = Object.entries(byType).map(([type, items]) => ({
    type,
    count: items.length,
    items: items.slice(0, 10).map(t => ({
      label:             t.label,
      latestValue:       t.latestValue,
      priorValue:        t.priorValue,
      pctChange:         t.pctChange !== null ? Math.round(t.pctChange * 10) / 10 : null,
      formattedAmount:   t.formattedAmount,
      heuristicSeverity: t.severity,
      meta:              t.meta || undefined
    }))
  }));

  const redItems    = allTx.filter(t => t.severity === 'red');
  const yellowItems = allTx.filter(t => t.severity === 'yellow');

  // Which doc types were uploaded
  const uploadedDocTypes = [...new Set(parsedFiles.map(f => f.docType || 'Financial Document'))];
  const missingDocTypes  = ALL_DOC_CATEGORIES.filter(d => !uploadedDocTypes.includes(d) && d !== 'Financial Document');

  return {
    totalTransactions: allTx.length,
    uploadedDocTypes,
    missingDocTypes: missingDocTypes.slice(0, 20), // just for context, not for penalization
    files: parsedFiles.map(f => ({
      name:       f.filename,
      docType:    f.docType || 'Financial Document',
      count:      f.count,
      parseError: f.parseError || null
    })),
    typeOverview,
    flaggedItems: {
      red:    redItems.slice(0, 15).map(t => ({ label: t.label, type: t.type, pctChange: t.pctChange, amount: t.formattedAmount, meta: t.meta })),
      yellow: yellowItems.slice(0, 15).map(t => ({ label: t.label, type: t.type, pctChange: t.pctChange, amount: t.formattedAmount, meta: t.meta }))
    },
    rawTextSnippets: parsedFiles
      .filter(f => f.rawText && f.rawText.length > 100)
      .slice(0, 5)
      .map(f => ({ file: f.filename, docType: f.docType, snippet: f.rawText.slice(0, 2000) }))
  };
}

/**
 * scoreWithClaude — sends compact summary, gets back full QoE report.
 * Score is RELATIVE to documents provided — no penalty for missing files.
 */
async function scoreWithClaude(parsedFiles, apiKey) {
  const client  = new Anthropic({ apiKey });
  const summary = buildClaudeSummary(parsedFiles);
  const allTx   = parsedFiles.flatMap(f => f.transactions);

  // Build the available-data context string for the prompt
  const docContext = summary.uploadedDocTypes.map(d => {
    const qoeLink = DOC_TO_QOE_CATEGORY[d] || 'General';
    return `  • ${d} → informs: ${qoeLink}`;
  }).join('\n');

  const system = `You are a senior Quality of Earnings (QoE) analyst at a Big Four transaction advisory firm.

The backend has parsed and pre-classified every line item from the uploaded financial documents. You do NOT re-parse anything.

YOUR JOBS:
1. Assign a CONFIDENCE SCORE (0–100) to each pre-classified transaction
2. Compute a QoE SCORE (0–100) and LETTER GRADE based ONLY on the data provided
3. Score each of the 6 QoE categories (only those for which data exists)
4. Write KEY FLAGS and an ANALYST NARRATIVE

═══ CRITICAL SCORING RULE ═══
Score ONLY based on what was uploaded. If documents are missing, that is NOT a negative — it simply means those dimensions cannot be evaluated. Adjust your confidence in categories accordingly, but do NOT lower the score for missing data. The score reflects the quality of what IS available.

═══ DOCUMENT COVERAGE ═══
The following document types were uploaded:
${docContext}

═══ CONFIDENCE SCORING RULES ═══
90–100: Clear financial item, well-supported, standard classification
75–89:  Likely correct, minor ambiguity
50–74:  Moderate uncertainty → set needsReview: true
0–49:   High uncertainty, unusual item → set needsReview: true

Always set needsReview: true when:
- confidence < 75
- severity is "red"
- pctChange > 40%
- item is a related party transaction, owner comp, non-recurring, or one-time

═══ QoE CATEGORY SCORING ═══
Score only categories for which uploaded documents provide evidence:
- Revenue Quality: income statements, revenue schedules, customer contracts, backlog
- EBITDA Quality: P&L, EBITDA adjustments, owner comp, non-recurring items
- Working Capital: AR aging, AP aging, inventory, prepaids/accruals
- Cash Conversion: cash flow statements, bank statements, proof of cash
- Balance Sheet: balance sheets, debt schedules, fixed assets
- Accounting Quality: audited financials, general ledger, trial balance, tax returns

If a category has NO uploaded data, omit it from the categories array — do NOT score it 50 or guess.

═══ RESPONSE FORMAT ═══
Respond ONLY with valid JSON — no markdown fences, no commentary:

{
  "score": <0–100>,
  "grade": "<A+|A|A-|B+|B|B-|C+|C|C-|D|F>",
  "verdict": "<2–3 sentence executive summary noting what data was available>",
  "dataScope": "<1 sentence: which document types formed the basis of this analysis>",
  "categories": [
    { "name": "<category name>", "score": <0–100>, "color": "<green|yellow|red>", "basis": "<which doc types informed this score>" }
  ],
  "flags": [
    { "severity": "<red|yellow|green>", "title": "<short title>", "detail": "<1–2 sentences>" }
  ],
  "narrative": "<4–6 paragraph analyst narrative — be specific about what documents were reviewed and what they revealed>",
  "methodology": "<2 paragraphs: document types reviewed, what could and could not be evaluated, confidence in findings>",
  "transactions": [
    {
      "id": "<slug>",
      "item": "<label from input — exact match>",
      "type": "<type from input>",
      "amount": "<formattedAmount>",
      "finding": "<what this means for earnings quality>",
      "severity": "<green|yellow|red>",
      "confidence": <0–100>,
      "confidenceReasoning": "<1–2 sentences>",
      "needsReview": <true|false>,
      "recommendation": "<specific action for the deal team>"
    }
  ]
}

Include ALL transactions from the input list. Use labels exactly as given.`;

  const userMessage = `Documents uploaded: ${summary.uploadedDocTypes.join(', ')}
Total line items: ${allTx.length}

FULL SUMMARY:
${JSON.stringify(summary, null, 2)}

TRANSACTION LIST TO SCORE (${allTx.length} items):
${allTx.map((t, i) =>
  `${i + 1}. "${t.label}" | type:${t.type} | amount:${t.formattedAmount} | change:${t.pctChange !== null ? t.pctChange.toFixed(1) + '%' : 'n/a'} | heuristic:${t.severity}${t.meta ? ' | meta:' + JSON.stringify(t.meta) : ''}`
).join('\n')}`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8000,
    system,
    messages:   [{ role: 'user', content: userMessage }]
  });

  const raw = response.content?.find(b => b.type === 'text')?.text || '';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Claude returned invalid JSON — raw: ' + raw.slice(0, 300));
  }

  const usage = {
    inputTokens:  response.usage?.input_tokens  || 0,
    outputTokens: response.usage?.output_tokens || 0,
    totalTokens:  (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
  };

  return { report: parsed, usage };
}

module.exports = { scoreWithClaude };
