/* ─── Return CAGR Rule Engine — frontend ────────────── */
const $ = id => document.getElementById(id);
const fmtMoney = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PERIOD_DEFS = [
  { key: '1d',  label: '1 Day' },
  { key: '7d',  label: '7 Day' },
  { key: '1m',  label: '1 Month' },
  { key: '3m',  label: '3 Month' },
  { key: '6m',  label: '6 Month' },
  { key: '1y',  label: '1 Yr' },
  { key: '2y',  label: '2 Yr' },
  { key: '3y',  label: '3 Yr' },
  { key: '5y',  label: '5 Yr' },
  { key: '10y', label: '10 Yr' },
  { key: '12y', label: '12 Yr' }
];
const BASE_COLS = [
  { key: 'name',     label: 'Scheme Name' },
  { key: 'amc',      label: 'AMC' },
  { key: 'category', label: 'Category' }
];

const state = {
  view: 'cagr', // 'cagr' | 'rolling'
  page: 1,
  limit: 25,
  lastResult: null,
  running: false
};

/* ─── INIT ───────────────────────────────────────────── */
async function init() {
  wireEvents();
  await loadFilterOptions();
  populateEvalPeriodDropdowns();
  await runEngine();
}

async function loadFilterOptions() {
  try {
    const opts = await fetch('/api/rule-engine/filter-options').then(r => r.json());
    fillSelect($('reFilterAmc'), opts.amc);
    fillSelect($('reFilterCategory'), opts.category);
    fillSelect($('reFilterType'), opts.schemeType);
    fillSelect($('reFilterOption'), opts.option);
  } catch (e) {
    console.error('Failed to load filter options:', e);
  }
}

function fillSelect(sel, values) {
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
}

function populateEvalPeriodDropdowns() {
  [$('reSipEvalPeriod'), $('reLumpsumEvalPeriod')].forEach(sel => {
    PERIOD_DEFS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.key; opt.textContent = p.label;
      sel.appendChild(opt);
    });
  });
}

