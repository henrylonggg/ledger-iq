// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
const API_BASE = 'https://ledger-iq-oi3l.onrender.com';

// ═══════════════════════════════════
// STATE
// ═══════════════════════════════════
let files      = [];
let report     = null;
let reviewSt   = {};   // id → 'pending' | 'approved' | 'rejected'
let filterMode = 'all';

// ═══════════════════════════════════
// NAV
// ═══════════════════════════════════
const titles = {
  upload:'Upload', dashboard:'Dashboard',
  review:'Review Queue', transactions:'Transactions', narrative:'Narrative',
  terms:'Terms & Conditions', contact:'Contact'
};
function go(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  const nb = document.getElementById('nb-' + page);
  if (nb) nb.classList.add('active');
  document.getElementById('tb-title').textContent = titles[page] || page;
  const hasR = !!report;
  document.getElementById('btn-export').style.display = hasR ? '' : 'none';
  document.getElementById('btn-reset').style.display  = hasR ? '' : 'none';
}

// ═══════════════════════════════════
// REVIEW-AWARE METRICS
// ─ accepted items count toward scores;
// ─ rejected items are excluded
// ═══════════════════════════════════
function getActiveTransactions() {
  if (!report?.transactions) return [];
  return report.transactions.filter(t => {
    // items not needing review are always active
    if (!t.needsReview) return true;
    const st = reviewSt[t.id] || 'pending';
    return st !== 'rejected';   // pending + approved both count
  });
}

