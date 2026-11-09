/**
 * claude.js — The ONLY file that calls Claude.
 * Receives a pre-parsed, pre-classified summary from parser.js.
 * Claude's job: assign confidence scores + compute QoE score.
 * We minimize tokens by sending only a structured JSON summary, not raw files.
 */

const Anthropic = require('@anthropic-ai/sdk');

/**
 * Build a compact summary for Claude from parsed transactions.
 * This keeps the prompt small and focused.
 */
function buildClaudeSummary(parsedFiles) {
  const allTx = parsedFiles.flatMap(f => f.transactions);

  // Group by type for a compact overview
  const byType = {};
  for (const t of allTx) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  const typeOverview = Object.entries(byType).map(([type, items]) => ({
    type,
    count: items.length,
    items: items.slice(0, 8).map(t => ({
      label: t.label,
      latestValue: t.latestValue,
      priorValue: t.priorValue,
      pctChange: t.pctChange !== null ? Math.round(t.pctChange * 10) / 10 : null,
      formattedAmount: t.formattedAmount,
      heuristicSeverity: t.severity  // what the backend already determined
    }))
  }));

  const redItems    = allTx.filter(t => t.severity === 'red');
  const yellowItems = allTx.filter(t => t.severity === 'yellow');

  return {
    totalTransactions: allTx.length,
    files: parsedFiles.map(f => ({ name: f.filename, count: f.count, parseError: f.parseError })),
    typeOverview,
    flaggedItems: {
      red: redItems.slice(0, 10).map(t => ({ label: t.label, type: t.type, pctChange: t.pctChange, amount: t.formattedAmount })),
      yellow: yellowItems.slice(0, 10).map(t => ({ label: t.label, type: t.type, pctChange: t.pctChange, amount: t.formattedAmount }))
    },
    rawTextSnippets: parsedFiles.filter(f => f.rawText).map(f => ({
      file: f.filename,
      snippet: f.rawText.slice(0, 1500)
    }))
  };
}

/**
 * scoreWithClaude — sends a compact summary to Claude and gets back:
 *   - confidence scores per transaction
 *   - category scores
 *   - overall QoE score + grade
 *   - flags, narrative
 */
async function scoreWithClaude(parsedFiles, apiKey) {
  const client = new Anthropic({ apiKey });

  const summary = buildClaudeSummary(parsedFiles);
  const allTx   = parsedFiles.flatMap(f => f.transactions);

  const system = `You are a senior Quality of Earnings analyst. The backend has already parsed and pre-classified every line item from the financial documents. Your job is NOT to re-parse anything — the backend did that work. Your job is:

1. Assign a CONFIDENCE SCORE (0-100) to each pre-classified transaction, representing how certain you are that the backend's classification and severity are correct.
2. Compute an overall QoE SCORE (0-100) and GRADE based on the full picture.
3. Identify CATEGORY SCORES across 6 dimensions.
4. Write KEY FLAGS and an ANALYST NARRATIVE.

CONFIDENCE SCORING RULES:
- 90-100: Clear financial item, standard classification, well-supported
- 75-89: Likely correct, minor ambiguity
- 50-74: Moderate uncertainty — flag for human review (needsReview: true)
- 0-49: High uncertainty — flag for human review (needsReview: true)

Always set needsReview: true when confidence < 75, severity is "red", pctChange > 40%, or the item is unusual.

Respond ONLY with a valid JSON object — no markdown fences, no commentary, raw JSON only:

{
  "score": <0-100>,
  "grade": "<A+|A|A-|B+|B|B-|C+|C|C-|D|F>",
  "verdict": "<2-3 sentence executive summary>",
  "categories": [
    { "name": "<Revenue Quality|EBITDA Quality|Working Capital|Cash Conversion|Balance Sheet|Accounting Policies>", "score": <0-100>, "color": "<green|yellow|red>" }
  ],
  "flags": [
    { "severity": "<red|yellow|green>", "title": "<short>", "detail": "<1-2 sentences>" }
  ],
  "narrative": "<4-6 paragraph analyst narrative>",
  "methodology": "<2 paragraphs: what data was available, limitations, confidence in findings>",
  "transactions": [
    {
      "id": "<unique slug based on label>",
      "item": "<label from input>",
      "type": "<type from input>",
      "amount": "<formattedAmount from input>",
      "finding": "<what this item means for earnings quality>",
      "severity": "<green|yellow|red — confirm or override the backend's heuristic>",
      "confidence": <0-100>,
      "confidenceReasoning": "<1-2 sentences: why this confidence level>",
      "needsReview": <true|false>,
      "recommendation": "<specific action for the deal team>"
    }
  ]
}

The transactions array must include ALL items from the input. Use the item labels exactly as given.`;

  const userMessage = `Here is the pre-parsed financial summary from the backend. Assign confidence scores and compute the QoE report:

${JSON.stringify(summary, null, 2)}

Transaction list to score (${allTx.length} items):
${allTx.map((t, i) => `${i+1}. "${t.label}" | type:${t.type} | amount:${t.formattedAmount} | change:${t.pctChange !== null ? t.pctChange.toFixed(1)+'%' : 'n/a'} | heuristic:${t.severity}`).join('\n')}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userMessage }]
  });

  const raw = response.content?.find(b => b.type === 'text')?.text || '';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Claude returned invalid JSON');
  }

  // Usage stats for cost tracking
  const usage = {
    inputTokens:  response.usage?.input_tokens  || 0,
    outputTokens: response.usage?.output_tokens || 0,
    totalTokens:  (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
  };

  return { report: parsed, usage };
}

module.exports = { scoreWithClaude };
