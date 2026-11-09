/**
 * claude.js — The ONLY file that calls OpenAI.
 * Receives a pre-parsed, pre-classified summary from parser.js.
 * Claude scores ONLY based on what documents were actually uploaded.
 * Missing document types do NOT penalize the score.
 */

const OpenAI = require('openai');

// ─── All QoE document categories ─────────────────────────────────────────────
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

function buildClaudeSummary(parsedFiles) {
  const allTx = parsedFiles.flatMap(f => f.transactions);

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

  const uploadedDocTypes = [...new Set(parsedFiles.map(f => f.docType || 'Financial Document'))];
  const missingDocTypes  = ALL_DOC_CATEGORIES.filter(d => !uploadedDocTypes.includes(d) && d !== 'Financial Document');

  return {
    totalTransactions: allTx.length,
    uploadedDocTypes,
    missingDocTypes: missingDocTypes.slice(0, 20),
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

async function scoreWithClaude(parsedFiles, apiKey) {
  const client  = new OpenAI({ apiKey });
  const summary = buildClaudeSummary(parsedFiles);
  const allTxFull = parsedFiles.flatMap(f => f.transactions);

  // Deduplicate by label — prefer the most informative copy (most periods, lowest heuristic severity)
  const sevRank = { red: 0, yellow: 1, green: 2 };
  const txByLabel = new Map();
  for (const t of allTxFull) {
    const key = (t.label || '').toLowerCase().trim();
    const existing = txByLabel.get(key);
    if (!existing) { txByLabel.set(key, t); continue; }
    // Keep the one with more period data, or worse severity (more important)
    const tPeriods = (t.periods || []).filter(p => p.value !== null).length;
    const ePeriods = (existing.periods || []).filter(p => p.value !== null).length;
    if (sevRank[t.severity] < sevRank[existing.severity] || tPeriods > ePeriods) {
      txByLabel.set(key, t);
    }
  }
  const deduped = Array.from(txByLabel.values());

  // Prioritize: red first, then yellow, then green — cap at 200 for gpt-4o-mini context
  const red    = deduped.filter(t => t.severity === 'red');
  const yellow = deduped.filter(t => t.severity === 'yellow');
  const green  = deduped.filter(t => t.severity === 'green');
  const allTx  = [...red, ...yellow, ...green].slice(0, 200);

  const docContext = summary.uploadedDocTypes.map(d => {
    const qoeLink = DOC_TO_QOE_CATEGORY[d] || 'General';
    return `  • ${d} → informs: ${qoeLink}`;
  }).join('\n');

  const systemPrompt = `You are a senior Quality of Earnings (QoE) analyst at a Big Four transaction advisory firm.

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

If a category has NO uploaded data, omit it from the categories array.

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
  "narrative": "<4–6 paragraph analyst narrative>",
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

  // Compact stats block (avoids sending huge JSON.stringify(summary))
  const sheetInfo = parsedFiles[0]?.sheetSummary
    ? '\nSheets: ' + parsedFiles[0].sheetSummary
        .map(s => `${s.name}(${s.skipped ? 'skipped' : s.count + ' items'})`)
        .join(', ')
    : '';

  const userMessage = `Documents uploaded: ${summary.uploadedDocTypes.join(', ')}
Files: ${parsedFiles.map(f => `${f.filename}(${f.count} items)`).join(', ')}${sheetInfo}
Total unique line items being scored: ${allTx.length} (${allTxFull.length} total before dedup)
Heuristic breakdown: ${red.length} red, ${yellow.length} yellow, ${green.length} green

TRANSACTION LIST TO SCORE (${allTx.length} items):
${allTx.map((t, i) =>
  `${i + 1}. "${t.label}" | sheet:${t.sourceSheet || t.docType || '?'} | type:${t.type} | amount:${t.formattedAmount} | change:${t.pctChange !== null ? t.pctChange.toFixed(1) + '%' : 'n/a'} | heuristic:${t.severity}${t.meta ? ' | meta:' + JSON.stringify(t.meta) : ''}`
).join('\n')}`;

  const response = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  16000,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  }
    ]
  });

  const raw = response.choices?.[0]?.message?.content || '';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    // Try to extract the outermost JSON object
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        // JSON was cut off mid-transactions array — repair by closing it
        let attempt = m[0];
        // Close any open arrays/objects by counting brackets
        let opens = 0;
        for (const ch of attempt) {
          if (ch === '{' || ch === '[') opens++;
          else if (ch === '}' || ch === ']') opens--;
        }
        // Strip trailing incomplete item (find last complete object in transactions)
        const lastComplete = attempt.lastIndexOf('},\n');
        if (lastComplete > 0) attempt = attempt.slice(0, lastComplete + 1);
        // Close remaining open brackets
        const closes = [];
        let o2 = 0;
        for (const ch of attempt) {
          if (ch === '{') o2++;
          else if (ch === '[') closes.push(']');
          else if (ch === '}') { o2--; if (closes.length && closes[closes.length-1] === ']') {} }
          else if (ch === ']') closes.pop();
        }
        attempt += closes.reverse().join('') + (o2 > 0 ? '}'.repeat(o2) : '');
        try {
          parsed = JSON.parse(attempt);
        } catch {
          throw new Error('OpenAI returned invalid JSON that could not be repaired. Try uploading fewer files at once.');
        }
      }
    } else {
      throw new Error('OpenAI returned no JSON. Raw response: ' + raw.slice(0, 300));
    }
  }

  const usage = {
    inputTokens:  response.usage?.prompt_tokens     || 0,
    outputTokens: response.usage?.completion_tokens || 0,
    totalTokens:  response.usage?.total_tokens      || 0
  };

  return { report: parsed, usage };
}

module.exports = { scoreWithClaude };
