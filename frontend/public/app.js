// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
const API_BASE = 'https://ledger-iq-oi3l.onrender.com';

// ═══════════════════════════════════
// STATE
// ═══════════════════════════════════
let files      = [];
let report     = null;
let reviewSt   = {};
let filterMode = 'all';

// ═══════════════════════════════════
// NAV
// ═══════════════════════════════════
const titles = {
  upload:'Upload', dashboard:'Dashboard',
  review:'Review Queue', transactions:'Transactions', narrative:'Narrative'
};
function go(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const nb = document.getElementById('nb-' + page);
  if (nb) nb.classList.add('active');
  document.getElementById('tb-title').textContent = titles[page] || page;
  const hasR = !!report;
  document.getElementById('btn-export').style.display = hasR ? '' : 'none';
  document.getElementById('btn-reset').style.display  = hasR ? '' : 'none';
}

// ═══════════════════════════════════
// API KEY — handled server-side only
// ═══════════════════════════════════
function checkKey() { updateBtn(); }

// ═══════════════════════════════════
// FILES
// ═══════════════════════════════════

function addFiles(list) {
  for (const f of list) if (!files.find(x => x.name === f.name)) files.push(f);
  renderFiles(); updateBtn();
}
function removeFile(name) { files = files.filter(f => f.name !== name); renderFiles(); updateBtn(); }

function renderFiles() {
  document.getElementById('file-list').innerHTML = files.map(f => {
    const ext = f.name.split('.').pop().toUpperCase();
    return `<div class="file-row">
      <span class="file-ext">${esc(ext)}</span>
      <span class="file-name">${esc(f.name)}</span>
      <span class="file-size">${sz(f.size)}</span>
      <button class="file-del" onclick="removeFile('${esc(f.name)}')" title="Remove">✕</button>
    </div>`;
  }).join('');
}
function sz(b) { return b < 1024 ? b + 'B' : b < 1048576 ? (b/1024).toFixed(1) + 'KB' : (b/1048576).toFixed(1) + 'MB'; }

function updateBtn() {
  const btn = document.getElementById('analyze-btn');
  const txt = document.getElementById('analyze-txt');
  const hasFiles = files.length > 0;
  btn.disabled = !hasFiles;
  txt.textContent = !hasFiles ? 'Add files to begin'
    : `Analyze ${files.length} file${files.length > 1 ? 's' : ''}`;
}

// ═══════════════════════════════════
// PROGRESS
// ═══════════════════════════════════
function setProg(pct, title, sub) {
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-pct').textContent  = Math.round(pct) + '%';
  if (title) document.getElementById('prog-title').textContent = title;
  if (sub)   document.getElementById('prog-sub').textContent   = sub;
}
function addLog(msg, type = 'info') {
  const box = document.getElementById('log-box');
  const el  = document.createElement('span');
  el.className = 'll ' + type;
  const ts = new Date().toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  el.textContent = `[${ts}]  ${msg}`;
  box.appendChild(el);
  box.appendChild(document.createElement('br'));
  box.scrollTop = box.scrollHeight;
}

// ═══════════════════════════════════
// ANALYSIS  — SSE stream from backend
// ═══════════════════════════════════

// Shared SSE reader — handles progress/log/result/error/done events
async function readSSEStream(resp, onDone) {
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop();

    for (const raw of events) {
      if (!raw.trim()) continue;
      const lines = raw.split('\n');
      let evName = 'message', evData = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) evName = l.slice(7).trim();
        if (l.startsWith('data: '))  evData = l.slice(6).trim();
      }
      if (!evData) continue;
      let d; try { d = JSON.parse(evData); } catch { continue; }

      if (evName === 'progress') setProg(d.pct, d.message);
      if (evName === 'log')      addLog(d.message, d.type || 'info');
      if (evName === 'result')   report = d.report;
      if (evName === 'error')    throw new Error(d.message);
      if (evName === 'done') {
        addLog('Report ready.', 'ok');
        await new Promise(r => setTimeout(r, 400));
        if (onDone) onDone();
      }
    }
  }
}

function showProgressPage() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-progress').classList.add('active');
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  document.getElementById('tb-title').textContent = 'Analyzing…';
  document.getElementById('log-box').innerHTML = '';
  setProg(0, 'Starting analysis…', 'Connecting to backend');
}