function recalcMetrics() {
  if (!report) return;
  const active   = getActiveTransactions();
  const rejected = (report.transactions || []).filter(t => t.needsReview && reviewSt[t.id] === 'rejected');

  // Re-derive score: start from GPT score, reduce proportionally for rejected red/yellow
  let adjScore = report.score || 0;
  if (rejected.length > 0 && report.transactions?.length > 0) {
    // Each rejected red item removes weight from score (simple proportional deduction)
    const redRejected    = rejected.filter(t => t.severity === 'red').length;
    const yellowRejected = rejected.filter(t => t.severity === 'yellow').length;
    // Red items contribute ~3pts each, yellow ~1.5pts to penalty relief when rejected
    const relief = redRejected * 3 + yellowRejected * 1.5;
    adjScore = Math.min(100, Math.round(adjScore + relief));
  }

  const pending = Object.values(reviewSt).filter(s => s === 'pending').length;
  const redCt   = active.filter(t => t.severity === 'red').length;
  const avgConf = active.length
    ? Math.round(active.reduce((s, t) => s + (t.confidence || 0), 0) / active.length) : 0;

  const arcColor = adjScore >= 70 ? 'var(--emerald)' : adjScore >= 45 ? 'var(--amber)' : 'var(--crimson)';
  const riskLbl  = adjScore >= 70 ? 'LOW RISK' : adjScore >= 45 ? 'MODERATE RISK' : 'HIGH RISK';

  document.getElementById('k-score').textContent = adjScore;
  document.getElementById('k-score').style.color  = arcColor;
  document.getElementById('k-grade').textContent  = riskLbl;
  document.getElementById('k-grade').style.color  = arcColor;
  document.getElementById('ring-num').textContent = adjScore;
  const arc = document.getElementById('score-arc');
  arc.style.stroke = arcColor;
  arc.style.strokeDashoffset = 314 - (adjScore / 100) * 314;

  const confEl = document.getElementById('k-conf');
  confEl.textContent = avgConf + '%';
  confEl.style.color = avgConf >= 75 ? 'var(--emerald)' : avgConf >= 50 ? 'var(--amber)' : 'var(--crimson)';

  document.getElementById('k-queue').textContent = pending;
  document.getElementById('k-flags').textContent = redCt;
  document.getElementById('rev-badge').textContent = pending;
  document.getElementById('rev-badge').className   = 'nb-badge' + (pending > 0 ? ' on' : '');
  document.getElementById('tb-meta').textContent   = `score ${adjScore}/100 · ${active.length} active items · ${pending} pending`;

  // Rejected summary banner
  const rejBar = document.getElementById('rejected-bar');
  if (rejected.length > 0) {
    if (rejBar) {
      rejBar.style.display = 'flex';
      rejBar.querySelector('.rej-count').textContent = rejected.length;
    }
  } else if (rejBar) {
    rejBar.style.display = 'none';
  }

  // Re-render dashboard panels so flags, categories & narrative reflect review state
  renderDashboardPanels();
  renderNarrative();
  checkAllReviewed();
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

async function wakeBackend() {
  const TIMEOUT = 60000;
  const start   = Date.now();
  addLog('Connecting to backend…', 'info');
  setProg(2, 'Waking server…', 'Cold-start may take ~30s on first use');

  while (Date.now() - start < TIMEOUT) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      const r    = await fetch(`${API_BASE}/api/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) { addLog('Backend ready.', 'ok'); return true; }
    } catch { /* still waking */ }
    const elapsed = Math.round((Date.now() - start) / 1000);
    addLog(`Server starting… (${elapsed}s)`, 'info');
    setProg(3 + Math.min(elapsed, 25), `Waking server… ${elapsed}s`, 'Render cold-start in progress');
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Backend did not respond within 60 seconds. Try again.');
}

async function startAnalysis() {
  if (!files.length) return;

  showProgressPage();

  try {
    await wakeBackend();

    addLog('Uploading files…', 'info');
    setProg(30, 'Uploading files…');

    const fd = new FormData();
    for (const f of files) fd.append('files', f);

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 300000);
    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      body: fd,
      signal: ctrl.signal
    });
    clearTimeout(tid);

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
// DASHBOARD PANEL RENDERS
// ═══════════════════════════════════
function renderDashboardPanels(r) {
  if (!r) r = report;
  if (!r) return;

  // Categories with basis info
  document.getElementById('cat-stack').innerHTML = (r.categories || []).map(c => {
    const col = c.color === 'green' ? 'var(--emerald)' : c.color === 'red' ? 'var(--crimson)' : 'var(--amber)';
    const sc = c.score || 0;
    const basisHtml = c.basis
      ? `<div class="cat-basis">${esc(c.basis)}</div>`
      : '';
    return `<div class="cat-row">
      <div class="cat-badge" style="background:${col};box-shadow:0 0 6px ${col}44"></div>
      <div class="cat-info">
        <span class="cat-name">${esc(c.name)}</span>
        ${basisHtml}
      </div>
      <div class="cat-track"><div class="cat-fill" style="width:${sc}%;background:${col}"></div></div>
      <span class="cat-num" style="color:${col}">${sc}</span>
    </div>`;
  }).join('');

  // Flags
  document.getElementById('flags-box').innerHTML = (r.flags || []).map(f => `
    <div class="flag ${f.severity || 'yellow'}">
      <div><span class="flag-title">${esc(f.title || '')}</span><span class="flag-detail">${esc(f.detail || '')}</span></div>
    </div>`).join('');
}

function renderNarrative(r) {
  if (!r) r = report;
  if (!r) return;
  const narrativeEl = document.getElementById('dash-narrative');
  if (!narrativeEl) return;
  let html = '';
  if (r.dataScope) {
    html += `<p style="font-family:var(--mono);font-size:10.5px;color:var(--teal);margin-bottom:10px;border-left:2px solid var(--teal);padding-left:8px">${esc(r.dataScope)}</p>`;
  }
  const nHtml = (r.narrative || '').split('\n\n').map(p => `<p>${esc(p)}</p>`).join('');
  html += nHtml;
  narrativeEl.innerHTML = html;
  const nFull = document.getElementById('narrative-full');
  if (nFull) nFull.innerHTML = nHtml;
  const meth = document.getElementById('methodology');
  if (meth) meth.innerHTML = (r.methodology || '').split('\n\n').map(p => `<p>${esc(p)}</p>`).join('');
}

// Auto-save export when all reviewed items are no longer pending
let _exportTriggered = false;
function checkAllReviewed() {
  if (!report || _exportTriggered) return;
  const reviewable = (report.transactions || []).filter(t => t.needsReview);
  if (!reviewable.length) return;
  const anyPending = reviewable.some(t => (reviewSt[t.id] || 'pending') === 'pending');
  if (!anyPending) {
    _exportTriggered = true;
    // Re-render narrative with current state before export
    renderNarrative(report);
    showExportReady();
  }
}

function showExportReady() {
  // Show a prominent notification that export is ready
  const existing = document.getElementById('export-ready-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'export-ready-banner';
  banner.style.cssText = `
    position:fixed;top:60px;right:20px;z-index:500;
    background:linear-gradient(135deg,#0D2235,#0A1A28);
    border:1px solid var(--teal);border-radius:8px;
    padding:14px 18px;max-width:280px;
    box-shadow:0 8px 32px rgba(12,206,212,.2);
    animation:slideInRight .3s ease;
  `;
  banner.innerHTML = `
    <div style="font-family:var(--mono);font-size:9px;color:var(--teal);letter-spacing:.1em;margin-bottom:6px;">REVIEW COMPLETE</div>
    <div style="font-size:13px;font-weight:600;color:var(--bright);margin-bottom:4px;">All items reviewed</div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:12px;">Report & narrative are finalized. Ready to export.</div>
    <button onclick="banner_export()" style="width:100%;background:var(--teal);color:var(--ink);border:none;border-radius:5px;padding:7px 12px;font-weight:700;font-size:11px;cursor:pointer;font-family:var(--mono);">⬇ Export Final Report</button>
    <button onclick="document.getElementById('export-ready-banner').remove()" style="width:100%;background:transparent;color:var(--dim);border:none;padding:4px;font-size:10px;cursor:pointer;margin-top:4px;">dismiss</button>
  `;
  document.body.appendChild(banner);
}

function banner_export() {
  document.getElementById('export-ready-banner')?.remove();
  exportReport();
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
  const scoreColor2 = score >= 70 ? 'var(--emerald)' : score >= 45 ? 'var(--amber)' : 'var(--crimson)';
  const riskLabel   = score >= 70 ? 'LOW RISK' : score >= 45 ? 'MODERATE RISK' : 'HIGH RISK';
  document.getElementById('k-score').textContent  = score;
  document.getElementById('k-score').style.color  = scoreColor2;
  document.getElementById('k-grade').textContent  = riskLabel;
  document.getElementById('k-grade').style.color  = scoreColor2;
  const confEl = document.getElementById('k-conf');
  confEl.textContent = avgConf + '%';
  confEl.style.color = avgConf >= 75 ? 'var(--emerald)' : avgConf >= 50 ? 'var(--amber)' : 'var(--crimson)';
  document.getElementById('k-queue').textContent = pending;
  document.getElementById('k-flags').textContent = redCt;

  // Ring arc (r=50, circumference=314)
  document.getElementById('ring-num').textContent = score;
  const arc = document.getElementById('score-arc');
  const arcColor = scoreColor2;
  arc.style.stroke = arcColor;
  setTimeout(() => { arc.style.strokeDashoffset = 314 - (score / 100) * 314; }, 200);
  const gradeEl = document.getElementById('ring-grade');
  if (gradeEl) { gradeEl.textContent = ''; gradeEl.style.display = 'none'; }

  renderDashboardPanels(r);

  // Data scope + narrative
  renderNarrative(r);

  // Token usage — after panels render
  checkAllReviewed();
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
          <div class="rv-title">${esc(t.item||'')} <span class="pill ${sev}">${sev}</span>${st !== 'pending' ? `<span class="pill ${st === 'approved' ? 'green' : 'red'}">${st}</span>` : ''}</div>
          <div class="rv-desc">${esc(t.finding||'')}</div>
          <div class="rv-chips">
            ${t.amount && t.amount !== 'N/A' ? `<span class="chip-amt">${esc(t.amount)}</span>` : ''}
            <span class="chip-type">${esc(t.type||'Other')}</span>
          </div>
        </div>
        <div class="rv-actions">
          <button class="rv-btn rv-approve ${st === 'approved' ? 'active' : ''}" onclick="doReview('${t.id}', '${st === 'approved' ? 'pending' : 'approved'}')" title="${st === 'approved' ? 'Undo approval' : 'Accept — counts toward score'}">✓</button>
          <button class="rv-btn rv-reject  ${st === 'rejected' ? 'active' : ''}" onclick="doReview('${t.id}', '${st === 'rejected' ? 'pending' : 'rejected'}')" title="${st === 'rejected' ? 'Undo rejection' : 'Reject — excluded from score'}">✕</button>
        </div>
      </div>
      <div class="conf-row">
        <span class="conf-label">AI confidence</span>
        <div class="conf-track"><div class="conf-fill" style="width:${conf}%;background:${cc}"></div></div>
        <span class="conf-num" style="color:${cc}">${conf}%</span>
      </div>
      <button class="reason-toggle" onclick="toggleR('${t.id}')">▸ GPT-4o mini reasoning</button>
      <div class="reason-body" id="rb-${t.id}">${esc(t.confidenceReasoning||'No reasoning provided.')}\n\nRecommendation: ${esc(t.recommendation||'—')}</div>
    </div>`;
  }).join('');

  recalcMetrics();
}

function toggleR(id) {
  const el  = document.getElementById('rb-' + id);
  const tog = el.previousElementSibling;
  if (el.style.display === 'block') { el.style.display = 'none'; tog.textContent = '▸ GPT-4o mini reasoning'; }
  else                               { el.style.display = 'block'; tog.textContent = '▾ GPT-4o mini reasoning'; }
}

function doReview(id, action) {
  reviewSt[id] = action;
  renderReview();
  renderTxTable();
  recalcMetrics();
}

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
    const isRejected = st === 'rejected';
    return `<tr style="${isRejected ? 'opacity:.35;text-decoration:line-through' : ''}">
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
// EXPORT — fixed chart crash
// ═══════════════════════════════════
async function exportReport() {
  if (!report) return;
  const r = report;

  const btn = document.getElementById('btn-export');
  const origTxt = btn.textContent;
  btn.textContent = 'Building…'; btn.disabled = true;

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator  = 'LedgerIQ';
    wb.created  = new Date();
    wb.modified = new Date();

    // ── Palette ──────────────────────────────────────────────────────────────
    const C = {
      navy:    '060A14', navy2:   '0D1626', navy3:   '182236',
      teal:    '0CCED4', tealDim: '0A9EA3',
      bright:  'E8F0FF', muted:   '6B7FA3', dim:     '3D4F6E',
      emerald: '10B981', amber:   'F59E0B', crimson: 'EF4444',
      white:   'FFFFFF', black:   '000000',
    };

    // Use only *active* (non-rejected) transactions for the export
    const activeTxns = getActiveTransactions();
    const scoreColor = r.score >= 70 ? C.emerald : r.score >= 45 ? C.amber : C.crimson;

    function styleHeader(row, bgHex, fgHex, bold, sz) {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgHex } };
        cell.font   = { name: 'Calibri', bold: bold !== false, size: sz || 11, color: { argb: 'FF' + (fgHex || C.bright) } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
      });
    }

    function sevColor(sev) {
      return sev === 'red' ? C.crimson : sev === 'yellow' ? C.amber : C.emerald;
    }

    // ── SHEET 1: Executive Summary ───────────────────────────────────────────
    const ws1 = wb.addWorksheet('Executive Summary', { properties: { tabColor: { argb: 'FF' + C.teal } } });
    ws1.views = [{ state: 'frozen', ySplit: 1 }];

    ws1.mergeCells('A1:H1');
    Object.assign(ws1.getCell('A1'), {
      value: '  LEDGER IQ  —  QUALITY OF EARNINGS REPORT',
      font:  { name: 'Calibri', bold: true, size: 16, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    ws1.getRow(1).height = 36;

    ws1.mergeCells('A2:H2');
    Object.assign(ws1.getCell('A2'), {
      value: `  Generated: ${new Date().toLocaleString()}   |   Files: ${r._meta?.filesProcessed ?? '—'}   |   Active items: ${activeTxns.length} of ${r.transactions?.length ?? '—'}`,
      font:  { name: 'Calibri', size: 10, color: { argb: 'FF' + C.muted } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy2 } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    ws1.getRow(2).height = 20;
    ws1.addRow([]);

    // Score block
    const scoreRow = ws1.addRow([]);
    scoreRow.height = 36;
    ws1.getCell(`B${scoreRow.number}`).value = 'QoE SCORE';
    ws1.getCell(`B${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + C.muted } };
    ws1.getCell(`C${scoreRow.number}`).value = r.score + ' / 100';
    ws1.getCell(`C${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 20, color: { argb: 'FF' + scoreColor } };
    ws1.getCell(`E${scoreRow.number}`).value = 'RISK TIER';
    ws1.getCell(`E${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + C.muted } };
    ws1.getCell(`F${scoreRow.number}`).value = r.score >= 70 ? 'LOW RISK' : r.score >= 45 ? 'MODERATE RISK' : 'HIGH RISK';
    ws1.getCell(`F${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + scoreColor } };
    ws1.addRow([]);

    // Verdict
    const vn = ws1.rowCount + 1;
    ws1.mergeCells(`B${vn}:H${vn}`);
    ws1.getCell(`B${vn}`).value = 'VERDICT';
    ws1.getCell(`B${vn}`).font  = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + C.teal } };
    ws1.getRow(vn).height = 18;

    const vn2 = ws1.rowCount + 1;
    ws1.mergeCells(`B${vn2}:H${vn2 + 3}`);
    ws1.getCell(`B${vn2}`).value = r.verdict || '';
    ws1.getCell(`B${vn2}`).font  = { name: 'Calibri', size: 11, color: { argb: 'FF' + C.bright } };
    ws1.getCell(`B${vn2}`).alignment = { wrapText: true, vertical: 'top' };
    ws1.getCell(`B${vn2}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy3 } };
    ws1.getRow(vn2).height = 72;
    ws1.addRow([]);

    // Category table
    const catHdr = ws1.addRow(['', 'CATEGORY', 'SCORE', 'RATING', '', '', '', '']);
    catHdr.height = 22;
    styleHeader(catHdr, C.navy3, C.teal, true, 10);

    for (const cat of (r.categories || [])) {
      const col  = cat.color === 'green' ? C.emerald : cat.color === 'red' ? C.crimson : C.amber;
      const sc   = cat.score || 0;
      const stars = sc >= 80 ? '●●●●●' : sc >= 60 ? '●●●●○' : sc >= 40 ? '●●●○○' : sc >= 20 ? '●●○○○' : '●○○○○';
      const row  = ws1.addRow(['', cat.name, sc, stars]);
      row.height = 20;
      row.getCell('B').font = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
      row.getCell('C').font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FF' + col } };
      row.getCell('D').font = { name: 'Calibri', size: 10, color: { argb: 'FF' + col } };
      const bg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (row.number % 2 === 0 ? C.navy2 : C.navy3) } };
      row.getCell('B').fill = row.getCell('C').fill = row.getCell('D').fill = bg;
    }

    ws1.getColumn('A').width = 3; ws1.getColumn('B').width = 32;
    ws1.getColumn('C').width = 12; ws1.getColumn('D').width = 14;
    ['E','F','G','H'].forEach((c,i) => ws1.getColumn(c).width = i === 3 ? 40 : 8);
    ws1.properties.defaultRowHeight = 18;

    // ── SHEET 2: Flags & Findings ────────────────────────────────────────────
    const ws2 = wb.addWorksheet('Flags & Findings', { properties: { tabColor: { argb: 'FF' + C.crimson } } });
    ws2.views = [{ state: 'frozen', ySplit: 2 }];

    ws2.mergeCells('A1:G1');
    Object.assign(ws2.getCell('A1'), {
      value: '  FLAGS & KEY FINDINGS',
      font:  { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle' }
    });
    ws2.getRow(1).height = 32;

    const flagHdrRow = ws2.addRow(['SEV', 'TITLE', 'DETAIL', 'CATEGORY', 'IMPACT']);
    flagHdrRow.height = 22;
    styleHeader(flagHdrRow, C.navy3, C.teal, true, 10);

    for (const flag of (r.flags || [])) {
      const sev = (flag.severity || 'yellow').toLowerCase();
      const col = sevColor(sev);
      const row = ws2.addRow([sev.toUpperCase(), flag.title || '', flag.detail || '', flag.category || '', flag.impact || '']);
      row.height = 48;
      row.getCell(1).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + col } };
      row.getCell(1).font  = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF' + C.black } };
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell(2).font  = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + col } };
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      row.getCell(3).font  = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
      row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
      row.getCell(4).font  = { name: 'Calibri', size: 9, color: { argb: 'FF' + C.muted } };
      row.getCell(5).font  = { name: 'Calibri', size: 9, color: { argb: 'FF' + C.muted } };
      const bg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (row.number % 2 === 0 ? C.navy2 : C.navy3) } };
      for (let ci = 2; ci <= 5; ci++) row.getCell(ci).fill = bg;
    }

    ws2.getColumn(1).width = 8; ws2.getColumn(2).width = 36;
    ws2.getColumn(3).width = 60; ws2.getColumn(4).width = 24; ws2.getColumn(5).width = 24;

    // ── SHEET 3: Transaction Detail (active items only) ──────────────────────
    const ws3 = wb.addWorksheet('Transaction Detail', { properties: { tabColor: { argb: 'FF' + C.amber } } });
    ws3.views = [{ state: 'frozen', ySplit: 2 }];

    ws3.mergeCells('A1:J1');
    Object.assign(ws3.getCell('A1'), {
      value: `  TRANSACTION DETAIL  (${activeTxns.length} active · rejected items excluded)`,
      font:  { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle' }
    });
    ws3.getRow(1).height = 32;

    const txHdr = ws3.addRow(['SEV', 'LINE ITEM', 'TYPE', 'AMOUNT', '% CHG', 'CONF %', 'REVIEW', 'FINDING', 'RECOMMENDATION', 'REASONING']);
    txHdr.height = 22;
    styleHeader(txHdr, C.navy3, C.teal, true, 9);

    for (const tx of activeTxns) {
      const sev   = (tx.severity || 'green').toLowerCase();
      const col   = sevColor(sev);
      const revSt = tx.needsReview ? (reviewSt[tx.id] || 'pending').toUpperCase() : 'AUTO';
      const pct   = tx.pctChange != null ? (tx.pctChange > 0 ? '+' : '') + tx.pctChange.toFixed(1) + '%' : '—';
      const row   = ws3.addRow([
        sev.toUpperCase(), tx.item || '', tx.type || '',
        tx.formattedAmount || tx.amount || '', pct,
        (tx.confidence || 0) + '%', revSt,
        tx.finding || '', tx.recommendation || '', tx.confidenceReasoning || ''
      ]);
      row.height = 52;

      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + col } };
      row.getCell(1).font = { name: 'Calibri', bold: true, size: 8, color: { argb: 'FF' + C.black } };
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

      const bgHex = row.number % 2 === 0 ? C.navy2 : C.navy3;
      for (let ci = 2; ci <= 10; ci++) {
        row.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgHex } };
        row.getCell(ci).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(ci).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + C.bright } };
      }
      row.getCell(2).font = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF' + col } };
      row.getCell(4).font = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF' + C.bright } };
      const pctVal = tx.pctChange || 0;
      row.getCell(5).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + (Math.abs(pctVal) > 50 ? C.crimson : Math.abs(pctVal) > 15 ? C.amber : C.bright) } };
      const confVal = tx.confidence || 0;
      row.getCell(6).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + (confVal >= 80 ? C.emerald : confVal >= 50 ? C.amber : C.crimson) } };
    }

    ws3.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + activeTxns.length, column: 10 } };
    ws3.getColumn(1).width  = 7;  ws3.getColumn(2).width  = 32;
    ws3.getColumn(3).width  = 18; ws3.getColumn(4).width  = 14;
    ws3.getColumn(5).width  = 9;  ws3.getColumn(6).width  = 9;
    ws3.getColumn(7).width  = 10; ws3.getColumn(8).width  = 44;
    ws3.getColumn(9).width  = 44; ws3.getColumn(10).width = 44;

    // ── SHEET 4: Narrative & Methodology ────────────────────────────────────
    const ws4 = wb.addWorksheet('Narrative & Method', { properties: { tabColor: { argb: 'FF' + C.tealDim } } });

    ws4.mergeCells('A1:D1');
    Object.assign(ws4.getCell('A1'), {
      value: '  ANALYST NARRATIVE & METHODOLOGY',
      font:  { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle' }
    });
    ws4.getRow(1).height = 32;
    ws4.addRow([]);

    function addNarrSection(ws, title, body) {
      const hRow = ws.addRow([title]);
      hRow.getCell(1).font  = { name: 'Calibri', bold: true, size: 12, color: { argb: 'FF' + C.teal } };
      hRow.getCell(1).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy3 } };
      hRow.height = 24;
      for (const para of (body || '').trim().split(/\n\n+/)) {
        const rn = ws.rowCount + 1;
        ws.mergeCells(`A${rn}:D${rn}`);
        const bRow = ws.addRow([para.trim()]);
        bRow.getCell(1).font      = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
        bRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        bRow.getCell(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy2 } };
        bRow.height = Math.max(60, Math.ceil(para.length / 100) * 15);
      }
      ws.addRow([]);
    }

    addNarrSection(ws4, 'ANALYST NARRATIVE', r.narrative);
    addNarrSection(ws4, 'METHODOLOGY', r.methodology);
    if (r._meta?.tokenUsage) {
      addNarrSection(ws4, 'MODEL USAGE',
        `Total tokens: ${r._meta.tokenUsage.totalTokens}\nInput: ${r._meta.tokenUsage.inputTokens}\nOutput: ${r._meta.tokenUsage.outputTokens}\nFiles analyzed: ${r._meta.filesProcessed}`
      );
    }
    ws4.getColumn('A').width = 50;
    ['B','C','D'].forEach(c => ws4.getColumn(c).width = 20);

    // ── SHEET 5: Score Data (no chart API — ExcelJS browser doesn't support it) ─
    const ws5 = wb.addWorksheet('Score Data', { properties: { tabColor: { argb: 'FF' + C.emerald } } });

    ws5.mergeCells('A1:C1');
    Object.assign(ws5.getCell('A1'), {
      value: '  CATEGORY SCORE BREAKDOWN',
      font:  { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } }
    });
    ws5.getRow(1).height = 32;

    ws5.mergeCells('A2:C2');
    Object.assign(ws5.getCell('A2'), {
      value: 'Select columns A–B rows 3 onward and insert a bar chart in Excel to visualize scores.',
      font:  { name: 'Calibri', italic: true, size: 9, color: { argb: 'FF' + C.muted } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy2 } }
    });
    ws5.getRow(2).height = 16;

    const catDataHdr = ws5.addRow(['Category', 'Score', 'Rating']);
    styleHeader(catDataHdr, C.navy3, C.teal, true, 10);
    catDataHdr.height = 22;

    for (const cat of (r.categories || [])) {
      const sc  = cat.score || 0;
      const col = cat.color === 'green' ? C.emerald : cat.color === 'red' ? C.crimson : C.amber;
      const row = ws5.addRow([cat.name, sc, sc >= 70 ? 'Strong' : sc >= 45 ? 'Moderate' : 'Weak']);
      row.height = 20;
      row.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
      row.getCell(2).font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FF' + col } };
      row.getCell(3).font = { name: 'Calibri', size: 10, color: { argb: 'FF' + col } };
      const bg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (row.number % 2 === 0 ? C.navy2 : C.navy3) } };
      [1,2,3].forEach(ci => row.getCell(ci).fill = bg);
    }

    ws5.addRow([]);
    const totRow = ws5.addRow(['OVERALL QoE SCORE', r.score, r.score >= 70 ? 'LOW RISK' : r.score >= 45 ? 'MODERATE RISK' : 'HIGH RISK']);
    totRow.height = 24;
    totRow.getCell(1).font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FF' + C.teal } };
    totRow.getCell(2).font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + scoreColor } };
    totRow.getCell(3).font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + scoreColor } };
    [1,2,3].forEach(ci => totRow.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy3 } });

    ws5.getColumn(1).width = 36; ws5.getColumn(2).width = 10; ws5.getColumn(3).width = 12;

    // ── SHEET 6: Review Decisions ────────────────────────────────────────────
    const ws6 = wb.addWorksheet('Review Decisions', { properties: { tabColor: { argb: 'FF' + C.muted } } });
    ws6.views = [{ state: 'frozen', ySplit: 2 }];

    ws6.mergeCells('A1:G1');
    Object.assign(ws6.getCell('A1'), {
      value: '  REVIEW DECISIONS — APPROVED & REJECTED ITEMS',
      font:  { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle' }
    });
    ws6.getRow(1).height = 32;

    const revHdr = ws6.addRow(['DECISION', 'LINE ITEM', 'SEVERITY', 'AMOUNT', 'FINDING', 'RECOMMENDATION', 'AI CONFIDENCE']);
    revHdr.height = 22;
    styleHeader(revHdr, C.navy3, C.teal, true, 10);

    const reviewableItems = (r.transactions || []).filter(t => t.needsReview);
    for (const tx of reviewableItems) {
      const st  = reviewSt[tx.id] || 'pending';
      const col = st === 'approved' ? C.emerald : st === 'rejected' ? C.crimson : C.amber;
      const sev = (tx.severity || 'green').toLowerCase();
      const row = ws6.addRow([
        st.toUpperCase(), tx.item || '', sev.toUpperCase(),
        tx.formattedAmount || tx.amount || '',
        tx.finding || '', tx.recommendation || '',
        (tx.confidence || 0) + '%'
      ]);
      row.height = 48;
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + col } };
      row.getCell(1).font = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF' + C.black } };
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      const bgHex = row.number % 2 === 0 ? C.navy2 : C.navy3;
      for (let ci = 2; ci <= 7; ci++) {
        row.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgHex } };
        row.getCell(ci).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(ci).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + C.bright } };
      }
      row.getCell(2).font = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF' + col } };
      const sevCol = sevColor(sev);
      row.getCell(3).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + sevCol } };
      const confVal = tx.confidence || 0;
      row.getCell(7).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + (confVal >= 80 ? C.emerald : confVal >= 50 ? C.amber : C.crimson) } };
    }

    ws6.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + reviewableItems.length, column: 7 } };
    ws6.getColumn(1).width = 12; ws6.getColumn(2).width = 36; ws6.getColumn(3).width = 10;
    ws6.getColumn(4).width = 14; ws6.getColumn(5).width = 44; ws6.getColumn(6).width = 44;
    ws6.getColumn(7).width = 12;

    // ── SHEET 7: Risk Summary Dashboard ─────────────────────────────────────
    const ws7 = wb.addWorksheet('Risk Dashboard', { properties: { tabColor: { argb: 'FF' + C.crimson } } });

    ws7.mergeCells('A1:F1');
    Object.assign(ws7.getCell('A1'), {
      value: '  LEDGER IQ — RISK SUMMARY DASHBOARD',
      font:  { name: 'Calibri', bold: true, size: 16, color: { argb: 'FF' + C.teal } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy } },
      alignment: { vertical: 'middle' }
    });
    ws7.getRow(1).height = 40;

    ws7.mergeCells('A2:F2');
    const scoreColorHex = r.score >= 70 ? C.emerald : r.score >= 45 ? C.amber : C.crimson;
    const riskTierTxt   = r.score >= 70 ? 'LOW RISK' : r.score >= 45 ? 'MODERATE RISK' : 'HIGH RISK';
    Object.assign(ws7.getCell('A2'), {
      value: `QoE Score: ${r.score}/100  |  ${riskTierTxt}  |  Reviewed: ${new Date().toLocaleDateString()}  |  Files: ${r._meta?.filesProcessed ?? '—'}`,
      font:  { name: 'Calibri', bold: true, size: 12, color: { argb: 'FF' + scoreColorHex } },
      fill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy2 } },
      alignment: { vertical: 'middle', horizontal: 'left' }
    });
    ws7.getRow(2).height = 28;
    ws7.addRow([]);

    // KPI tiles row
    const kpiLabelRow = ws7.addRow(['METRIC', '', 'VALUE', '', 'STATUS', '']);
    kpiLabelRow.height = 18;
    styleHeader(kpiLabelRow, C.navy3, C.teal, true, 9);

    const approved = reviewableItems.filter(t => reviewSt[t.id] === 'approved').length;
    const rejected2 = reviewableItems.filter(t => reviewSt[t.id] === 'rejected').length;
    const pendingCt = reviewableItems.filter(t => (reviewSt[t.id] || 'pending') === 'pending').length;
    const redFlags  = (r.flags || []).filter(f => f.severity === 'red').length;
    const ylwFlags  = (r.flags || []).filter(f => f.severity === 'yellow').length;

    const kpiData = [
      ['QoE Score', r.score + ' / 100', riskTierTxt, scoreColorHex],
      ['Active Transactions', activeTxns.length + ' items', 'Approved / active', C.emerald],
      ['Red Flags', redFlags, redFlags > 5 ? 'CRITICAL' : redFlags > 2 ? 'HIGH' : 'MODERATE', C.crimson],
      ['Yellow Flags', ylwFlags, 'Monitor', C.amber],
      ['Items Approved', approved, 'Confirmed findings', C.emerald],
      ['Items Rejected', rejected2, 'Excluded from score', C.crimson],
      ['Items Pending', pendingCt, pendingCt > 0 ? 'ACTION NEEDED' : 'Complete', pendingCt > 0 ? C.amber : C.emerald],
      ['Files Analyzed', r._meta?.filesProcessed ?? '—', 'Documents reviewed', C.teal],
    ];

    for (const [metric, value, status, col] of kpiData) {
      const row = ws7.addRow([metric, '', value, '', status, '']);
      row.height = 28;
      row.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
      row.getCell(3).font = { name: 'Calibri', bold: true, size: 13, color: { argb: 'FF' + col } };
      row.getCell(5).font = { name: 'Calibri', size: 9,  color: { argb: 'FF' + col } };
      const bg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (row.number % 2 === 0 ? C.navy2 : C.navy3) } };
      [1,2,3,4,5,6].forEach(ci => row.getCell(ci).fill = bg);
    }

    ws7.addRow([]);

    // Category breakdown section
    const catSectHdr = ws7.addRow(['CATEGORY BREAKDOWN', '', 'SCORE', '', 'RATING', '']);
    catSectHdr.height = 22;
    styleHeader(catSectHdr, C.navy3, C.teal, true, 10);

    for (const cat of (r.categories || [])) {
      const sc  = cat.score || 0;
      const col = cat.color === 'green' ? C.emerald : cat.color === 'red' ? C.crimson : C.amber;
      const bar = '█'.repeat(Math.round(sc / 10)) + '░'.repeat(10 - Math.round(sc / 10));
      const row = ws7.addRow([cat.name, '', sc, '', bar, '']);
      row.height = 24;
      row.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: 'FF' + C.bright } };
      row.getCell(3).font = { name: 'Calibri', bold: true, size: 12, color: { argb: 'FF' + col } };
      row.getCell(5).font = { name: 'Courier New', size: 10, color: { argb: 'FF' + col } };
      const bg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (row.number % 2 === 0 ? C.navy2 : C.navy3) } };
      [1,2,3,4,5,6].forEach(ci => row.getCell(ci).fill = bg);
      if (cat.basis) {
        const bRow = ws7.addRow(['  Source: ' + cat.basis, '', '', '', '', '']);
        bRow.mergeCells ? null : ws7.mergeCells(`A${bRow.number}:F${bRow.number}`);
        bRow.getCell(1).font = { name: 'Calibri', italic: true, size: 8, color: { argb: 'FF' + C.muted } };
        bRow.getCell(1).fill = bg;
        bRow.height = 16;
      }
    }

    ws7.getColumn(1).width = 36; ws7.getColumn(2).width = 4; ws7.getColumn(3).width = 14;
    ws7.getColumn(4).width = 4;  ws7.getColumn(5).width = 20; ws7.getColumn(6).width = 4;

    // ── Write & download ─────────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = `LedgerIQ-QoE-${new Date().toISOString().slice(0,10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);

  } catch (err) {
    console.error('Export error:', err);
    alert('Export failed: ' + err.message);
  } finally {
    btn.textContent = origTxt;
    btn.disabled    = false;
  }
}

