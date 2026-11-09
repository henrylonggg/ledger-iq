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

  document.getElementById('k-score').textContent = adjScore;
  document.getElementById('ring-num').textContent = adjScore;
  const arcColor = adjScore >= 70 ? 'var(--emerald)' : adjScore >= 45 ? 'var(--amber)' : 'var(--crimson)';
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

  // Ring arc (r=50, circumference=314)
  document.getElementById('ring-num').textContent = score;
  const arc = document.getElementById('score-arc');
  const arcColor = score >= 70 ? 'var(--emerald)' : score >= 45 ? 'var(--amber)' : 'var(--crimson)';
  arc.style.stroke = arcColor;
  setTimeout(() => { arc.style.strokeDashoffset = 314 - (score / 100) * 314; }, 200);
  const gradeEl = document.getElementById('ring-grade');
  if (gradeEl) { gradeEl.textContent = r.grade || ''; gradeEl.style.color = arcColor; }

  const g = r.grade || '';
  document.getElementById('k-score').style.color = g.startsWith('A') ? 'var(--emerald)' : g.startsWith('B') ? 'var(--teal)' : g.startsWith('C') ? 'var(--amber)' : 'var(--crimson)';

  // Categories
  document.getElementById('cat-stack').innerHTML = (r.categories || []).map(c => {
    const col = c.color === 'green' ? 'var(--emerald)' : c.color === 'red' ? 'var(--crimson)' : 'var(--amber)';
    const sc = c.score || 0;
    return `<div class="cat-row">
      <div class="cat-badge" style="background:${col};box-shadow:0 0 6px ${col}44"></div>
      <span class="cat-name">${esc(c.name)}</span>
      <div class="cat-track"><div class="cat-fill" style="width:${sc}%;background:${col}"></div></div>
      <span class="cat-num" style="color:${col}">${sc}</span>
    </div>`;
  }).join('');

  // Flags
  document.getElementById('flags-box').innerHTML = (r.flags || []).map(f => `
    <div class="flag ${f.severity || 'yellow'}">
      <div><span class="flag-title">${esc(f.title || '')}</span><span class="flag-detail">${esc(f.detail || '')}</span></div>
    </div>`).join('');

  // Data scope + narrative
  if (r.dataScope) {
    document.getElementById('dash-narrative').innerHTML =
      `<p style="font-family:var(--mono);font-size:10.5px;color:var(--teal);margin-bottom:10px;border-left:2px solid var(--teal);padding-left:8px">${esc(r.dataScope)}</p>`;
  }
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
    ws1.getCell(`E${scoreRow.number}`).value = 'GRADE';
    ws1.getCell(`E${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + C.muted } };
    ws1.getCell(`F${scoreRow.number}`).value = r.grade || '—';
    ws1.getCell(`F${scoreRow.number}`).font  = { name: 'Calibri', bold: true, size: 20, color: { argb: 'FF' + scoreColor } };
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
    const totRow = ws5.addRow(['OVERALL QoE SCORE', r.score, r.grade]);
    totRow.height = 24;
    totRow.getCell(1).font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FF' + C.teal } };
    totRow.getCell(2).font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + scoreColor } };
    totRow.getCell(3).font = { name: 'Calibri', bold: true, size: 14, color: { argb: 'FF' + scoreColor } };
    [1,2,3].forEach(ci => totRow.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.navy3 } });

    ws5.getColumn(1).width = 36; ws5.getColumn(2).width = 10; ws5.getColumn(3).width = 12;

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
// DEMO — always uses hardcoded data, zero API calls
// ═══════════════════════════════════
const DEMO_REPORT = {
  score: 52, grade: "C+",
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
    { severity:"red",    title:"Related Party Transactions",          detail:"Management fees of $240K/yr paid to an undisclosed related entity, plus a $500K shareholder loan at 0% interest and a $250K note to Anderson Family LLC at below-market 2% rate." },
    { severity:"red",    title:"EBITDA Addbacks = 100% of Reported EBITDA", detail:"Adjusted EBITDA of $1.70M vs. reported EBITDA of $847K — total addbacks ($851K) nearly equal reported earnings, requiring independent verification of each item." },
    { severity:"red",    title:"AR Aging Deterioration",              detail:"DSO increased from 44 to 56 days (+27%) YoY. 15.6% of receivables are over 90 days past due. Three customers show significant overdue balances." },
    { severity:"red",    title:"Family Payroll — Three Officers",     detail:"CEO (J. Anderson), spouse (M. Anderson, COO), and son (R. Anderson, VP Sales) collectively draw $280K/yr. Market-rate adjustment of ~$120K is included in addbacks." },
    { severity:"red",    title:"Debt Covenant Breach in FY2022",      detail:"Net Debt/EBITDA of 5.98x exceeded the 5.0x covenant maximum in FY2022. Company has since improved to 4.36x but lender relationship and waiver terms require review." },
    { severity:"yellow", title:"Contractor Headcount Up 3x",          detail:"Independent contractors grew from 8 to 24 over 8 quarters (+200%). Annualized 1099 spend reached ~$1.1M. Misclassification risk and dependency on non-employee labor warrant review." },
    { severity:"yellow", title:"Lumpy Project Revenue",               detail:"One-time project revenue of $830K (38% of total) is non-recurring. Recurring subscription revenue of $1.36M is the more reliable base for forward projections." },
    { severity:"yellow", title:"Negative Retained Earnings",          detail:"Accumulated deficit of $(1.19M) on the balance sheet. Equity is negative at $(1.09M), though improving from $(2.26M) in FY2022." },
    { severity:"green",  title:"Revenue Growth Trend",                detail:"Total revenue grew from $4.75M to $6.41M (+35%) over 3 years. Recurring subscription revenue is stable and growing." }
  ],
  narrative: "Acme Manufacturing Inc. presents a mixed quality of earnings picture that warrants elevated diligence scrutiny, particularly around EBITDA normalization, related-party arrangements, and working capital trends.\n\nThe most significant concern is the magnitude of management EBITDA adjustments relative to reported earnings. Total addbacks of $851K in FY2024 nearly equal the reported EBITDA of $847K, implying that virtually all reported earnings require normalization. While some adjustments appear legitimate (one-time legal settlement, restructuring costs), others — particularly the $240K related-party management fee and $51K of personal expenses — raise questions about the arm's-length nature of transactions.\n\nRelated-party transactions represent a systemic risk. Beyond the management fee, the company carries a $500K shareholder loan at 0% interest and a $250K note payable to Anderson Family LLC at a below-market 2% rate. These arrangements obscure true cash flows and require independent valuation of economic terms.\n\nAccounts receivable quality has deteriorated meaningfully. DSO increased 27% year-over-year to 56 days, and 15.6% of the AR balance is over 90 days past due. This trend, if it continues, could signal customer credit stress or collection process weakness.\n\nOn the positive side, the company demonstrates consistent top-line growth (35% over three years) with stable gross margins around 45–46%. The recurring subscription revenue base of $1.36M provides a reliable foundation, though deal teams should discount the $830K in one-time project revenue for forward EBITDA projections.",
  methodology: "This analysis was performed on seven financial documents covering FY2022–FY2024: an income statement, EBITDA adjustment schedule, AR aging report, debt schedule, monthly revenue recognition detail, employee census, and balance sheet. The backend parsed and classified 147 line items; the top 80 by risk priority were submitted for AI confidence scoring.\n\nNotably absent from this package: cash flow statements, bank statements/proof of cash, general ledger or trial balance detail, tax returns, accounts payable aging, and inventory detail. All findings should be validated against primary source documents and confirmed through management interviews.",
  transactions: [
    { id:"rel-party-mgmt-fee",     item:"Related Party Management Fees",             type:"Related Party",      amount:"$240.0K", finding:"Non-arm's-length fee paid to undisclosed affiliate; reduces reported EBITDA by $240K annually",           severity:"red",    confidence:92, confidenceReasoning:"Explicitly labeled as related party in source document with consistent 3-year pattern.",              needsReview:true,  recommendation:"Obtain underlying agreement, confirm market rate, verify recipient entity ownership" },
    { id:"owner-comp-ceo",         item:"Owner Compensation - CEO",                  type:"Owner Compensation",  amount:"$480.0K", finding:"CEO compensation $200K above estimated $280K market rate; excess is a legitimate addback",                   severity:"red",    confidence:78, confidenceReasoning:"Market rate benchmark assumed at $280K; actual comparables needed to confirm.",                      needsReview:true,  recommendation:"Pull compensation benchmarking study for manufacturing CEO of comparable revenue" },
    { id:"adj-related-party-rent", item:"Adj: Above-Market Facility Rent (related party)", type:"Related Party", amount:"$60.0K", finding:"Facility rented from related party at $60K/yr vs $48K market; $12K excess is addback but ownership unclear", severity:"red",    confidence:71, confidenceReasoning:"Market rate assumed; actual lease and property ownership not confirmed in provided documents.",       needsReview:true,  recommendation:"Obtain lease agreement and confirm landlord entity ownership structure" },
    { id:"adj-personal-expenses",  item:"Adj: Personal Expenses Run Through Business",type:"Non-Recurring",      amount:"$51.0K", finding:"$51K of personal expenses in operating costs; addback is appropriate but pattern suggests control weakness", severity:"red",    confidence:83, confidenceReasoning:"Amount growing year-over-year ($42K→$51K) suggests systemic rather than one-time occurrence.",       needsReview:true,  recommendation:"Request GL detail to identify expense categories; assess internal control environment" },
    { id:"owner-loan-shareholder", item:"Debt: Owner Shareholder Loan - J. Anderson",type:"Debt & Leverage",     amount:"$500.0K", finding:"$500K loan from owner at 0% interest, due on demand — creates refinancing risk and hidden economic cost",   severity:"red",    confidence:95, confidenceReasoning:"Clearly stated in debt schedule with 0% rate and on-demand maturity.",                               needsReview:true,  recommendation:"Determine if loan will be repaid at close or converted to equity; impute market interest in normalization" },
    { id:"ar-pacific-trading",     item:"AR: Pacific Trading Group",                 type:"Accounts Receivable", amount:"$80.0K", finding:"$35K (44%) of balance is 90+ days past due; highest concentration risk in AR aging",                      severity:"red",    confidence:88, confidenceReasoning:"Aging buckets clearly stated in AR schedule.",                                                          needsReview:true,  recommendation:"Confirm collectability; assess whether specific reserve is warranted" },
    { id:"ar-dso-change",          item:"DSO Change",                                type:"Accounts Receivable", amount:"N/A",    finding:"DSO deteriorated 27% YoY from 44 to 56 days — meaningful working capital headwind",                        severity:"red",    confidence:94, confidenceReasoning:"Calculated directly from AR aging report data.",                                                        needsReview:true,  recommendation:"Identify root cause: new customer terms, collection issues, or revenue recognition timing" },
    { id:"debt-covenant-breach",   item:"Covenant Compliance - FY2022",              type:"Debt & Leverage",     amount:"N/A",    finding:"Net Debt/EBITDA of 5.98x breached 5.0x covenant in FY2022; waiver status and lender relationship unclear",   severity:"red",    confidence:97, confidenceReasoning:"Explicitly flagged in debt schedule as non-compliant.",                                                 needsReview:true,  recommendation:"Obtain waiver documentation and confirm current lender standing; review covenant structure at close" },
    { id:"family-payroll-coo",     item:"Payroll: M. Anderson - COO (spouse)",       type:"Payroll",             amount:"$360.0K", finding:"Spouse of CEO on executive payroll; role and market-rate compensation require independent verification",      severity:"red",    confidence:85, confidenceReasoning:"Relationship disclosed in employee census; $360K annualized above typical COO comp for company size.", needsReview:true,  recommendation:"Assess whether role is operationally necessary; obtain job description and market comp data" },
    { id:"adj-ebitda-addbacks-total", item:"Total Adjustments",                      type:"EBITDA Adj",          amount:"$851.0K", finding:"Addbacks equal 100% of reported EBITDA — buyer should independently verify each line before accepting adjusted figure", severity:"red", confidence:91, confidenceReasoning:"Sum verified against individual line items in EBITDA schedule.",                                    needsReview:true,  recommendation:"Build bottoms-up addback verification schedule; confirm with supporting invoices/documentation" },
    { id:"contractor-growth",      item:"1099 Contractor Spend",                     type:"Contractors",         amount:"$268.0K", finding:"Quarterly contractor spend up 191% over 2 years; annualized ~$1.1M raises misclassification and dependency risk", severity:"yellow", confidence:82, confidenceReasoning:"Trend clearly visible in census data; exact worker classification not confirmed.",                    needsReview:true,  recommendation:"Review contractor agreements for misclassification exposure; assess which roles are business-critical" },
    { id:"deferred-rev-swing",     item:"Ending Balance (Deferred Revenue)",         type:"Revenue Recognition", amount:"$166.0K", finding:"Deferred revenue balance fluctuated significantly mid-year (peak $312K in Sept); timing of recognition needs review", severity:"yellow", confidence:74, confidenceReasoning:"Monthly schedule shows unusual Q3 spike; underlying contract terms not available.",                 needsReview:true,  recommendation:"Tie deferred revenue balance to specific contracts; confirm recognition policy is consistent with GAAP" },
    { id:"revolver-increase",      item:"Revolving Credit Facility (drawn)",         type:"Debt & Leverage",     amount:"$950.0K", finding:"Revolver draws increased 138% from $400K to $950K over 3 years, suggesting working capital strain",             severity:"yellow", confidence:89, confidenceReasoning:"Balance trajectory clearly visible in debt schedule.",                                                   needsReview:true,  recommendation:"Analyze seasonal vs. structural revolver usage; assess headroom under credit facility" },
    { id:"rd-spike",               item:"Research & Development",                    type:"SG&A",                amount:"$310.0K", finding:"R&D expense grew 158% over 3 years ($120K→$310K); nature and capitalization policy require clarification",    severity:"yellow", confidence:76, confidenceReasoning:"Magnitude of increase is notable; whether costs are expensed or capitalized is unclear.",                 needsReview:true,  recommendation:"Request R&D project list and capitalization policy; assess recurring vs. one-time nature" },
    { id:"total-revenue-growth",   item:"Total Revenue",                             type:"Revenue",             amount:"$6.41M", finding:"Revenue grew 35% over 3 years ($4.75M→$6.41M) with stable gross margins of ~45% — positive quality signal",    severity:"green",  confidence:91, confidenceReasoning:"Multi-year trend confirmed across income statement; no restatements noted.",                             needsReview:false, recommendation:"Confirm organic vs. acquired growth; validate recurring contract base" },
    { id:"gross-margin-stable",    item:"Gross Margin %",                            type:"COGS & Margin",       amount:"45.9%",  finding:"Gross margin stable at 44–46% across all periods — indicates pricing power and consistent cost structure",        severity:"green",  confidence:88, confidenceReasoning:"Consistent across three years with minimal variance.",                                                   needsReview:false, recommendation:"No action required; validate COGS classification excludes any misallocated overhead" },
    { id:"recurring-revenue",      item:"Total Recurring Revenue",                   type:"Revenue",             amount:"$1.36M", finding:"$1.36M in recurring subscription revenue provides stable, predictable base — highest-quality revenue component", severity:"green",  confidence:86, confidenceReasoning:"Monthly revenue recognition schedule shows consistent subscription billings.",                            needsReview:false, recommendation:"Confirm contract terms and renewal rates; request customer concentration analysis" },
    { id:"net-fixed-assets",       item:"Net Fixed Assets",                          type:"CapEx & Fixed Assets",amount:"$2.39M", finding:"Net PP&E grew modestly; depreciation policy appears consistent with asset base",                              severity:"green",  confidence:79, confidenceReasoning:"Balance sheet shows steady asset additions; no unusual write-downs noted.",                             needsReview:false, recommendation:"Confirm remaining useful life of key equipment; assess CapEx requirements going forward" }
  ],
  _meta: {
    filesProcessed: 7, totalTransactions: 147,
    tokenUsage: { inputTokens: 8420, outputTokens: 4180, totalTokens: 12600 },
    parsedAt: "2024-01-15T18:29:41.000Z", isDemo: true
  }
};

function loadDemo() {
  // Always use hardcoded demo — zero API calls, instant, permanent
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
    <span>Showing sample QoE analysis — Acme Manufacturing Inc. (7 files, FY2022–2024)</span>
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