async function startAnalysis() {
  if (!files.length) return;

  showProgressPage();
  addLog('Connecting to backend…', 'info');

  try {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);

    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      body: fd
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    await readSSEStream(resp, finishReport);

  } catch (err) {
    addLog('Error: ' + err.message, 'err');
    setProg(0, 'Analysis failed', err.message);
    const b = document.createElement('button');
    b.className = 'btn btn-ghost'; b.style.marginTop = '16px';
    b.textContent = 'Back'; b.onclick = () => go('upload');
    document.getElementById('page-progress').appendChild(b);
  }
}

// ═══════════════════════════════════
// DEMO — silent background refresh
// ═══════════════════════════════════
async function refreshDemoInBackground() {
  // Silently fetch a fresh real GPT-4o result without touching the UI
  try {
    const resp = await fetch(`${API_BASE}/api/demo`);
    if (!resp.ok) return;

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';
    let   freshReport = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const raw of events) {
        const lines = raw.split('\n');
        let evName = '', evData = '';
        for (const l of lines) {
          if (l.startsWith('event: ')) evName = l.slice(7).trim();
          if (l.startsWith('data: '))  evData = l.slice(6).trim();
        }
        if (evName === 'result' && evData) {
          try { freshReport = JSON.parse(evData).report; } catch {}
        }
        if (evName === 'done' && freshReport) {
          // Update cache with real result; re-render if still on dashboard
          try { localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ ts: Date.now(), data: freshReport })); } catch {}
          if (document.getElementById('page-dashboard').classList.contains('active')) {
            report = freshReport;
            finishReport();
          }
        }
      }
    }
  } catch { /* silent — hardcoded demo stays */ }
}

// ═══════════════════════════════════
// RENDER
// ═══════════════════════════════════
function finishReport() {
  if (!report) return;
  const r = report;

  reviewSt = {};
  (r.transactions || []).forEach(t => { if (t.needsReview) reviewSt[t.id] = 'pending'; });

  const score   = Math.max(0, Math.min(100, r.score || 0));
  const pending = Object.values(reviewSt).filter(s => s === 'pending').length;
  const redCt   = (r.flags || []).filter(f => f.severity === 'red').length;
  const avgConf = r.transactions?.length
    ? Math.round(r.transactions.reduce((s, t) => s + (t.confidence || 0), 0) / r.transactions.length) : 0;

  // KPIs
  document.getElementById('k-score').textContent = score;
  document.getElementById('k-grade').textContent = r.grade || '—';
  const confEl = document.getElementById('k-conf');
  confEl.textContent = avgConf + '%';
  confEl.style.color = avgConf >= 75 ? 'var(--emerald)' : avgConf >= 50 ? 'var(--amber)' : 'var(--crimson)';
  document.getElementById('k-queue').textContent = pending;
  document.getElementById('k-flags').textContent = redCt;

  // Ring arc
  document.getElementById('ring-num').textContent = score;
  const arc = document.getElementById('score-arc');
  arc.style.stroke = score >= 70 ? 'var(--emerald)' : score >= 45 ? 'var(--amber)' : 'var(--crimson)';
  setTimeout(() => { arc.style.strokeDashoffset = 201 - (score / 100) * 201; }, 200);

  // Grade color
  const g = r.grade || '';
  document.getElementById('k-score').style.color = g.startsWith('A') ? 'var(--emerald)' : g.startsWith('B') ? 'var(--teal)' : g.startsWith('C') ? 'var(--amber)' : 'var(--crimson)';

  // Categories
  document.getElementById('cat-stack').innerHTML = (r.categories || []).map(c => {
    const col = c.color === 'green' ? 'var(--emerald)' : c.color === 'red' ? 'var(--crimson)' : 'var(--amber)';
    return `<div class="cat-row">
      <span class="cat-name">${esc(c.name)}</span>
      <div class="cat-track"><div class="cat-fill" style="width:${c.score||0}%;background:${col}"></div></div>
      <span class="cat-num" style="color:${col}">${c.score || 0}</span>
    </div>`;
  }).join('');

  // Flags
  document.getElementById('flags-box').innerHTML = (r.flags || []).map(f => `
    <div class="flag ${f.severity || 'yellow'}">
      <div><span class="flag-title">${esc(f.title || '')}</span><span class="flag-detail">${esc(f.detail || '')}</span></div>
    </div>`).join('');

  // Data scope banner
  if (r.dataScope) {
    document.getElementById('dash-narrative').innerHTML =
      `<p style="font-family:var(--mono);font-size:10.5px;color:var(--teal);margin-bottom:10px;border-left:2px solid var(--teal);padding-left:8px">${esc(r.dataScope)}</p>`;
  }

  // Narrative
  const nHtml = (r.narrative || '').split('\n\n').map(p => `<p>${esc(p)}</p>`).join('');
  document.getElementById('dash-narrative').innerHTML += nHtml;
  document.getElementById('narrative-full').innerHTML = nHtml;
  document.getElementById('methodology').innerHTML   = (r.methodology || '').split('\n\n').map(p => `<p>${esc(p)}</p>`).join('');

  // Token usage
  if (r._meta?.tokenUsage) {
    const u = r._meta.tokenUsage;
    document.getElementById('tok-in').textContent    = u.inputTokens?.toLocaleString();
    document.getElementById('tok-out').textContent   = u.outputTokens?.toLocaleString();
    document.getElementById('tok-total').textContent = u.totalTokens?.toLocaleString();
    document.getElementById('tok-files').textContent = r._meta.filesProcessed;
    document.getElementById('tok-tx').textContent    = r._meta.totalTransactions;
    document.getElementById('token-strip-wrap').style.display = '';
  }

  renderReview();
  renderTxTable();

  document.getElementById('rev-badge').textContent  = pending;
  document.getElementById('rev-badge').className    = 'nb-badge' + (pending > 0 ? ' on' : '');
  document.getElementById('tb-meta').textContent    = `score ${score}/100 · ${(r.transactions||[]).length} items · ${pending} pending`;

  go('dashboard');
}