// ═══════════════════════════════════
// RESET
// ═══════════════════════════════════
function resetAll() {
  files = []; report = null; reviewSt = {}; filterMode = 'all'; _exportTriggered = false;
  document.getElementById('export-ready-banner')?.remove();
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
// DEMO — always uses hardcoded data, zero API calls
// ═══════════════════════════════════
const DEMO_REPORT = {
  score: 41, grade: "D+",
  verdict: "Acme Manufacturing presents significant earnings quality concerns across all major dimensions of analysis. The full 18-document package reveals a materially more complex risk profile than a standard 7-document review. Beyond the well-documented related-party transactions and EBITDA normalization issues, the expanded diligence package surfaces: a $250K undisclosed related-party receivable not reflected on the balance sheet provided to buyers; free cash flow collapse to 2.6% margin with negative underlying cash before year-end revolver draws; a 440bps gross margin compression driven by low-quality project revenue mix shift; Michigan state tax nexus exposure ($45–80K); workers' compensation mod factor of 1.18 indicating elevated workplace injury history; single-source raw material dependency (Midwest Steel, 30% of COGS) with no contract and a quoted 10–14% price increase; and a lost major customer with a second at-risk. The combined picture is of a business under meaningful financial stress that requires extensive normalization, independent legal and tax review, and a thorough assessment of the owner-family governance structure before any transaction can be properly priced.",
  dataScope: "Analysis based on 18 documents: Income Statement, EBITDA Adjustments, Balance Sheet, Debt Schedule, AR Aging, AP Aging, Revenue Recognition, Employee Census, Cash Flow Statement, Inventory Schedule, CapEx Schedule, Customer Concentration, Gross Margin by Product, Vendor Concentration, Tax Return Summary, Insurance & Benefits, General Ledger Sample, and R&D & Intangibles (FY2022–2024).",
  categories: [
    { name: "Revenue Quality",    score: 48, color: "red",    basis: "Income Statement, Revenue Recognition, Customer Concentration, Gross Margin by Product" },
    { name: "EBITDA Quality",     score: 29, color: "red",    basis: "EBITDA Adjustments, General Ledger, Insurance & Benefits, AP Aging" },
    { name: "Working Capital",    score: 38, color: "red",    basis: "AR Aging, AP Aging, Inventory Schedule, Cash Flow Statement" },
    { name: "Balance Sheet",      score: 36, color: "red",    basis: "Balance Sheet, Debt Schedule, Cash Flow Statement, General Ledger" },
    { name: "Accounting Quality", score: 44, color: "red",    basis: "Tax Return Summary, General Ledger, R&D & Intangibles, CapEx Schedule" },
    { name: "Operational Risk",   score: 51, color: "yellow", basis: "Vendor Concentration, Insurance & Benefits, Employee Census, Inventory Schedule" }
  ],
  flags: [
    { severity:"red", title:"Undisclosed $250K Related-Party Receivable", detail:"General ledger reveals $250K in advances to Anderson Family LLC (3 draws in FY2024) not reflected on the balance sheet provided to buyers. No formal loan agreement, no interest charged, management states it will be 'settled at closing.' This is a material omission from the diligence package." },
    { severity:"red", title:"Related-Party Ecosystem — Anderson Family", detail:"Anderson Consulting Group (brother-in-law) receives $240K/yr management fee with no SOW; CEO draws $480K vs ~$280K market rate; COO (spouse) draws $360K; VP Sales (son) draws $240K; $500K shareholder loan at 0%; $250K Anderson Family LLC note at 2%; $250K undisclosed GL receivable. Total related-party economic distortion: ~$1.1M+ annually." },
    { severity:"red", title:"EBITDA Addbacks Equal 100% of Reported Earnings", detail:"Adjusted EBITDA of $1.70M vs. reported EBITDA of $847K. Total addbacks of $851K virtually equal reported earnings. GL sample confirms $44K in personal expenses run through T&E (family resort stays, spouse flights, personal dinners). Key-man life insurance premiums ($40K) partially expensed but only $22K addedback." },
    { severity:"red", title:"Free Cash Flow Collapsed — Negative Underlying Cash", detail:"FCF margin fell from 7.2% (FY2022) to 2.6% (FY2024). Cash conversion cycle expanded to 108 days. FY2024 ending cash was negative (-$48.5K) before a last-minute $300K revolver draw in December. Owner took $280K in distributions in the same year FCF was $169K." },
    { severity:"red", title:"440bps Gross Margin Compression — Mix Shift to Low-Quality Revenue", detail:"Blended gross margin declined from 45.1% to 40.7% over 3 years. Non-recurring Custom/Project revenue grew from $0 to $830K at only 17% gross margin vs. 48% for Premium Series. Input cost increases (averaging 6.5%/yr) have outpaced price increases (averaging 2.75%/yr) for 3 consecutive years." },
    { severity:"red", title:"Customer Lost + Second At Risk — $1.17M Revenue Exposure", detail:"Harrison Distribution ($195K annual revenue) was lost in FY2024 — no contract was in place. Pacific Trading Group revenue is declining 3 consecutive years (-19% total) and is currently month-to-month; CFO contacted a competitor in Q3 2024. Combined at-risk exposure: ~$340K–$535K in forward revenue." },
    { severity:"red", title:"AR Aging Deterioration + DSO +27% YoY", detail:"DSO increased from 44 to 56 days. 15.6% of AR is 90+ days past due. Pacific Trading has $35K (44% of balance) overdue 90+ days. Cash conversion cycle of 108 days is significantly above manufacturing benchmarks." },
    { severity:"red", title:"Debt Covenant Breach FY2022 + Revolver Stress", detail:"Net Debt/EBITDA breached 5.0x covenant in FY2022 (5.98x actual). Revolver draws up 138% over 3 years, used to fund working capital deficit. December 2024 emergency draw suggests structural rather than seasonal dependence." },
    { severity:"red", title:"Michigan Tax Nexus Exposure + Undisclosed State Filings", detail:"Michigan nexus determination is under review. Retroactive exposure estimated $45K–$80K plus penalties and interest. Minnesota sales (~$68K) may also trigger economic nexus threshold. No disclosure to buyers was noted in the diligence materials." },
    { severity:"yellow", title:"Single-Source Raw Material — 30% of COGS, No Contract", detail:"Midwest Steel Supply is the sole approved supplier for primary raw material (grade 304 stainless), representing ~30% of total COGS. No long-term contract is in place. Midwest Steel has quoted a 10–14% price increase for FY2025. No alternative qualified suppliers exist; qualification takes 3–6 months." },
    { severity:"yellow", title:"Inventory Turns Declining — DIO 93 Days vs. 65-75 Benchmark", detail:"Inventory turns have declined for 3 consecutive years (4.59x → 3.93x). DIO of 92.9 days is 20–28 days above manufacturing benchmarks. Obsolescence reserve increased 71% YoY ($52K → $89K). Legacy Series (8.4 months on hand) requires a formal sunset plan." },
    { severity:"yellow", title:"CapEx Spike + ERP Project Over Budget", detail:"FY2024 CapEx up 52% YoY ($340K → $518K). ERP implementation (Microsoft Dynamics) is 35% over initial budget with 35% of work remaining; estimated total project cost $300K+. R&D lab expansion ($78K budget) was cancelled in Q3 2024 with $38K sunk costs written off." },
    { severity:"yellow", title:"Workers' Comp Mod Factor 1.18 — 14 Recordable Incidents", detail:"Experience modification factor of 1.18 vs. 1.00 industry baseline indicates above-average injury history. 14 recordable incidents over 3 years including 3 lost-time injuries. Annual safety training is overdue (last conducted March 2023). Elevated mod factor adds ~$12K/yr in excess premiums." },
    { severity:"yellow", title:"1099 Contractor Headcount Up 200% — Misclassification Risk", detail:"Independent contractors grew from 8 to 24 over 8 quarters. Annualized 1099 spend reached ~$1.1M. R. Anderson (VP Sales, CEO's son) personally approves all contractor engagements. No formal misclassification review has been performed." },
    { severity:"yellow", title:"AP Aging Deteriorating — DPO Up 12 Days, Related-Party Payable Rolling", detail:"DPO increased from 39 to 51 days over 3 years indicating cash flow pressure. Anderson Consulting Group AP balance is rolling 60-90+ days on a consistent basis, potentially indicating inability to pay even the related-party fee on time. 7 of top 15 vendors have no formal contracts." },
    { severity:"green",  title:"Revenue Growth 35% Over 3 Years", detail:"Total revenue grew from $4.75M to $6.41M (+35%). Active customer count grew from 42 to 74. Service & Maintenance revenue (highest-quality segment at 76% gross margin) grew 68% to $520K." },
    { severity:"green",  title:"Recurring Subscription Revenue Base — $1.36M", detail:"Monthly subscription revenue from contracted customers is stable and growing. Major contracts with Acme Retail Group (through June 2026) and Great Lakes Industrial (through March 2027) are on multi-year MSAs with auto-renewal." }
  ],
  narrative: "Acme Manufacturing Inc. presents a materially more concerning earnings quality picture when analyzed across all 18 available financial documents compared to a standard 7-document review. The expanded package reveals a business with systemic governance, cash flow, and operational risks that require extensive normalization and independent verification before any transaction can be reliably priced.\n\nThe most critical new finding from the expanded package is a $250K undisclosed related-party receivable identified in the general ledger sample — three advances to Anderson Family LLC made during FY2024, bearing no interest, with no formal loan agreement, and not reflected on the balance sheet provided to buyers. Management's statement that this will be 'settled at closing' is insufficient without documentation. Combined with the existing $500K shareholder loan (0% interest) and $250K Anderson Family LLC note (2%), the total owner-family receivable and payable ecosystem represents over $1M in non-arm's-length financial arrangements.\n\nThe cash flow statement fundamentally changes the financial picture. While the income statement shows $430K in net income, free cash flow has collapsed to $169K (2.6% FCF margin), down from $342K in FY2022. The business ended FY2024 with negative underlying cash before a December revolver draw — meaning the company was cash-flow-insolvent on an operational basis while simultaneously paying the owner $280K in distributions. The cash conversion cycle of 108 days is well above benchmarks and trending materially worse each year.\n\nGross margin compression of 440 basis points over three years is driven by a deliberate mix shift into low-margin Custom/Project work (17% gross margin vs. 48% for the core Premium Series). This is a structural quality-of-earnings issue: the reported top-line growth flatters the underlying recurring earnings base. Combined with input cost inflation outpacing pricing power for three consecutive years, the business is effectively losing margin ground on every dollar of revenue.\n\nOn the customer side, the loss of Harrison Distribution and the deteriorating Pacific Trading relationship represent a combined $340K–$535K in forward revenue at risk. Neither relationship was protected by a long-term contract. Meanwhile, new customer acquisition is producing $18K average annual revenue per customer vs. $92K for legacy customers — a cohort quality issue that inflates customer count metrics without proportional economics.\n\nSeveral yellow flags from the expanded package — single-source raw material dependency, an overdue ERP implementation, rising AP days, workers' comp mod factor, and Michigan tax nexus exposure — do not by themselves disqualify the transaction but each requires dedicated workstreams in diligence and appropriate representations, warranties, and indemnities in the purchase agreement.\n\nAcme's genuine positives — 35% revenue growth, stable recurring subscription base, and high-margin service revenue growth — remain intact. The business has real commercial momentum. However, the adjusted earnings base after full normalization is likely 40–55% below management's represented Adjusted EBITDA, and the multiple paid should reflect the residual risk profile, not the presented figures.",
  methodology: "This analysis was performed on 18 financial documents covering FY2022–FY2024: income statement, EBITDA adjustments, balance sheet, debt schedule, AR aging, AP aging, revenue recognition schedule, employee census, cash flow statement, inventory schedule, CapEx schedule, customer concentration analysis, gross margin by product line, vendor concentration analysis, federal tax return summary, insurance & benefits schedule, general ledger sample (selected accounts), and R&D & intangibles schedule. The backend parsed and classified 312 line items; 28 were submitted for detailed AI confidence scoring based on materiality and risk priority.\n\nAll findings should be validated against primary source documents. Key additional items recommended for further diligence: bank statements and proof of cash reconciliation; complete general ledger for FY2022–2024; all related-party agreements (Anderson Consulting Group, Anderson Family LLC, shareholder loan, facility lease); employment agreements for CEO, COO, and VP Sales; Michigan nexus legal analysis; full insurance loss runs (5 years); ERP implementation project file and remaining budget; Midwest Steel supply agreement and backup supplier qualification timeline.",
  transactions: [
    // ── RED: Related Party & Governance ─────────────────────────────────────
    { id:"undisclosed-rp-receivable",  item:"Undisclosed Related-Party Receivable — Anderson Family LLC", type:"Related Party", amount:"$250.0K", finding:"$250K in GL advances to Anderson Family LLC during FY2024 not on buyer-facing balance sheet; no loan agreement, 0% interest, 'settle at closing' per mgmt", severity:"red", confidence:96, confidenceReasoning:"Three separate GL entries clearly labeled Anderson Family LLC across Q1–Q3 2024; not reconcilable to any balance sheet line.", needsReview:true, recommendation:"Demand full GL reconciliation; require payoff at or before closing; obtain written agreement confirming amount and terms" },
    { id:"rel-party-mgmt-fee",         item:"Anderson Consulting Group — Management Fees", type:"Related Party", amount:"$240.0K", finding:"$20K/month to brother-in-law of CEO for 'strategic advisory services' — no SOW, not competitively bid, AP balance rolls 60-90+ days", severity:"red", confidence:94, confidenceReasoning:"Confirmed in AP aging (rolling 60-90+ day balance), GL (12 monthly entries, all self-approved by J. Anderson), and EBITDA addback schedule.", needsReview:true, recommendation:"Obtain underlying agreement; conduct independent market-rate assessment; require termination at close" },
    { id:"owner-loan-shareholder",      item:"Owner Shareholder Loan — J. Anderson (0% interest)", type:"Debt & Leverage", amount:"$500.0K", finding:"$500K due-on-demand loan from CEO/owner at 0% interest; creates refinancing risk and understates true cost of capital", severity:"red", confidence:97, confidenceReasoning:"Explicitly stated in debt schedule with 0% rate and on-demand maturity; imputed market interest ~$32K/yr at 6.5%.", needsReview:true, recommendation:"Require payoff at closing or convert to equity; impute market-rate interest in normalization" },
    { id:"adj-personal-expenses-gl",   item:"Personal Expenses — GL Sample Confirms $12K–$15K Personal", type:"Non-Recurring", amount:"$44.2K", finding:"GL T&E sample shows family resort stays ($4.8K), spouse flights ($2.2K+$3.8K), family meals, personal trips — total personal amount ~$12–15K of $44K booked", severity:"red", confidence:89, confidenceReasoning:"GL entries include explicit personal flags: 'J. Anderson + spouse,' 'J. Anderson family,' 'appears personal.' Self-approved by CEO on all.", needsReview:true, recommendation:"Pull complete T&E GL for all 3 years; require personal amounts deducted from proceeds or excluded from EBITDA normalization" },
    { id:"family-payroll-all",          item:"Family Payroll — CEO + COO (spouse) + VP Sales (son)", type:"Owner Compensation", amount:"$1.08M", finding:"Three family members on executive payroll drawing combined $1.08M/yr; excess over market rates (~$320K) is in addbacks but family governance concentration is a business continuity risk", severity:"red", confidence:88, confidenceReasoning:"All three confirmed in employee census with relationships disclosed. Combined compensation significantly above market for a $6.4M revenue manufacturer.", needsReview:true, recommendation:"Obtain independent comp benchmarking; assess transition/retention risk for each role; require employment agreements" },
    { id:"adj-ebitda-addbacks-total",   item:"EBITDA Addbacks — 100% of Reported Earnings", type:"EBITDA Adj", amount:"$851.0K", finding:"Adjusted EBITDA $1.70M vs. reported EBITDA $847K; addbacks nearly equal reported earnings. Key-man life premiums only partially addedback ($22K of $40K total)", severity:"red", confidence:93, confidenceReasoning:"Sum cross-verified across EBITDA schedule, GL, and insurance schedule. Partial addback of key-man premiums identified from insurance file.", needsReview:true, recommendation:"Build independent addback verification schedule; confirm each line with supporting documentation; gross up key-man premiums" },
    // ── RED: Cash Flow & Liquidity ───────────────────────────────────────────
    { id:"fcf-collapse",                item:"Free Cash Flow Collapse — 2.6% Margin, Negative Underlying Cash", type:"Cash Flow", amount:"$169.0K", finding:"FCF fell from $342K (7.2% margin) to $169K (2.6%) while owner distributions were $280K — net cash consumed exceeded FCF. Dec 2024 revolver draw masked negative operating cash position", severity:"red", confidence:96, confidenceReasoning:"Cash flow statement shows OCF $587K vs. CapEx $518K = FCF $169K. Owner distributions $280K. Dec revolver draw $300K cross-confirmed in debt schedule.", needsReview:true, recommendation:"Model out normalized FCF net of owner distributions; assess whether business can self-fund operations post-close without revolver dependence" },
    { id:"owner-distributions-vs-fcf",  item:"Owner Distributions $280K vs. FCF $169K", type:"Cash Flow", amount:"$280.0K", finding:"In FY2024, owner extracted $280K in distributions while the business generated only $169K in FCF — meaning $111K more was extracted than the business produced, funded by revolver", severity:"red", confidence:95, confidenceReasoning:"Distributions confirmed in financing section of cash flow statement; FCF computed from OCF minus capex.", needsReview:true, recommendation:"Normalize historical distributions; understand buyer's expectation of post-close owner compensation vs. distribution policy" },
    // ── RED: Revenue Quality ─────────────────────────────────────────────────
    { id:"gross-margin-compression",    item:"Gross Margin Compression — 440bps Over 3 Years", type:"COGS & Margin", amount:"40.7%", finding:"Blended gross margin fell from 45.1% to 40.7%; driven by mix shift to Custom/Project work (17% GM) and input cost inflation outpacing pricing power for 3 consecutive years", severity:"red", confidence:92, confidenceReasoning:"Gross margin by product line schedule cross-confirmed with income statement COGS. Product mix clearly shown with individual line margins.", needsReview:true, recommendation:"Project forward margins assuming (a) current mix and (b) mix reversion to core products; model steel cost sensitivity at +10-14%" },
    { id:"customer-lost-at-risk",       item:"Harrison Distribution Lost + Pacific Trading At Risk", type:"Revenue", amount:"$535.0K", finding:"Harrison Distribution ($195K) lost in FY2024 — no contract existed. Pacific Trading (3-yr revenue decline, month-to-month) is at risk; CFO contacted competitor. Combined forward exposure: $340K–$535K", severity:"red", confidence:91, confidenceReasoning:"Customer concentration file shows Harrison at $0 FY2024 vs $195K FY2023. Pacific Trading declining 19% cumulative. Contract status column confirms month-to-month.", needsReview:true, recommendation:"Request current status call with Pacific Trading; adjust forward revenue run-rate to exclude Pacific Trading in downside scenario" },
    { id:"custom-project-nonrecurring", item:"Non-Recurring Custom Project Revenue — $830K", type:"Revenue", amount:"$830.0K", finding:"Project revenue grew from $0 to $830K (13% of total) but is non-recurring at 17% gross margin. No pipeline visibility. Including it in forward EBITDA overstates run-rate by ~$140K", severity:"red", confidence:90, confidenceReasoning:"Revenue recognition schedule and gross margin by product both confirm project revenue classification and 17% margin.", needsReview:true, recommendation:"Exclude Custom/Project revenue from normalized EBITDA base; require signed backlog schedule as of transaction date" },
    // ── RED: Balance Sheet & Debt ────────────────────────────────────────────
    { id:"ar-dso-change",               item:"AR DSO +27% YoY — 56 Days, 15.6% Over 90 Days", type:"Accounts Receivable", amount:"N/A", finding:"DSO increased from 44 to 56 days. 15.6% of AR is 90+ past due. Pacific Trading has $35K (44% of its balance) over 90 days. CCC of 108 days is well above manufacturing norms.", severity:"red", confidence:95, confidenceReasoning:"Calculated from AR aging schedule. Cross-confirmed with cash flow statement working capital section showing ($210K) AR build in FY2024.", needsReview:true, recommendation:"Require AR reserve analysis; request monthly AR aging for trailing 12 months; negotiate AR holdback or working capital peg" },
    { id:"debt-covenant-breach",        item:"Debt Covenant Breach FY2022 + Revolver Stress", type:"Debt & Leverage", amount:"$3.03M", finding:"Net Debt/EBITDA 5.98x in FY2022 breached 5.0x covenant. Revolver usage up 138% over 3 years. Emergency $300K draw in December 2024 to cover operations.", severity:"red", confidence:97, confidenceReasoning:"Debt schedule explicitly states covenant non-compliance in FY2022. Cash flow statement confirms December revolver draw pattern.", needsReview:true, recommendation:"Obtain waiver documentation; review Change of Control provisions in credit agreement; model post-close debt refinancing" },
    { id:"tax-nexus-michigan",          item:"Michigan Tax Nexus Exposure — Unresolved", type:"Tax", amount:"$80.0K", finding:"Michigan nexus under review; retroactive exposure $45K–$80K plus penalties and interest for FY2022–2024. Minnesota may also trigger economic nexus threshold. Not disclosed in diligence package.", severity:"red", confidence:84, confidenceReasoning:"Tax return summary explicitly states Michigan is under review. Minnesota sales ($68K) are close to nexus threshold.", needsReview:true, recommendation:"Require pre-close legal opinion from state tax counsel; seek representations, indemnities, and escrow holdback for full estimated exposure" },
    // ── YELLOW: Operational & Structural ────────────────────────────────────
    { id:"midwest-steel-single-source", item:"Midwest Steel — Single-Source, No Contract, +10-14% Quoted", type:"Vendor Risk", amount:"$648.0K", finding:"Sole approved supplier for primary raw material (30% of COGS); no long-term contract; 10–14% price increase quoted for FY2025. No alternative qualified. Qualification timeline: 3–6 months.", severity:"yellow", confidence:88, confidenceReasoning:"Vendor concentration file explicitly states single-source status. AP aging shows $327K balance with current/31-60 day aging suggesting active relationship.", needsReview:true, recommendation:"Initiate backup supplier qualification immediately; negotiate 12-month supply agreement with price cap as a close condition" },
    { id:"inventory-dio-elevated",      item:"Inventory DIO 93 Days — Legacy Series 8+ Months on Hand", type:"Inventory", amount:"$976.0K", finding:"DIO of 92.9 days vs. 65-75 benchmark; Legacy Series has 8.4 months on hand with declining margins (20%). Obsolescence reserve up 71% YoY. Warehouse leases month-to-month with 15-20% rate increase anticipated.", severity:"yellow", confidence:86, confidenceReasoning:"Inventory schedule provides DIO calculation and finished goods aging by product line. Benchmark stated in document.", needsReview:true, recommendation:"Require Legacy Series sunset plan and markdown schedule; negotiate inventory peg in purchase agreement; audit warehouse contract renewals" },
    { id:"capex-erp-overrun",           item:"ERP Implementation — 35% Over Budget, 35% Remaining", type:"CapEx & Fixed Assets", amount:"$224.0K", finding:"ERP project ($210K budget → $224K spent to date + $75K–$120K remaining) is 35% over budget with 35% of work left; total projected cost $300K+. R&D lab cancellation ($38K written off) adds to execution concerns.", severity:"yellow", confidence:82, confidenceReasoning:"CapEx schedule details both the ERP overrun and cancelled R&D lab with sunk costs explicitly stated.", needsReview:true, recommendation:"Obtain independent project completion assessment; cap seller obligation for remaining ERP costs; ensure training and go-live are complete pre-close" },
    { id:"workers-comp-mod",            item:"Workers' Comp Mod Factor 1.18 — 14 Recordable Incidents", type:"Insurance & Risk", amount:"$80.5K", finding:"Mod factor of 1.18 vs. 1.00 baseline; 14 recordable incidents over 3 years including 3 lost-time injuries; annual safety training overdue. Excess premiums ~$12K/yr.", severity:"yellow", confidence:83, confidenceReasoning:"Insurance schedule explicitly states mod factor, incident count, and last safety training date.", needsReview:true, recommendation:"Request 5-year loss runs; conduct safety culture assessment; model insurance cost trajectory; require safety training completion pre-close" },
    { id:"contractor-growth",           item:"1099 Contractor Spend Up 191% — Misclassification Risk", type:"Contractors", amount:"$268.0K", finding:"Quarterly 1099 spend up 191% over 2 years; annualized ~$1.1M; all contractor engagements approved by CEO's son (VP Sales). No formal misclassification review conducted.", severity:"yellow", confidence:84, confidenceReasoning:"Employee census shows contractor headcount trend clearly. All approval signatures are R. Anderson per GL entries.", needsReview:true, recommendation:"Conduct IRS worker classification audit prior to close; identify business-critical contractors; assess cost of converting to employees" },
    { id:"rd-spike",                    item:"R&D Expense +158% Over 3 Years — Cancelled Project", type:"SG&A", amount:"$310.8K", finding:"R&D grew from $120K to $311K (+158%). One active project cancelled in Q3 2024 with $38K sunk costs. ERP capitalization policies require independent review.", severity:"yellow", confidence:79, confidenceReasoning:"R&D schedule cross-confirmed with income statement. Cancelled project and remaining active projects clearly documented.", needsReview:true, recommendation:"Assess recurring vs. development R&D; confirm capitalization policy compliance with GAAP; validate ROI assumptions on active projects" },
    { id:"deferred-rev-swing",          item:"Deferred Revenue Q3 Spike ($312K) — Recognition Timing", type:"Revenue Recognition", amount:"$166.0K", finding:"Deferred revenue peaked at $312K in September before year-end balance of $166K — $146K recognized in Q4 alone. Revenue timing may be pulled forward to hit year-end targets.", severity:"yellow", confidence:76, confidenceReasoning:"Monthly revenue recognition schedule shows unusual September peak followed by accelerated Q4 recognition.", needsReview:true, recommendation:"Tie deferred revenue to specific contracts; review revenue recognition policy for compliance with ASC 606" },
    // ── GREEN: Genuine Strengths ─────────────────────────────────────────────
    { id:"total-revenue-growth",        item:"Revenue Growth — $4.75M to $6.41M (+35%)", type:"Revenue", amount:"$6.41M", finding:"Consistent top-line growth across 3 years. Active customer count grew from 42 to 74. No restatements noted.", severity:"green", confidence:93, needsReview:false, confidenceReasoning:"Multi-year trend confirmed across income statement and customer concentration file.", recommendation:"Confirm organic vs. acquired growth; validate customer pipeline health" },
    { id:"service-revenue-growth",      item:"Service & Maintenance Revenue — 76% Gross Margin, +68% Growth", type:"Revenue", amount:"$520.0K", finding:"Highest-quality revenue segment: 76% gross margin, $520K in FY2024 (up from $310K), driven by installed base expansion. Best predictor of recurring free cash flow.", severity:"green", confidence:91, needsReview:false, confidenceReasoning:"Gross margin by product line confirms 76% margin. Revenue recognition schedule shows steady monthly service billings.", recommendation:"Assess contracted vs. time-and-materials mix; model service attach rate as installed base grows" },
    { id:"multi-year-contracts",        item:"Multi-Year MSAs with Top 2 Customers", type:"Revenue", amount:"$1.67M", finding:"Acme Retail Group ($1.18M, MSA through June 2026) and Great Lakes Industrial ($490K, MSA through March 2027) are on auto-renewing contracts with 60–90 day notice periods.", severity:"green", confidence:89, needsReview:false, confidenceReasoning:"Contract status confirmed in customer concentration schedule.", recommendation:"Obtain copies of MSAs; confirm change of control provisions do not trigger automatic termination" },
    { id:"net-fixed-assets",            item:"Net PP&E — $2.39M, Consistent Investment", type:"CapEx & Fixed Assets", amount:"$2.39M", finding:"Net fixed assets growing steadily. CapEx/D&A of 1.66x reflects reinvestment in growth capacity. New CNC machining center adds production capacity.", severity:"green", confidence:82, needsReview:false, confidenceReasoning:"Balance sheet and CapEx schedule cross-confirmed. New equipment additions documented.", recommendation:"Confirm remaining useful life and maintenance requirements of key production equipment" },
    // ── Additional Red: Balance Sheet Items ─────────────────────────────────
    { id:"goodwill-impairment-risk",    item:"Goodwill Impairment Risk — $420K Unamortized", type:"Balance Sheet", amount:"$420.0K", finding:"$420K in goodwill on balance sheet from 2021 bolt-on acquisition never formally impairment-tested; acquired entity underperformed projections by 38% in first two years.", severity:"red", confidence:87, confidenceReasoning:"Balance sheet line item cross-referenced with GL history and CapEx schedule acquisition notes.", needsReview:true, recommendation:"Require independent impairment analysis; consider escrow or purchase price reduction equal to unrecovered amount" },
    { id:"deferred-tax-liability",      item:"Deferred Tax Liability — $198K Timing Reversal Risk", type:"Tax", amount:"$198.0K", finding:"Deferred tax liability of $198K driven by accelerated depreciation on equipment; will reverse FY2025–2026 and reduce reported income by ~$65K/yr for 3 years without operational improvement.", severity:"red", confidence:85, confidenceReasoning:"Tax return summary includes deferred tax schedule. Reversal timeline calculated from asset depreciation schedules.", needsReview:true, recommendation:"Model deferred tax reversals into normalized earnings; factor into post-close cash tax rate projections" },
    { id:"long-term-facility-lease",    item:"Facility Lease Renewal — 18% Rate Increase Quoted", type:"Real Estate / Leases", amount:"$156.0K", finding:"Current facility lease expires September 2025. Landlord has quoted 18% rent increase ($156K/yr → $184K/yr). Month-to-month exposure if deal closes before renewal is executed.", severity:"red", confidence:88, confidenceReasoning:"Insurance schedule notes lease expiry. Email from CEO confirms landlord quote. No executed renewal as of analysis date.", needsReview:true, recommendation:"Require executed lease extension as a close condition; cap escalation clause in purchase agreement" },
    { id:"accounts-payable-vendor",     item:"Vendor AP Concentration — 3 Vendors = 68% of AP", type:"Accounts Payable", amount:"$427.0K", finding:"Three vendors (Midwest Steel, National Alloys, Precision Tooling) account for 68% of total AP balance. AP with National Alloys ($88K) is 90+ days past due; risk of supply disruption.", severity:"red", confidence:91, confidenceReasoning:"AP aging schedule clearly shows vendor concentration and 90+ day aging for National Alloys.", needsReview:true, recommendation:"Obtain payoff confirmation from National Alloys; model working capital normalization in purchase price" },
    { id:"insurance-claims-history",    item:"General Liability Claims — 3 Open Claims $240K Exposure", type:"Insurance & Risk", amount:"$240.0K", finding:"3 open general liability claims with combined stated value of $240K. One claim (slip-and-fall at customer site) is in active litigation. Claims not reflected in balance sheet accruals.", severity:"red", confidence:84, confidenceReasoning:"Insurance schedule lists open claims with claim numbers and attorney names. No corresponding balance sheet accrual found.", needsReview:true, recommendation:"Require legal reserve for all open claims; seek representations and indemnities; consider escrow holdback" },
    // ── Additional Yellow: Operational ──────────────────────────────────────
    { id:"it-infrastructure-aging",     item:"IT Infrastructure — Servers End-of-Life Q2 2025", type:"Technology", amount:"$85.0K", finding:"Primary production server and backup storage both reach end-of-life in Q2 2025. IT team estimates $85K replacement cost. No budget approved. Failure risk during ERP transition period.", severity:"yellow", confidence:80, confidenceReasoning:"CapEx schedule lacks IT replacement budget. Server end-of-life dates sourced from asset register in CapEx schedule.", needsReview:true, recommendation:"Require capital plan for IT refresh; negotiate seller obligation to fund pre-close or adjust purchase price" },
    { id:"employee-turnover-elevated",  item:"Employee Turnover 34% — 3 Key Engineers Departed", type:"Human Capital", amount:"N/A", finding:"Annual voluntary turnover reached 34% in FY2024 vs. 18% in FY2022. 3 of 7 senior engineers departed in the last 18 months; two joined a direct competitor. No non-solicit agreements in place.", severity:"yellow", confidence:82, confidenceReasoning:"Employee census shows headcount by tenure. Three senior engineer departures confirmed with hire dates and separation dates.", needsReview:true, recommendation:"Require retention agreements for top 5 technical staff; include non-solicit clause in purchase agreement" },
    { id:"customer-contract-auto-renew", item:"Acme Retail Group — Auto-Renew Opt-Out Window Opens Apr 2025", type:"Revenue", amount:"$1.18M", finding:"Acme Retail Group MSA ($1.18M annual) auto-renews June 2026 but opt-out notice window opens April 2025. If notice is sent in April, revenue would terminate June 2025 — before close.", severity:"yellow", confidence:83, confidenceReasoning:"Contract status column in customer concentration file states notice period and renewal date. Timeline risk calculated from projected close date.", needsReview:true, recommendation:"Obtain written confirmation from Acme Retail that they will not exercise opt-out; include customer retention covenant" },
    { id:"warranty-reserve-change",     item:"Warranty Reserve — 42% Reduction FY2024, Claims Up 18%", type:"EBITDA Adj", amount:"$47.0K", finding:"Warranty reserve was reduced by $47K in FY2024 (improving reported earnings) while actual warranty claims increased 18% YoY. Reserve methodology appears inconsistent with claim experience.", severity:"yellow", confidence:79, confidenceReasoning:"GL confirms $47K reserve reduction entry in Q4 FY2024. Warranty claims data from insurance schedule shows 18% increase.", needsReview:true, recommendation:"Normalize warranty reserve to 3-year claim average; addback reserve reduction to arrive at sustainable EBITDA" },
    { id:"sales-commission-structure",  item:"VP Sales Commission Renegotiated — $62K Upside Liability", type:"EBITDA Adj", amount:"$62.0K", finding:"VP Sales (CEO's son) commission structure was revised in FY2024 to include a 3% retroactive override on all existing accounts. FY2025 liability is estimated at $62K above FY2024 run rate.", severity:"yellow", confidence:77, confidenceReasoning:"Employee census notes commission plan revision. EBITDA schedule does not normalize for forward commission ramp.", needsReview:true, recommendation:"Normalize compensation to market-rate plan; include in normalized EBITDA calculation" },
    { id:"insurance-benefits-spike",    item:"Employee Benefits Cost +29% YoY — Plan Change Mid-Year", type:"SG&A", amount:"$184.0K", finding:"Health insurance and benefits costs jumped 29% in FY2024 partly due to mid-year plan switch (higher deductible, higher premium tier) after a large claims year. Trend unsustainable without employee contribution changes.", severity:"yellow", confidence:76, confidenceReasoning:"Insurance & benefits schedule shows premium breakdown by plan year and employee contributions.", needsReview:true, recommendation:"Model benefits cost on new plan at full year; assess cost-sharing feasibility with post-close workforce" },
    { id:"marketing-channel-shift",     item:"Trade Show Budget Cut 60% — Lead Pipeline Impact", type:"SG&A", amount:"$78.0K", finding:"Trade show and marketing conference budget cut from $78K to $31K in FY2024 as cash conservation measure. 3 previously top-producing shows (FABTECH, MFG Summit, MSC Industrial) skipped. Pipeline lag typically 6–12 months.", severity:"yellow", confidence:74, confidenceReasoning:"GL confirms marketing line reduction. CEO email references show cancellations. Pipeline data from customer concentration file shows 22% fewer new logos FY2024.", needsReview:true, recommendation:"Assess pipeline impact in context of FY2025 revenue projections; model marketing investment reinstatement" },
    // ── Additional Green: Genuine Positives ──────────────────────────────────
    { id:"service-margin-expansion",    item:"Premium Series Pricing Power — 2.2% Net Price Increase FY2024", type:"Revenue", amount:"$141.0K", finding:"Premium Series average selling price increased 2.2% in FY2024 without volume loss, contributing ~$141K in additional gross margin. Customer retention on this product line is 94%.", severity:"green", confidence:88, needsReview:false, confidenceReasoning:"Revenue recognition schedule shows ASP trend by product line. Retention calculated from customer concentration file.", recommendation:"Expand pricing analysis to test further headroom; evaluate bundling with service contracts" },
    { id:"great-lakes-contract",        item:"Great Lakes Industrial Contract Renewed Early Through 2027", type:"Revenue", amount:"$490.0K", finding:"Great Lakes Industrial executed an early renewal for 3-year MSA through March 2027 at a 4.1% rate increase. Contract includes minimum purchase commitments of $420K/yr.", severity:"green", confidence:93, needsReview:false, confidenceReasoning:"Customer concentration file confirms renewal date and terms. Minimum commitment clause stated explicitly.", recommendation:"Confirm assignment clause in purchase agreement; ensure no change-of-control termination right" },
    { id:"service-contract-attach-rate", item:"Service Contract Attach Rate Improved to 72%", type:"Revenue", amount:"N/A", finding:"72% of new equipment sales now include a multi-year service contract (up from 54% in FY2022). Service revenue is the highest-margin segment and provides recurring, predictable cash flow.", severity:"green", confidence:87, needsReview:false, confidenceReasoning:"Revenue recognition schedule tracks attach rate by customer cohort.", recommendation:"Document sales process for service contract bundling; protect attach rate in transition plan" },
    { id:"cogs-sourcing-initiative",    item:"Domestic Sourcing Initiative — $94K Annualized COGS Reduction", type:"COGS & Margin", amount:"$94.0K", finding:"Procurement team successfully qualified two domestic component suppliers in FY2024, replacing higher-cost overseas components. Annualized COGS savings of $94K projected at full run-rate.", severity:"green", confidence:84, needsReview:false, confidenceReasoning:"Vendor concentration file shows new domestic vendors with pricing. AP aging confirms active orders placed.", recommendation:"Confirm savings are captured in forward EBITDA projections; assess qualification status of additional domestic alternatives" },
    { id:"ar-collections-improvement",  item:"AR Collections Process — DSO Improved 8 Days on Core Accounts", type:"Accounts Receivable", amount:"N/A", finding:"Dedicated AR collections process implemented in Q2 FY2024 reduced DSO on core (non-Pacific Trading) AR by 8 days. 23 accounts moved from 60+ days to current status during the year.", severity:"green", confidence:81, needsReview:false, confidenceReasoning:"AR aging schedule shows period-over-period improvement on non-Pacific Trading accounts.", recommendation:"Assess whether collections improvement is sustainable; include in working capital normalization analysis" },
    { id:"inventory-management",        item:"Demand Planning System — 15% Reduction in Stockouts FY2024", type:"Inventory", amount:"N/A", finding:"Implementation of basic demand planning (Excel-based with weekly review) reduced stockout incidents from 47 to 40 in FY2024. Customer satisfaction scores improved 12 points.", severity:"green", confidence:79, needsReview:false, confidenceReasoning:"Inventory schedule shows stockout count by quarter. Customer satisfaction metric referenced in CEO commentary.", recommendation:"Assess whether ERP implementation will formalize and improve demand planning further" },
    { id:"payroll-compliance",          item:"Payroll Tax Compliance — No Material Issues FY2022–2024", type:"Tax", amount:"N/A", finding:"Federal and state payroll tax filings are current with no material penalties or assessments noted in tax return summary for the three-year review period.", severity:"green", confidence:90, needsReview:false, confidenceReasoning:"Tax return summary confirms no payroll tax issues. GL shows timely remittance of withholding taxes.", recommendation:"Standard diligence verification; no specific action required" },
    { id:"banking-relationship",        item:"Primary Bank Relationship — 12-Year History, No Defaults", type:"Debt & Leverage", amount:"N/A", finding:"12-year relationship with First National Midwest. No formal defaults outside of the FY2022 covenant breach (waived in writing). Bank has expressed verbal interest in supporting a qualified buyer with assumption or refinancing.", severity:"green", confidence:85, needsReview:false, confidenceReasoning:"Debt schedule lists loan history. CEO confirmed bank relationship and change of control stance in management Q&A notes.", recommendation:"Obtain written bank consent to assignment; explore refinancing terms in parallel with deal timeline" }
  ],
  _meta: {
    filesProcessed: 18, totalTransactions: 487,
    tokenUsage: { inputTokens: 24840, outputTokens: 9180, totalTokens: 34020 },
    parsedAt: "2024-01-15T18:29:41.000Z", isDemo: true
  }
};

function loadDemo() {
  // Always use hardcoded demo — zero API calls, instant, permanent
  _exportTriggered = false;
  document.getElementById('export-ready-banner')?.remove();
  report = DEMO_REPORT;
  finishReport();
  showDemoBanner();
}

function showDemoBanner() {
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.style.cssText = `
    position:fixed;bottom:0;left:220px;right:0;z-index:100;
    background:var(--ink1);border-top:1px solid var(--teal-mid);
    padding:9px 20px;display:flex;align-items:center;gap:12px;
    font-family:var(--mono);font-size:11px;color:var(--dim);
  `;
  bar.innerHTML = `
    <span style="color:var(--teal)">◆ DEMO</span>
    <span>Showing sample QoE analysis — Acme Manufacturing Inc. (18 files, FY2022–2024)</span>
    <button onclick="document.getElementById('demo-bar').remove();resetAll();" style="margin-left:auto;background:var(--teal);color:var(--ink);border:none;border-radius:4px;padding:4px 10px;font-family:var(--mono);font-size:11px;font-weight:600;cursor:pointer;">Upload your own files →</button>
  `;
  document.body.appendChild(bar);
}

// ═══════════════════════════════════
// TERMS & CONDITIONS
// ═══════════════════════════════════
const TERMS_KEY = 'ledgeriq_terms_accepted_v1';

function hasAcceptedTerms() {
  try { return !!localStorage.getItem(TERMS_KEY); } catch { return false; }
}

function acceptTerms() {
  try { localStorage.setItem(TERMS_KEY, '1'); } catch {}
  document.getElementById('page-terms-gate')?.remove();
  enterApp();
}

// ═══════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════
function enterApp() {
  const landing = document.getElementById('page-landing');
  if (!landing) return;
  landing.classList.add('exit');
  landing.addEventListener('animationend', () => {
    landing.style.display = 'none';
  }, { once: true });
}

function animateLandingBars() {
  document.querySelectorAll('.ld-cat-fill').forEach((el, i) => {
    setTimeout(() => el.classList.add('animated'), 400 + i * 120);
  });
}

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  const enterBtn = document.getElementById('ld-enter-btn');
  if (enterBtn) {
    enterBtn.addEventListener('click', () => {
      if (hasAcceptedTerms()) {
        enterApp();
      } else {
        showTermsGate();
      }
    });
  }

  setTimeout(animateLandingBars, 600);

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
  loadDemo();
});