/* ─── EVENTS ─────────────────────────────────────────── */
function wireEvents() {
  $('reApplyFilters').addEventListener('click', () => { state.page = 1; runEngine(); });

  $('reViewCagr').addEventListener('click', () => setView('cagr'));
  $('reViewRolling').addEventListener('click', () => setView('rolling'));

  $('reExportBtn').addEventListener('click', exportResults);

  // Enter key in search box triggers Apply
  $('reFilterSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { state.page = 1; runEngine(); } });
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  $('reViewCagr').classList.toggle('re-toggle-active', v === 'cagr');
  $('reViewRolling').classList.toggle('re-toggle-active', v === 'rolling');
  state.page = 1;
  runEngine();
}

/* ─── BUILD REQUEST BODY ─────────────────────────────── */
function buildRequestBody() {
  return {
    filters: {
      search: $('reFilterSearch').value.trim(),
      amc: $('reFilterAmc').value,
      category: $('reFilterCategory').value,
      schemeType: $('reFilterType').value,
      option: $('reFilterOption').value,
      hideNoLaunchDate: $('reHideNoLaunch').checked ? 'true' : 'false',
      stdDevBucket: $('reStdDevBucket').value,
      betaBucket: $('reBetaBucket').value,
      sharpeBucket: $('reSharpeBucket').value,
      jensenBucket: $('reJensenBucket').value,
      largeCapBucket: $('reLargeCapBucket').value,
      midCapBucket: $('reMidCapBucket').value,
      smallCapBucket: $('reSmallCapBucket').value,
      cashBucket: $('reCashBucket').value
    },
    sip: {
      amount: Number($('reSipAmount').value) || 5000,
      frequency: $('reSipFrequency').value,
      evalPeriod: $('reSipEvalPeriod').value,
      minReturn: $('reSipMinReturn').value
    },
    lumpsum: {
      amount: Number($('reLumpsumAmount').value) || 50000,
      evalPeriod: $('reLumpsumEvalPeriod').value,
      minReturn: $('reLumpsumMinReturn').value
    },
    view: state.view,
    page: state.page,
    limit: state.limit
  };
}

/* ─── RUN ────────────────────────────────────────────── */
async function runEngine() {
  if (state.running) return;
  state.running = true;

  const btn = $('reApplyFilters');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  $('reTableBody').innerHTML = `<tr><td class="re-empty" colspan="30">Crunching SIP &amp; Lumpsum returns for matching schemes…</td></tr>`;

  try {
    const body = buildRequestBody();
    const res = await fetch('/api/rule-engine/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      $('reTableBody').innerHTML = `<tr><td class="re-empty" colspan="30">⚠ ${escHtml(data.error || 'Something went wrong.')}</td></tr>`;
      $('reCardSchemesFound').textContent = '0';
      $('rePagination').innerHTML = '';
      $('reShowingText').textContent = '';
      return;
    }

    state.lastResult = data;
    updateSummaryCards(data);
    renderTable(data);
    renderPagination(data);
  } catch (e) {
    console.error('Rule engine run failed:', e);
    $('reTableBody').innerHTML = `<tr><td class="re-empty" colspan="30">⚠ Failed to run the rule engine. Please try again.</td></tr>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '▽ Apply Filters';
    state.running = false;
  }
}

function updateSummaryCards(data) {
  $('reLastUpdated').textContent = new Date(data.lastUpdated).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  $('reCardFilters').textContent = data.filtersApplied;
  $('reCardSchemesFound').textContent = data.schemesFound.toLocaleString('en-IN');
  $('reCardSipAmount').textContent = fmtMoney(data.sipAmount);
  $('reCardLumpsumAmount').textContent = fmtMoney(data.lumpsumAmount);
}

/* ─── TABLE RENDER ───────────────────────────────────── */
function activePeriods() {
  const selected = $('reSipEvalPeriod').value;
  return selected === 'All Periods' ? PERIOD_DEFS : PERIOD_DEFS.filter(p => p.key === selected);
}
function activeBaseCols() {
  return BASE_COLS;
}

function renderTable(data) {
  const sipPeriods = activePeriods();
  const selectedLumpsumPeriod = $('reLumpsumEvalPeriod').value;
  const lumpsumPeriods = selectedLumpsumPeriod === 'All Periods' ? PERIOD_DEFS : PERIOD_DEFS.filter(p => p.key === selectedLumpsumPeriod);
  const baseCols = activeBaseCols();
  const totalCols = 1 + baseCols.length + sipPeriods.length + lumpsumPeriods.length + 14; // Rank + base + returns + static profile columns

  // Header
  const head = $('reTableHead');
  const groupRow = document.createElement('tr');
  groupRow.className = 're-group-row';
  groupRow.innerHTML =
    `<th colspan="${1 + baseCols.length}"></th>` +
    `<th colspan="${sipPeriods.length || 1}">SIP Returns (${fmtMoney(data.sipAmount)} ${data.sipFrequency})</th>` +
    `<th colspan="${lumpsumPeriods.length || 1}">Lumpsum Returns (${fmtMoney(data.lumpsumAmount)} One Time)</th>` +
    '<th colspan="4" class="re-static-group">Risk Measures</th>' +
    '<th colspan="4" class="re-static-group">Market Capitalisation(%)</th>' +
    '<th colspan="5" class="re-static-group">AMFI Sectors(%)</th>' +
    '<th rowspan="2" class="re-static-group">Exit Load</th>';

  const labelRow = document.createElement('tr');
  let labelHtml = `<th class="re-th-left">Rank</th>`;
  baseCols.forEach(c => labelHtml += `<th class="re-th-left">${escHtml(c.label)}</th>`);
  sipPeriods.forEach(p => labelHtml += `<th class="re-sip-col">${escHtml(p.label)}</th>`);
  lumpsumPeriods.forEach(p => labelHtml += `<th class="re-lumpsum-col">${escHtml(p.label)}</th>`);
  labelHtml += '<th>Std.Dev</th><th>Beta (Slope)</th><th>Sharpe</th><th>Jenson</th>' +
    '<th>Large Cap</th><th>Mid Cap</th><th>Small Cap</th><th>Cash</th>' +
    '<th>1st Sector</th><th>2nd Sector</th><th>3rd Sector</th><th>4th Sector</th><th>5th Sector</th>';
  labelRow.innerHTML = labelHtml;

  head.innerHTML = '';
  head.appendChild(groupRow);
  head.appendChild(labelRow);

  // Body
  const body = $('reTableBody');
  if (!data.rows || data.rows.length === 0) {
    body.innerHTML = `<tr><td class="re-empty" colspan="${totalCols}">No schemes match your filters &amp; minimum-return rules.</td></tr>`;
    $('reShowingText').textContent = '';
    return;
  }

  body.innerHTML = data.rows.map(r => {
    let html = `<td>${r.rank}</td>`;
    html += `<td class="re-td-left re-scheme-name">${escHtml(r.name)}</td>`;
    html += `<td class="re-td-left re-amc">${escHtml(r.amc)}</td>`;
    html += `<td class="re-td-left re-category">${escHtml(r.category || '—')}</td>`;

    const sipSeries = state.view === 'rolling' ? r.sipRolling : r.sip;
    const lumpSeries = state.view === 'rolling' ? r.lumpsumRolling : r.lumpsum;

    sipPeriods.forEach(p => html += `<td class="re-sip-col">${renderCell(sipSeries, p.key)}</td>`);
    lumpsumPeriods.forEach(p => html += `<td class="re-lumpsum-col">${renderCell(lumpSeries, p.key)}</td>`);

    html += renderStaticProfileCells(r.staticData);

    return `<tr>${html}</tr>`;
  }).join('');

  const offset = (data.page - 1) * data.limit;
  $('reShowingText').textContent = data.total === 0
    ? ''
    : `Showing ${offset + 1} to ${Math.min(data.page * data.limit, data.total)} of ${data.total} entries`;
}

function renderStaticProfileCells(staticData) {
  const risk = staticData?.riskMeasures || {};
  const market = staticData?.marketCapitalisation || {};
  const sectors = staticData?.amfiSectors || [];
  const value = (item) => `<td class="re-static-cell">${escHtml(formatProfileNumber(item))}</td>`;
  return [
    value(risk['Std.Dev']), value(risk['Beta (Slope)']), value(risk.Sharpe), value(risk.Jenson),
    value(market['Large Cap']), value(market['Mid Cap']), value(market['Small Cap']), value(market.Cash),
    ...Array.from({ length: 5 }, (_, index) => value(sectors[index])),
    value(staticData?.exitLoad)
  ].join('');
}
function formatProfileNumber(value) {
  if (value == null || String(value).trim() === '') return '—';
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Math.abs(Number(text)).toFixed(3) : value;
}

function renderCell(series, key) {
  const entry = series && series.find(e => e.key === key);
  if (!entry || !entry.available) return '<span class="re-na">—</span>';
  const val = state.view === 'rolling' ? entry.avgReturn : entry.valuePct;
  if (val === undefined || val === null) return '<span class="re-na">—</span>';
  const cls = val >= 0 ? 're-pos' : 're-neg';
  const sign = val >= 0 ? '' : '';
  return `<span class="${cls}">${sign}${val}%</span>`;
}

/* ─── PAGINATION ─────────────────────────────────────── */
function renderPagination(data) {
  const wrap = $('rePagination');
  wrap.innerHTML = '';
  if (data.totalPages <= 1) return;

  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    b.className = 're-page-btn' + (opts.active ? ' active' : '');
    b.textContent = label;
    b.disabled = !!opts.disabled;
    b.addEventListener('click', () => { state.page = page; runEngine(); });
    return b;
  };

  wrap.appendChild(mkBtn('‹', Math.max(1, data.page - 1), { disabled: data.page === 1 }));

  const maxButtons = 6;
  let start = Math.max(1, data.page - Math.floor(maxButtons / 2));
  let end = Math.min(data.totalPages, start + maxButtons - 1);
  start = Math.max(1, end - maxButtons + 1);

  for (let p = start; p <= end; p++) {
    wrap.appendChild(mkBtn(String(p), p, { active: p === data.page }));
  }

  wrap.appendChild(mkBtn('›', Math.min(data.totalPages, data.page + 1), { disabled: data.page === data.totalPages }));
}

/* ─── EXPORT ─────────────────────────────────────────── */
async function exportResults() {
  const btn = $('reExportBtn');
  const original = btn.textContent;
  btn.textContent = '⏳ Exporting…';
  btn.disabled = true;

  try {
    const body = buildRequestBody();
    body.guideCols = activePeriods().map(p => p.key);

    const res = await fetch('/api/rule-engine/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Export failed. Please try again.');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Rule_Engine_Results_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Export failed:', e);
    alert('Export failed. Please try again.');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

init();
                                     