// ═══════════════════════════════════
// REVIEW QUEUE
// ═══════════════════════════════════
function renderReview() {
  if (!report) return;
  const items = (report.transactions || []).filter(t => t.needsReview);
  const wrap  = document.getElementById('rv-cards');

  if (!items.length) {
    wrap.innerHTML = `<div class="empty"><span class="empty-ico">✓</span><h3>Nothing to review</h3>All items had high confidence.</div>`;
    return;
  }

  const shown = filterMode === 'all' ? items : items.filter(t => (reviewSt[t.id] || 'pending') === filterMode);
  if (!shown.length) {
    wrap.innerHTML = `<div class="empty"><span class="empty-ico">○</span><h3>No items match filter</h3></div>`;
    return;
  }

  wrap.innerHTML = shown.map(t => {
    const st   = reviewSt[t.id] || 'pending';
    const conf = t.confidence || 0;
    const cc   = conf >= 75 ? 'var(--emerald)' : conf >= 50 ? 'var(--amber)' : 'var(--crimson)';
    const sev  = t.severity || 'yellow';
    return `
    <div class="rv sev-${sev} st-${st}" id="rv-${t.id}">
      <div class="rv-body">
        <div class="rv-info">
          <div class="rv-title">${esc(t.item||'')} <span class="pill ${sev}">${sev}</span></div>
          <div class="rv-desc">${esc(t.finding||'')}</div>
          <div class="rv-chips">
            ${t.amount && t.amount !== 'N/A' ? `<span class="chip-amt">${esc(t.amount)}</span>` : ''}
            <span class="chip-type">${esc(t.type||'Other')}</span>
          </div>
        </div>
        <div class="rv-actions">
          ${st === 'pending'
            ? `<button class="btn btn-sm btn-approve" onclick="doReview('${t.id}','approved')">Approve</button>
               <button class="btn btn-sm btn-reject"  onclick="doReview('${t.id}','rejected')">Reject</button>`
            : `<span class="sp sp-${st}">${st}</span>`}
        </div>
      </div>
      <div class="conf-row">
        <span class="conf-label">AI confidence</span>
        <div class="conf-track"><div class="conf-fill" style="width:${conf}%;background:${cc}"></div></div>
        <span class="conf-num" style="color:${cc}">${conf}%</span>
      </div>
      <button class="reason-toggle" onclick="toggleR('${t.id}')">▸ GPT-4o reasoning</button>
      <div class="reason-body" id="rb-${t.id}">${esc(t.confidenceReasoning||'No reasoning provided.')}\n\nRecommendation: ${esc(t.recommendation||'—')}</div>
    </div>`;
  }).join('');

  const p = Object.values(reviewSt).filter(s => s === 'pending').length;
  document.getElementById('rev-badge').textContent = p;
  document.getElementById('rev-badge').className   = 'nb-badge' + (p > 0 ? ' on' : '');
  document.getElementById('k-queue').textContent   = p;
}