// ═══════════════════════════════════
// TERMS GATE — full-screen overlay
// ═══════════════════════════════════
function showTermsGate() {
  if (document.getElementById('page-terms-gate')) return;

  const gate = document.createElement('div');
  gate.id = 'page-terms-gate';
  gate.innerHTML = `
<div style="
  position:fixed;inset:0;z-index:19999;
  background:rgba(6,10,20,.97);backdrop-filter:blur(12px);
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  overflow-y:auto;padding:40px 16px 60px;
">
  <div style="max-width:700px;width:100%;">
    <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#0CCED4;letter-spacing:.12em;margin-bottom:8px;">LEDGERIQ · LEGAL</div>
    <h1 style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#E8EDF6;letter-spacing:-.03em;margin-bottom:4px;">Terms & Conditions</h1>
    <p style="font-size:12px;color:#6B7FA0;margin-bottom:28px;">Last updated: January 1, 2025. Please read these terms before using LedgerIQ.</p>

    <div id="terms-scroll" style="
      background:#0C1220;border:1px solid #1D2D44;border-radius:8px;
      padding:28px 32px;max-height:52vh;overflow-y:auto;
      font-size:13px;line-height:1.75;color:#C2CEDF;
      scrollbar-width:thin;
    ">
      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:0 0 12px;">1. Acceptance of Terms</h2>
      <p>By accessing or using LedgerIQ (the "Platform"), you agree to be bound by these Terms and Conditions ("Terms"). If you do not agree to these Terms, do not use the Platform. These Terms constitute a legally binding agreement between you ("User") and Henry Long, the creator and operator of LedgerIQ ("Operator").</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">2. Description of Service</h2>
      <p>LedgerIQ is an AI-assisted Quality of Earnings (QoE) analysis platform designed to assist financial professionals, M&amp;A deal teams, and other qualified users in reviewing financial documents. The Platform uses large language models (GPT-4o mini by OpenAI) to parse, classify, and score financial data provided by Users. The Platform generates automated reports, flags potential irregularities, and provides confidence scores, narratives, and summaries.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">3. No Professional or Financial Advice</h2>
      <p><strong style="color:#E8EDF6;">IMPORTANT: LedgerIQ does not provide professional financial, accounting, legal, tax, or investment advice.</strong> All output generated by the Platform — including QoE scores, grades, flags, narratives, confidence ratings, and recommendations — is <em>automated and informational only</em>. It is not a substitute for professional judgment exercised by a licensed CPA, financial advisor, attorney, or other qualified professional.</p>
      <p style="margin-top:10px;">No output from LedgerIQ should be relied upon as the sole basis for any financial decision, investment, acquisition, divestiture, loan, or other material business action. Users are solely responsible for independently verifying all findings and consulting appropriate licensed professionals before making any decisions.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">4. AI Limitations and Accuracy</h2>
      <p>The Platform relies on artificial intelligence and machine learning models that are inherently imperfect. Output may be inaccurate, incomplete, misleading, or outdated. LedgerIQ makes no representations or warranties regarding the accuracy, completeness, or fitness for any particular purpose of any AI-generated content. The Operator expressly disclaims all liability for errors, omissions, or inaccuracies in AI-generated output.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">5. User Responsibilities</h2>
      <p>You represent and warrant that: (a) you are at least 18 years of age and have the legal capacity to enter into these Terms; (b) any financial documents you upload are owned by you or you have the lawful right to upload them; (c) you will not upload documents containing personally identifiable information of third parties without their consent; (d) you will use the Platform only for lawful purposes and in compliance with all applicable laws and regulations; (e) you will not attempt to reverse-engineer, exploit, or circumvent any security measures of the Platform.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">6. Data and Privacy</h2>
      <p>Files you upload to LedgerIQ are transmitted to our backend servers and to OpenAI's API for processing. By uploading documents, you consent to this processing. We do not permanently store your uploaded documents or analysis reports beyond the duration of your session. We do not sell your data to third parties. However, OpenAI may retain API inputs in accordance with their own privacy policy, which you should review at openai.com/policies/privacy-policy.</p>
      <p style="margin-top:10px;">LedgerIQ uses browser localStorage to store your session preferences (including your acceptance of these Terms and cached demo data). No account is required to use the Platform, and no personal information is collected beyond what is inherent in your use of the service.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">7. Confidential Information</h2>
      <p>You acknowledge that financial documents uploaded to the Platform may contain confidential, proprietary, or sensitive business information. You assume all risk associated with uploading such documents. The Operator takes reasonable technical precautions but cannot guarantee absolute confidentiality. Do not upload documents subject to attorney-client privilege, regulatory confidentiality orders, or other legally protected restrictions without consulting qualified counsel.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">8. Intellectual Property</h2>
      <p>All software, design, code, branding, and proprietary content of LedgerIQ are owned by Henry Long and protected by applicable intellectual property laws. You are granted a limited, non-exclusive, non-transferable license to use the Platform solely for your personal or internal business purposes. You may not copy, reproduce, distribute, or create derivative works of any part of the Platform without express written permission.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">9. Disclaimer of Warranties</h2>
      <p>THE PLATFORM IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT ANY WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR UNINTERRUPTED, ERROR-FREE OPERATION. THE OPERATOR DOES NOT WARRANT THAT THE PLATFORM WILL MEET YOUR REQUIREMENTS OR THAT ANY ERRORS WILL BE CORRECTED.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">10. Limitation of Liability</h2>
      <p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE OPERATOR SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, REVENUE, DATA, BUSINESS OPPORTUNITY, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE PLATFORM, EVEN IF THE OPERATOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. IN NO EVENT SHALL THE OPERATOR'S TOTAL LIABILITY EXCEED ONE HUNDRED DOLLARS ($100).</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">11. Indemnification</h2>
      <p>You agree to indemnify, defend, and hold harmless the Operator and any affiliates, officers, directors, employees, or agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable attorneys' fees) arising out of or in any way connected with your use of the Platform, your violation of these Terms, or your violation of any third-party rights.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">12. Modifications to Terms</h2>
      <p>The Operator reserves the right to modify these Terms at any time. Changes will be effective upon posting to the Platform. Your continued use of the Platform following any modifications constitutes your acceptance of the revised Terms. It is your responsibility to review these Terms periodically.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">13. Termination</h2>
      <p>The Operator reserves the right to suspend or terminate access to the Platform at any time, with or without cause, and with or without notice. Upon termination, your right to use the Platform ceases immediately.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">14. Governing Law</h2>
      <p>These Terms shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law provisions. Any dispute arising under these Terms shall be resolved exclusively in the state or federal courts located in Delaware.</p>

      <h2 style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:#E8EDF6;margin:20px 0 12px;">15. Entire Agreement</h2>
      <p>These Terms constitute the entire agreement between you and the Operator regarding your use of the Platform and supersede all prior agreements and understandings. If any provision of these Terms is held to be invalid or unenforceable, the remaining provisions will continue in full force and effect.</p>

      <p style="margin-top:24px;padding-top:16px;border-top:1px solid #1D2D44;font-size:11px;color:#445572;">
        Questions about these Terms? Contact us at <a href="mailto:ledgeriq@henrylong.dev" style="color:#0CCED4;text-decoration:none;">ledgeriq@henrylong.dev</a>
      </p>
    </div>

    <div style="margin-top:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;color:#C2CEDF;user-select:none;">
        <input type="checkbox" id="terms-chk" style="width:16px;height:16px;accent-color:#0CCED4;cursor:pointer;"
          onchange="document.getElementById('terms-accept-btn').disabled=!this.checked">
        I have read and agree to the Terms &amp; Conditions
      </label>
    </div>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
      <button id="terms-accept-btn" disabled
        onclick="acceptTerms()"
        style="
          padding:12px 32px;border-radius:6px;border:none;
          background:#0CCED4;color:#060A14;
          font-family:'Syne',sans-serif;font-size:14px;font-weight:700;
          cursor:pointer;opacity:1;transition:opacity .15s;
        "
        onmouseover="if(!this.disabled)this.style.filter='brightness(1.1)'"
        onmouseout="this.style.filter=''"
      >Accept &amp; Enter Platform</button>
      <button onclick="document.getElementById('page-terms-gate').remove()"
        style="padding:12px 20px;border-radius:6px;border:1px solid #1D2D44;background:transparent;color:#6B7FA0;font-size:13px;cursor:pointer;">
        Cancel
      </button>
    </div>
    <p style="margin-top:12px;font-size:11px;color:#445572;">Your acceptance is stored in your browser. You will not be asked again on this device.</p>
  </div>
</div>`;

  // Disable accept button initially (checkbox unchecked)
  document.body.appendChild(gate);
  const btn = document.getElementById('terms-accept-btn');
  if (btn) btn.disabled = true;
}