function toggleR(id) {
  const el  = document.getElementById('rb-' + id);
  const tog = el.previousElementSibling;
  if (el.style.display === 'block') { el.style.display = 'none'; tog.textContent = '▸ GPT-4o reasoning'; }
  else                               { el.style.display = 'block'; tog.textContent = '▾ GPT-4o reasoning'; }
}
function doReview(id, action) { reviewSt[id] = action; renderReview(); renderTxTable(); }
function setFilter(f, btn) {
  filterMode = f;
  document.querySelectorAll('.flt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderReview();
}

// ═══════════════════════════════════
// TRANSACTIONS TABLE
// ═══════════════════════════════════
function renderTxTable() {
  if (!report) return;
  document.getElementById('tx-body').innerHTML = (report.transactions || []).map(t => {
    const conf = t.confidence || 0;
    const cc   = conf >= 75 ? 'var(--emerald)' : conf >= 50 ? 'var(--amber)' : 'var(--crimson)';
    const st   = t.needsReview ? (reviewSt[t.id] || 'pending') : null;
    const spill = st
      ? `<span class="pill ${st==='approved'?'green':st==='rejected'?'red':'review'}">${st}</span>`
      : `<span class="pill auto">auto</span>`;
    const change = t.pctChange != null
      ? (t.pctChange > 0 ? '+' : '') + t.pctChange.toFixed(1) + '%' : '—';
    const chColor = t.pctChange == null ? 'var(--dim)'
      : Math.abs(t.pctChange) > 40 ? 'var(--crimson)'
      : Math.abs(t.pctChange) > 15 ? 'var(--amber)' : 'var(--emerald)';
    return `<tr>
      <td style="font-weight:500;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bright)">${esc(t.item||'')}</td>
      <td><span class="chip-type">${esc(t.type||'')}</span></td>
      <td style="font-family:var(--mono);font-size:11px;white-space:nowrap">${esc(t.amount||'—')}</td>
      <td style="font-family:var(--mono);font-size:11px;color:${chColor};white-space:nowrap">${change}</td>
      <td style="color:var(--muted);max-width:260px;font-size:12px">${esc(t.finding||'')}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-mini"><div class="bar-fill" style="width:${conf}%;background:${cc}"></div></div>
          <span style="font-family:var(--mono);font-size:10.5px;color:${cc};width:28px;text-align:right">${conf}%</span>
        </div>
      </td>
      <td><span class="pill ${t.severity||'yellow'}">${t.severity||'yellow'}</span></td>
      <td>${spill}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════
// EXPORT
// ═══════════════════════════════════
function exportReport() {
  if (!report) return;
  const r = report;
  const lines = [
    'LEDGER IQ — QUALITY OF EARNINGS REPORT', '='.repeat(60), '',
    `Score: ${r.score}/100   Grade: ${r.grade}`,
    `Verdict: ${r.verdict}`, '',
    'Categories', '-'.repeat(40),
    ...(r.categories||[]).map(c => `  ${c.name.padEnd(28)} ${c.score}/100`), '',
    'Key Findings', '-'.repeat(40),
    ...(r.flags||[]).map(f => `  [${(f.severity||'').toUpperCase()}] ${f.title}\n         ${f.detail}`), '',
    'Analyst Narrative', '-'.repeat(40), r.narrative||'', '',
    'Methodology', '-'.repeat(40), r.methodology||'', '',
    'Transaction Detail', '-'.repeat(40),
    ...(r.transactions||[]).map(t => {
      const st = t.needsReview ? (reviewSt[t.id]||'PENDING').toUpperCase() : 'AUTO';
      return `  [${(t.severity||'').toUpperCase()}] ${t.item}  (${t.amount||'N/A'})\n  Type:${t.type} | Change:${t.pctChange!=null?t.pctChange.toFixed(1)+'%':'—'} | Conf:${t.confidence}% | Review:${st}\n  Finding: ${t.finding}\n  Rec: ${t.recommendation}\n  Reasoning: ${t.confidenceReasoning}\n`;
    }), '',
    r._meta?.tokenUsage ? `Token usage: ${r._meta.tokenUsage.totalTokens} total (${r._meta.tokenUsage.inputTokens} in / ${r._meta.tokenUsage.outputTokens} out)` : '',
    'Exported: ' + new Date().toLocaleString()
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'LedgerIQ-QoE-' + new Date().toISOString().slice(0,10) + '.txt';
  a.click();
}

// ═══════════════════════════════════
// RESET
// ═══════════════════════════════════
function resetAll() {
  files = []; report = null; reviewSt = {}; filterMode = 'all';
  document.getElementById('file-list').innerHTML = '';
  document.getElementById('log-box').innerHTML   = '';
  document.getElementById('prog-fill').style.width = '0%';
  document.getElementById('prog-pct').textContent  = '0%';
  document.getElementById('file-input').value = '';
  document.getElementById('rev-badge').className = 'nb-badge';
  document.getElementById('tb-meta').textContent   = '';
  document.getElementById('token-strip-wrap').style.display = 'none';
  go('upload'); updateBtn();
}

// ═══════════════════════════════════
// UTILS
// ═══════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════
// DEMO DATA — preloaded on first visit
// ═══════════════════════════════════
const DEMO_REPORT = {
  score: 52,
  grade: "C+",
  verdict: "Acme Manufacturing presents moderate earnings quality concerns across multiple dimensions. Significant related-party transactions, elevated owner compensation, and a deteriorating AR profile warrant careful diligence. Adjusted EBITDA addbacks are substantial relative to reported earnings, and the company breached a debt covenant as recently as FY2022.",
  dataScope: "Analysis based on: Income Statement (FY2022–2024), EBITDA Adjustments Schedule, AR Aging, Debt Schedule, Revenue Recognition, Employee Census, and Balance Sheet.",
  categories: [
    { name: "Revenue Quality",    score: 61, color: "yellow", basis: "Income Statement, Revenue Recognition Schedule" },
    { name: "EBITDA Quality",     score: 38, color: "red",    basis: "Income Statement, EBITDA Adjustments Schedule" },
    { name: "Working Capital",    score: 49, color: "red",    basis: "AR Aging, Balance Sheet" },
    { name: "Balance Sheet",      score: 44, color: "red",    basis: "Balance Sheet, Debt Schedule" },
    { name: "Accounting Quality", score: 72, color: "yellow", basis: "Income Statement, Balance Sheet" }
  ],
  flags: [
    { severity: "red",    title: "Related Party Transactions",        detail: "Management fees of $240K/yr paid to an undisclosed related entity, plus a $500K shareholder loan at 0% interest and a $250K note to Anderson Family LLC at below-market 2% rate." },
    { severity: "red",    title: "EBITDA Addbacks = 100% of Reported EBITDA", detail: "Adjusted EBITDA of $1.70M vs. reported EBITDA of $847K — total addbacks ($851K) nearly equal reported earnings, requiring independent verification of each item." },
    { severity: "red",    title: "AR Aging Deterioration",            detail: "DSO increased from 44 to 56 days (+27%) YoY. 15.6% of receivables are over 90 days past due. Three customers show significant overdue balances." },
    { severity: "red",    title: "Family Payroll — Three Officers",   detail: "CEO (J. Anderson), spouse (M. Anderson, COO), and son (R. Anderson, VP Sales) collectively draw $280K/yr. Market-rate adjustment of ~$120K is included in addbacks." },
    { severity: "red",    title: "Debt Covenant Breach in FY2022",    detail: "Net Debt/EBITDA of 5.98x exceeded the 5.0x covenant maximum in FY2022. Company has since improved to 4.36x but lender relationship and waiver terms require review." },
    { severity: "yellow", title: "Contractor Headcount Up 3x",        detail: "Independent contractors grew from 8 to 24 over 8 quarters (+200%). Annualized 1099 spend reached ~$1.1M. Misclassification risk and dependency on non-employee labor warrant review." },
    { severity: "yellow", title: "Lumpy Project Revenue",             detail: "One-time project revenue of $830K (38% of total) is non-recurring. Recurring subscription revenue of $1.36M is the more reliable base for forward projections." },
    { severity: "yellow", title: "Negative Retained Earnings",        detail: "Accumulated deficit of $(1.19M) on the balance sheet. Equity is negative at $(1.09M), though improving from $(2.26M) in FY2022." },
    { severity: "green",  title: "Revenue Growth Trend",              detail: "Total revenue grew from $4.75M to $6.41M (+35%) over 3 years. Recurring subscription revenue is stable and growing." }
  ],
  narrative: "Acme Manufacturing Inc. presents a mixed quality of earnings picture that warrants elevated diligence scrutiny, particularly around EBITDA normalization, related-party arrangements, and working capital trends.\n\nThe most significant concern is the magnitude of management EBITDA adjustments relative to reported earnings. Total addbacks of $851K in FY2024 nearly equal the reported EBITDA of $847K, implying that virtually all reported earnings require normalization. While some adjustments appear legitimate (one-time legal settlement, restructuring costs), others — particularly the $240K related-party management fee and $51K of personal expenses — raise questions about the arm's-length nature of transactions and the rigor of historical financial controls.\n\nRelated-party transactions represent a systemic risk. Beyond the management fee, the company carries a $500K shareholder loan at 0% interest and a $250K note payable to Anderson Family LLC at a below-market 2% rate. These arrangements obscure true cash flows and require independent valuation of economic terms. The presence of three family members on the executive payroll — collectively earning $280K annually — further complicates normalization.\n\nAccounts receivable quality has deteriorated meaningfully. DSO increased 27% year-over-year to 56 days, and 15.6% of the AR balance is over 90 days past due. Several customers show persistent overdue balances that may require specific reserves beyond the existing $45K allowance. This trend, if it continues, could signal customer credit stress or collection process weakness.\n\nOn the positive side, the company demonstrates consistent top-line growth (35% over three years) with stable gross margins around 45–46%. The recurring subscription revenue base of $1.36M provides a reliable foundation, though deal teams should discount the $830K in one-time project revenue for forward EBITDA projections. The debt leverage profile, while elevated, is trending in the right direction following the FY2022 covenant breach.",
  methodology: "This analysis was performed on seven financial documents covering FY2022–FY2024: an income statement, EBITDA adjustment schedule, AR aging report, debt schedule, monthly revenue recognition detail, employee census, and balance sheet. The backend parsed and classified 147 line items; the top 80 by risk priority were submitted for AI confidence scoring.\n\nNotably absent from this package: cash flow statements, bank statements/proof of cash, general ledger or trial balance detail, tax returns, accounts payable aging, and inventory detail. The absence of these documents limits our ability to assess cash conversion quality, verify revenue recognition timing, or perform a full working capital analysis. Scores for Cash Conversion and Accounting Quality categories were not assigned due to insufficient data. All findings should be validated against primary source documents and confirmed through management interviews.",
  transactions: [
    { id:"rel-party-mgmt-fee",     item:"Related Party Management Fees",           type:"Related Party",     amount:"$240.0K", finding:"Non-arm's-length fee paid to undisclosed affiliate; reduces reported EBITDA by $240K annually",           severity:"red",    confidence:92, confidenceReasoning:"Explicitly labeled as related party in source document with consistent 3-year pattern.",              needsReview:true,  recommendation:"Obtain underlying agreement, confirm market rate, verify recipient entity ownership" },
    { id:"owner-comp-ceo",         item:"Owner Compensation - CEO",                type:"Owner Compensation",amount:"$480.0K", finding:"CEO compensation $200K above estimated $280K market rate; excess is a legitimate addback",                   severity:"red",    confidence:78, confidenceReasoning:"Market rate benchmark assumed at $280K; actual comparables needed to confirm.",                      needsReview:true,  recommendation:"Pull compensation benchmarking study for manufacturing CEO of comparable revenue" },
    { id:"adj-related-party-rent", item:"Adj: Above-Market Facility Rent (related party)", type:"Related Party", amount:"$60.0K", finding:"Facility rented from related party at $60K/yr vs $48K market; $12K excess is addback but ownership unclear", severity:"red",    confidence:71, confidenceReasoning:"Market rate assumed; actual lease and property ownership not confirmed in provided documents.",       needsReview:true,  recommendation:"Obtain lease agreement and confirm landlord entity ownership structure" },
    { id:"adj-personal-expenses",  item:"Adj: Personal Expenses Run Through Business", type:"Non-Recurring",  amount:"$51.0K", finding:"$51K of personal expenses in operating costs; addback is appropriate but pattern suggests control weakness", severity:"red",    confidence:83, confidenceReasoning:"Amount growing year-over-year ($42K→$51K) suggests systemic rather than one-time occurrence.",       needsReview:true,  recommendation:"Request GL detail to identify expense categories; assess internal control environment" },
    { id:"owner-loan-shareholder", item:"Debt: Owner Shareholder Loan - J. Anderson", type:"Debt & Leverage", amount:"$500.0K", finding:"$500K loan from owner at 0% interest, due on demand — creates refinancing risk and hidden economic cost",   severity:"red",    confidence:95, confidenceReasoning:"Clearly stated in debt schedule with 0% rate and on-demand maturity.",                               needsReview:true,  recommendation:"Determine if loan will be repaid at close or converted to equity; impute market interest in normalization" },
    { id:"ar-pacific-trading",     item:"AR: Pacific Trading Group",               type:"Accounts Receivable",amount:"$80.0K", finding:"$35K (44%) of balance is 90+ days past due; highest concentration risk in AR aging",                      severity:"red",    confidence:88, confidenceReasoning:"Aging buckets clearly stated in AR schedule.",                                                          needsReview:true,  recommendation:"Confirm collectability; assess whether specific reserve is warranted" },
    { id:"ar-dso-change",          item:"DSO Change",                              type:"Accounts Receivable",amount:"N/A",     finding:"DSO deteriorated 27% YoY from 44 to 56 days — meaningful working capital headwind",                        severity:"red",    confidence:94, confidenceReasoning:"Calculated directly from AR aging report data.",                                                        needsReview:true,  recommendation:"Identify root cause: new customer terms, collection issues, or revenue recognition timing" },
    { id:"debt-covenant-breach",   item:"Covenant Compliance - FY2022",            type:"Debt & Leverage",   amount:"N/A",     finding:"Net Debt/EBITDA of 5.98x breached 5.0x covenant in FY2022; waiver status and lender relationship unclear",   severity:"red",    confidence:97, confidenceReasoning:"Explicitly flagged in debt schedule as non-compliant.",                                                 needsReview:true,  recommendation:"Obtain waiver documentation and confirm current lender standing; review covenant structure at close" },
    { id:"family-payroll-coo",     item:"Payroll: M. Anderson - COO (spouse)",     type:"Payroll",           amount:"$360.0K", finding:"Spouse of CEO on executive payroll; role and market-rate compensation require independent verification",      severity:"red",    confidence:85, confidenceReasoning:"Relationship disclosed in employee census; $360K annualized above typical COO comp for company size.", needsReview:true,  recommendation:"Assess whether role is operationally necessary; obtain job description and market comp data" },
    { id:"adj-ebitda-addbacks-total", item:"Total Adjustments",                    type:"EBITDA Adj",        amount:"$851.0K", finding:"Addbacks equal 100% of reported EBITDA — buyer should independently verify each line before accepting adjusted figure", severity:"red", confidence:91, confidenceReasoning:"Sum verified against individual line items in EBITDA schedule.",                                    needsReview:true,  recommendation:"Build bottoms-up addback verification schedule; confirm with supporting invoices/documentation" },
    { id:"contractor-growth",      item:"1099 Contractor Spend",                   type:"Contractors",       amount:"$268.0K", finding:"Quarterly contractor spend up 191% over 2 years; annualized ~$1.1M raises misclassification and dependency risk", severity:"yellow", confidence:82, confidenceReasoning:"Trend clearly visible in census data; exact worker classification not confirmed.",                    needsReview:true,  recommendation:"Review contractor agreements for misclassification exposure; assess which roles are business-critical" },
    { id:"deferred-rev-swing",     item:"Ending Balance (Deferred Revenue)",       type:"Revenue Recognition",amount:"$166.0K", finding:"Deferred revenue balance fluctuated significantly mid-year (peak $312K in Sept); timing of recognition needs review", severity:"yellow", confidence:74, confidenceReasoning:"Monthly schedule shows unusual Q3 spike; underlying contract terms not available.",                 needsReview:true,  recommendation:"Tie deferred revenue balance to specific contracts; confirm recognition policy is consistent with GAAP" },
    { id:"revolver-increase",      item:"Revolving Credit Facility (drawn)",       type:"Debt & Leverage",   amount:"$950.0K", finding:"Revolver draws increased 138% from $400K to $950K over 3 years, suggesting working capital strain",             severity:"yellow", confidence:89, confidenceReasoning:"Balance trajectory clearly visible in debt schedule.",                                                   needsReview:true,  recommendation:"Analyze seasonal vs. structural revolver usage; assess headroom under credit facility" },
    { id:"rd-spike",               item:"Research & Development",                  type:"SG&A",              amount:"$310.0K", finding:"R&D expense grew 158% over 3 years ($120K→$310K); nature and capitalization policy require clarification",    severity:"yellow", confidence:76, confidenceReasoning:"Magnitude of increase is notable; whether costs are expensed or capitalized is unclear.",                 needsReview:true,  recommendation:"Request R&D project list and capitalization policy; assess recurring vs. one-time nature" },
    { id:"total-revenue-growth",   item:"Total Revenue",                           type:"Revenue",           amount:"$6.41M",  finding:"Revenue grew 35% over 3 years ($4.75M→$6.41M) with stable gross margins of ~45% — positive quality signal",    severity:"green",  confidence:91, confidenceReasoning:"Multi-year trend confirmed across income statement; no restatements noted.",                             needsReview:false, recommendation:"Confirm organic vs. acquired growth; validate recurring contract base" },
    { id:"gross-margin-stable",    item:"Gross Margin %",                          type:"COGS & Margin",     amount:"45.9%",   finding:"Gross margin stable at 44–46% across all periods — indicates pricing power and consistent cost structure",        severity:"green",  confidence:88, confidenceReasoning:"Consistent across three years with minimal variance.",                                                   needsReview:false, recommendation:"No action required; validate COGS classification excludes any misallocated overhead" },
    { id:"recurring-revenue",      item:"Total Recurring Revenue",                 type:"Revenue",           amount:"$1.36M",  finding:"$1.36M in recurring subscription revenue provides stable, predictable base — highest-quality revenue component", severity:"green",  confidence:86, confidenceReasoning:"Monthly revenue recognition schedule shows consistent subscription billings.",                            needsReview:false, recommendation:"Confirm contract terms and renewal rates; request customer concentration analysis" },
    { id:"net-fixed-assets",       item:"Net Fixed Assets",                        type:"CapEx & Fixed Assets",amount:"$2.39M",finding:"Net PP&E grew modestly; depreciation policy appears consistent with asset base",                              severity:"green",  confidence:79, confidenceReasoning:"Balance sheet shows steady asset additions; no unusual write-downs noted.",                             needsReview:false, recommendation:"Confirm remaining useful life of key equipment; assess CapEx requirements going forward" }
  ],
  _meta: {
    filesProcessed: 7,
    totalTransactions: 147,
    tokenUsage: { inputTokens: 8420, outputTokens: 4180, totalTokens: 12600 },
    parsedAt: "2024-01-15T18:29:41.000Z",
    isDemo: true
  }
};

const DEMO_STORAGE_KEY = 'ledgeriq_demo_v1';

function loadDemo() {
  // 1. Always show something immediately — cached real result or hardcoded fallback
  let usedCache = false;
  try {
    const cached = localStorage.getItem(DEMO_STORAGE_KEY);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < 7 * 24 * 60 * 60 * 1000) {
        report = data;
        usedCache = true;
      }
    }
  } catch {}

  if (!usedCache) report = DEMO_REPORT;

  finishReport();
  showDemoBanner();

  // 2. Silently refresh with real GPT-4o in background (doesn't block UI)
  setTimeout(refreshDemoInBackground, 500);
}

function showDemoBanner() {
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.style.cssText = `
    position: fixed; bottom: 0; left: 220px; right: 0; z-index: 100;
    background: var(--ink2); border-top: 1px solid var(--teal-mid);
    padding: 9px 20px; display: flex; align-items: center; gap: 12px;
    font-family: var(--mono); font-size: 11px; color: var(--dim);
  `;
  bar.innerHTML = `
    <span style="color:var(--teal)">◆ DEMO</span>
    <span>Showing sample QoE analysis — Acme Manufacturing Inc. (7 files, FY2022–2024)</span>
    <button onclick="document.getElementById('demo-bar').remove(); resetAll();" style="margin-left:auto; background:var(--teal); color:var(--ink); border:none; border-radius:4px; padding:4px 10px; font-family:var(--mono); font-size:11px; font-weight:600; cursor:pointer;">Upload your own files →</button>
  `;
  document.body.appendChild(bar);
}

// ═══════════════════════════════════
// INIT — wire everything after DOM ready
// ═══════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  // Wire file drop zone
  const dz = document.getElementById('drop');
  const fi = document.getElementById('file-input');
  if (dz && fi) {
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('drag'));
    dz.addEventListener('drop',      e  => { e.preventDefault(); dz.classList.remove('drag'); addFiles(e.dataTransfer.files); });
    dz.addEventListener('click',     ()  => fi.click());
    fi.addEventListener('change',    ()  => { addFiles(fi.files); fi.value = ''; });
  }

  updateBtn();

  // Load demo immediately (instant — no spinner, no blocking)
  loadDemo();
});
