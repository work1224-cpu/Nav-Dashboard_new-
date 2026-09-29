const PERIODS = ['1 Day', '7 Day', '1 Month', '3 Month', '6 Month', '1 Yr', '2 Yr', '3 Yr', '5 Yr', '10 Yr', '12 Yr'];
const STATIC_COLUMNS = [['stdDev', 'Std.Dev'], ['beta', 'Beta (Slope)'], ['sharpe', 'Sharpe'], ['jenson', 'Jenson'], ['largeCap', 'Large Cap'], ['midCap', 'Mid Cap'], ['smallCap', 'Small Cap'], ['cash', 'Cash'], ['sector1', '1st Sector'], ['sector2', '2nd Sector'], ['sector3', '3rd Sector'], ['sector4', '4th Sector'], ['sector5', '5th Sector'], ['exitLoad', 'Exit Load']];
const $ = (id) => document.getElementById(id);

// This page is normally shown embedded inside the main dashboard's own
// page via an iframe (so "Rule Engine" feels like a tab, not a separate
// destination). In that case, "NAV Dashboard" links should ask the PARENT
// page to close this view — not navigate the iframe itself to "/", which
// would load the whole main site nested inside this small frame. If this
// page is ever opened on its own (not inside an iframe — e.g. a bookmark),
// the link just navigates normally.
function goToParentHome(event) {
  if (window.parent !== window && typeof window.parent.closeRuleEngineDashboard === 'function') {
    event.preventDefault();
    window.parent.closeRuleEngineDashboard();
    return false;
  }
  return true; // not embedded — let the browser follow the link to "/"
}

// ---------- Auth ----------
// No separate login here — this dashboard shares the exact same session
// as the rest of the site (main project's /api/auth/*). If that session
// is missing/expired, the server itself already redirects page loads to
// /login; this just double-checks via a quick /api/auth/me call so the
// user badge (name/role) can be filled in, and API calls below rely on
// the browser sending the same session cookie automatically.
let currentUser = null;
function isAdmin() { return currentUser?.role === 'admin'; }
async function authedFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
  return response;
}
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore — redirecting anyway */ }
  window.location.href = '/login';
}

// Show a useful batch on the home page; the API permits up to 25 exact
// daily-NAV calculations in one request and pagination exposes the rest.
const state = { page: 1, pageSize: 25, total: 0, mode: 'cagr', visible: new Set(['scheme', 'amc', 'category', ...PERIODS, ...STATIC_COLUMNS.map(([id]) => id)]) };
const money = (n) => `₹ ${Number(n || 0).toLocaleString('en-IN')}`;
const pct = (n) => n == null ? '—' : `<span class="${n >= 0 ? 'positive' : 'negative'}">${n.toFixed(2)}</span>`;
let filterTimer;
const SYNC_KEY = 'navLedgerSyncHistory_v1';
const SYNC_MAX_ENTRIES = 5; // full-catalog snapshots are large; keep the browser's localStorage quota safe
const SYNC_MAX_PAGES = 40; // safety cap: 40 x 400 = 16,000 schemes per sync (covers the full ~14,000-scheme dataset)

function params() {
  return new URLSearchParams({
    search: $('search').value.trim(), amc: $('amc').value, category: $('category').value,
    industry: $('industry').value,
    type: $('type').value, plan: $('plan').value, option: $('option').value,
    sipAmount: $('sipAmount').value.replace(/[^0-9.]/g, ''), sipFrequency: $('frequency').value,
    sipPeriod: $('sipPeriod').value, sipMinReturn: $('minReturn').value,
    lumpAmount: $('lumpAmount').value.replace(/[^0-9.]/g, ''), lumpPeriod: $('lumpPeriod').value, mode: state.mode,
    lumpMinReturn: $('lumpMin').value, page: state.page, pageSize: state.pageSize,
    stdDevBucket: $('stdDevBucket').value, betaBucket: $('betaBucket').value,
    sharpeBucket: $('sharpeBucket').value, jensenBucket: $('jensenBucket').value,
    largeCapBucket: $('largeCapBucket').value, midCapBucket: $('midCapBucket').value,
    smallCapBucket: $('smallCapBucket').value, cashBucket: $('cashBucket').value
  });
}
function activeFilters() {
  const bucketFields = ['stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'];
  const returnPeriodFields = ['cagrReturnPeriod', 'rollingReturnPeriod'];
  return ['search', 'amc', 'category', 'type', 'plan', 'option', ...bucketFields].filter((id) => Boolean($(id).value)).length + returnPeriodFields.filter((id) => $(id).value !== 'All Periods').length;
}
function esc(v) { const el = document.createElement('span'); el.textContent = v || '—'; return el.innerHTML; }

// Scheme Name / AMC / Category get a fixed width each so columns line up
// cleanly, but they scroll along with everything else — no sticky/frozen
// columns (that caused the columns to visually overlap/bleed into each
// other while scrolling), the whole table just moves together as one row
// of horizontal scroll, same fix already applied to the Home page table.
const FREEZE_WIDTH = { scheme: 190, amc: 135, category: 155 };
function renderTable(items) {
  const core = [['scheme', 'Scheme Name'], ['amc', 'AMC'], ['category', 'Category']].filter(([id]) => state.visible.has(id));
  const sipPeriod = $('sipPeriod').value;
  const lumpPeriod = $('lumpPeriod').value;
  const returnPeriod = state.mode === 'rolling' ? $('rollingReturnPeriod').value : $('cagrReturnPeriod').value;
  const matchesPeriod = (period, selected) => selected === 'All Periods' || period === selected;
  const sipReturns = PERIODS.filter((p) => state.visible.has(p) && matchesPeriod(p, sipPeriod) && matchesPeriod(p, returnPeriod));
  const lumpReturns = PERIODS.filter((p) => state.visible.has(p) && matchesPeriod(p, lumpPeriod) && matchesPeriod(p, returnPeriod));
  const staticColumns = STATIC_COLUMNS.filter(([id]) => state.visible.has(id));

  let leftAcc = 0;
  const coreWithOffset = core.map(([id, label]) => {
    const left = leftAcc;
    leftAcc += FREEZE_WIDTH[id];
    return [id, label, left];
  });
  const freezeStyle = (left, w) => `width:${w}px;min-width:${w}px;max-width:${w}px`;

  const staticValue = (record, id) => { const data = record.staticData || {}, risk = data.riskMeasures || {}, market = data.marketCapitalisation || {}, sectors = data.amfiSectors || []; return { stdDev: risk['Std.Dev'], beta: risk['Beta (Slope)'], sharpe: risk.Sharpe, jenson: risk.Jenson, largeCap: market['Large Cap'], midCap: market['Mid Cap'], smallCap: market['Small Cap'], cash: market.Cash, sector1: sectors[0], sector2: sectors[1], sector3: sectors[2], sector4: sectors[3], sector5: sectors[4], exitLoad: data.exitLoad }[id]; };
  const groups = [['Risk Measures', staticColumns.filter(([id]) => ['stdDev', 'beta', 'sharpe', 'jenson'].includes(id))], ['Market Capitalisation(%)', staticColumns.filter(([id]) => ['largeCap', 'midCap', 'smallCap', 'cash'].includes(id))], ['AMFI Sectors(%)', staticColumns.filter(([id]) => id.startsWith('sector'))]];
  $('tableHead').innerHTML = `<tr>${coreWithOffset.map(([id, label, left]) => `<th rowspan="2" class="col-freeze" style="${freezeStyle(left, FREEZE_WIDTH[id])}">${label}</th>`).join('')}${sipReturns.length ? `<th colspan="${sipReturns.length}">SIP Returns (${money($('sipAmount').value)} ${$('frequency').value})</th>` : ''}${lumpReturns.length ? `<th colspan="${lumpReturns.length}">Lumpsum Returns (${money($('lumpAmount').value)} One Time)</th>` : ''}${groups.map(([label, cols]) => cols.length ? `<th colspan="${cols.length}" class="static-group-heading">${label}</th>` : '').join('')}${staticColumns.some(([id]) => id === 'exitLoad') ? '<th rowspan="2" class="static-group-heading">Exit Load</th>' : ''}</tr><tr>${sipReturns.map((p) => `<th>${p}</th>`).join('')}${lumpReturns.map((p) => `<th>${p}</th>`).join('')}${staticColumns.filter(([id]) => id !== 'exitLoad').map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
  if (!items.length) { $('tableBody').innerHTML = `<tr><td colspan="${core.length + sipReturns.length + lumpReturns.length + staticColumns.length}" class="empty">No scheme matches these API filters.</td></tr>`; return; }
  $('tableBody').innerHTML = items.map((record, index) => `<tr>${coreWithOffset.map(([id, , left]) => `<td class="col-freeze" style="${freezeStyle(left, FREEZE_WIDTH[id])}">${id === 'scheme' ? `<b>${(state.page - 1) * state.pageSize + index + 1}. ${esc(record.schemeName)}</b>` : esc(record[id])}</td>`).join('')}${sipReturns.map((p) => `<td>${pct(record.sip[p])}</td>`).join('')}${lumpReturns.map((p) => `<td>${pct(record.lump[p])}</td>`).join('')}${staticColumns.map(([id]) => `<td class="td-static">${esc(formatProfileNumber(staticValue(record, id)))}</td>`).join('')}</tr>`).join('');
}
function formatProfileNumber(value) {
  if (value == null || String(value).trim() === '') return value;
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Math.abs(Number(text)).toFixed(3) : value;
}
function renderPagination() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const start = Math.max(1, Math.min(state.page - 2, pages - 4));
  const numbers = Array.from({ length: Math.min(5, pages - start + 1) }, (_, i) => start + i);
  $('pagination').innerHTML = `<button data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>‹</button>${numbers.map((page) => `<button class="${page === state.page ? 'current' : ''}" data-page="${page}">${page}</button>`).join('')}<button data-page="${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>›</button>`;
}
async function load() {
  $('tableBody').innerHTML = '<tr><td class="empty">Calculating exact returns from MFAPI daily NAV history…</td></tr>';
  $('apply').disabled = true;
  try {
    const response = await authedFetch(`/nav-ledger-api/rule-engine?${params()}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load MFAPI data');
    state.total = data.total; window.currentItems = data.items; renderTable(data.items); renderPagination();
    $('schemeCount').textContent = state.total.toLocaleString('en-IN');
    $('entries').textContent = `Showing ${data.items.length ? (state.page - 1) * state.pageSize + 1 : 0} to ${(state.page - 1) * state.pageSize + data.items.length} of ${state.total.toLocaleString('en-IN')} API schemes`;
    $('updated').textContent = `◷ Last Updated: ${data.asOf ? new Date(data.asOf).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}`;
    $('filterCount').textContent = activeFilters(); $('sipCard').textContent = money($('sipAmount').value); $('lumpCard').textContent = money($('lumpAmount').value);
  } catch (error) { $('tableBody').innerHTML = `<tr><td class="empty">${esc(error.message)}</td></tr>`; } finally { $('apply').disabled = false; }
}
function loadSyncHistory() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || []; } catch (_) { return []; }
}
function saveSyncHistory(list) {
  // A full-catalog sync can be a few MB; if the browser's localStorage
  // quota is hit, drop older snapshots one at a time and retry rather than
  // losing the sync the person just waited for.
  let trimmed = list.slice(0, SYNC_MAX_ENTRIES);
  while (trimmed.length) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(trimmed)); return; } catch (_) { trimmed = trimmed.slice(0, -1); }
  }
  console.warn('Could not save sync history — even a single snapshot exceeds the browser storage quota.');
}
function currentSnapshotMeta() {
  return {
    filters: { search: $('search').value.trim(), amc: $('amc').value, category: $('category').value, industry: $('industry').value, type: $('type').value, plan: $('plan').value, option: $('option').value },
    sip: { amount: $('sipAmount').value, frequency: $('frequency').value, period: $('sipPeriod').value, minReturn: $('minReturn').value },
    lump: { amount: $('lumpAmount').value, type: 'One Time', period: $('lumpPeriod').value, minReturn: $('lumpMin').value }
  };
}
async function fetchAllItems(mode, onProgress) {
  // Larger pages + the server's per-scheme returns cache (added alongside
  // this) mean a full sync now needs a handful of requests instead of
  // dozens — most of the previous slowness was purely round-trip overhead
  // from asking for 25 schemes at a time.
  const SYNC_PAGE_SIZE = 400;
  const base = params(); base.set('mode', mode); base.set('pageSize', String(SYNC_PAGE_SIZE)); base.set('page', '1');
  const first = await (await authedFetch(`/nav-ledger-api/rule-engine?${base}`)).json();
  const pages = Math.min(SYNC_MAX_PAGES, Math.ceil((first.total || 0) / SYNC_PAGE_SIZE));
  const pageItems = new Array(pages); pageItems[0] = first.items || [];
  const remaining = Array.from({ length: pages - 1 }, (_, i) => i + 2); // pages 2..pages
  let done = 1;
  const CONCURRENCY = 6; // fire several page requests at once instead of one-by-one
  async function worker() {
    while (remaining.length) {
      const page = remaining.shift();
      const p = params(); p.set('mode', mode); p.set('pageSize', String(SYNC_PAGE_SIZE)); p.set('page', String(page));
      const data = await (await authedFetch(`/nav-ledger-api/rule-engine?${p}`)).json();
      pageItems[page - 1] = data.items || [];
      done++; onProgress?.(done, pages);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(0, pages - 1)) }, worker));
  return { items: pageItems.flat(), total: first.total || 0, capped: pages < Math.ceil((first.total || 0) / SYNC_PAGE_SIZE), asOf: first.asOf };
}
async function syncData() {
  const mode = state.mode;
  $('syncBtn').disabled = true;
  $('syncStatus').textContent = `⟳ Syncing ${mode === 'rolling' ? 'Rolling Returns' : 'Return CAGR'} data for the current settings…`;
  try {
    const { items, total, capped, asOf } = await fetchAllItems(mode, (done, pages) => {
      $('syncStatus').textContent = `⟳ Syncing… fetched ${done} of ${pages} pages`;
    });
    const entry = { id: `${Date.now()}`, timestamp: Date.now(), mode, asOf, total, ...currentSnapshotMeta(), items };
    const history = loadSyncHistory(); history.unshift(entry); saveSyncHistory(history);
    $('syncStatus').textContent = `✓ Synced ${items.length.toLocaleString('en-IN')} scheme returns (${mode === 'rolling' ? 'Rolling Returns' : 'Return CAGR'})${capped ? ' — capped at first 1,000 matching schemes' : ''} · saved ${new Date(entry.timestamp).toLocaleString('en-IN')}`;
  } catch (error) {
    $('syncStatus').textContent = `Sync failed: ${error.message}`;
  } finally {
    $('syncBtn').disabled = false;
  }
}
function syncSummaryLine(entry) {
  return `SIP ₹${Number(entry.sip.amount || 0).toLocaleString('en-IN')} (${entry.sip.frequency}, ${entry.sip.period}, Min ${entry.sip.minReturn || 'Any'}%) · Lumpsum ₹${Number(entry.lump.amount || 0).toLocaleString('en-IN')} (${entry.lump.period}, Min ${entry.lump.minReturn || 'Any'}%)`;
}
function renderSyncModal() {
  const history = loadSyncHistory();
  if (!history.length) { $('syncPanelBody').innerHTML = '<div class="modal-empty">No synced data yet. Click “Sync Data” to save the current SIP &amp; Lumpsum settings and their returns.</div>'; return; }
  $('syncPanelBody').innerHTML = history.map((entry) => `
    <div class="sync-entry" data-id="${entry.id}">
      <div class="meta">
        <span class="tag ${entry.mode}">${entry.mode === 'rolling' ? 'Rolling Returns' : 'Return CAGR'}</span>
        <b>${new Date(entry.timestamp).toLocaleString('en-IN')}</b><br>
        ${esc(syncSummaryLine(entry))}<br>
        ${entry.items.length.toLocaleString('en-IN')} schemes saved${entry.filters.search ? ` · Search: “${esc(entry.filters.search)}”` : ''}${entry.filters.amc ? ` · AMC: ${esc(entry.filters.amc)}` : ''}${entry.filters.category ? ` · Category: ${esc(entry.filters.category)}` : ''}
      </div>
      <div class="actions">
        <button class="restore" data-action="restore" data-id="${entry.id}">View</button>
        <button class="delete" data-action="delete" data-id="${entry.id}">Delete</button>
      </div>
    </div>`).join('');
}
function restoreSyncEntry(id) {
  const entry = loadSyncHistory().find((row) => row.id === id);
  if (!entry) return;
  state.mode = entry.mode; state.page = 1; state.total = entry.total || entry.items.length;
  document.querySelectorAll('.tab[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === entry.mode));
  $('metricMode').textContent = entry.mode === 'rolling' ? '(Rolling Returns in %)' : '(Return CAGR in %)';
  $('search').value = entry.filters.search || ''; $('amc').value = entry.filters.amc || ''; $('category').value = entry.filters.category || '';
  $('industry').value = entry.filters.industry || '';
  $('type').value = entry.filters.type || ''; $('plan').value = entry.filters.plan || ''; $('option').value = entry.filters.option || '';
  $('sipAmount').value = entry.sip.amount; $('frequency').value = entry.sip.frequency; $('sipPeriod').value = entry.sip.period || 'All Periods'; $('minReturn').value = entry.sip.minReturn;
  $('lumpAmount').value = entry.lump.amount; $('lumpPeriod').value = entry.lump.period || 'All Periods'; $('lumpMin').value = entry.lump.minReturn;
  window.currentItems = entry.items; renderTable(entry.items); $('pagination').innerHTML = '';
  $('schemeCount').textContent = (entry.total || entry.items.length).toLocaleString('en-IN');
  $('entries').textContent = `Showing synced snapshot of ${entry.items.length.toLocaleString('en-IN')} schemes (saved ${new Date(entry.timestamp).toLocaleString('en-IN')})`;
  $('updated').textContent = `◷ Last Updated: ${entry.asOf ? new Date(entry.asOf).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}`;
  $('filterCount').textContent = activeFilters(); $('sipCard').textContent = money($('sipAmount').value); $('lumpCard').textContent = money($('lumpAmount').value);
  $('syncStatus').textContent = `Viewing synced snapshot from ${new Date(entry.timestamp).toLocaleString('en-IN')} (${entry.mode === 'rolling' ? 'Rolling Returns' : 'Return CAGR'})`;
  $('syncPanel').classList.remove('open');
}
function deleteSyncEntry(id) { saveSyncHistory(loadSyncHistory().filter((row) => row.id !== id)); renderSyncModal(); }
// Anchored to a fixed spot near the top-right of the viewport (see CSS) so
// it stays put and stays visible no matter how far the table is scrolled —
// it does not try to track the button's position on the page.
function openSyncPanel() { renderSyncModal(); $('syncPanel').classList.add('open'); }
function closeSyncPanel() { $('syncPanel').classList.remove('open'); }

// ---------- Role-based filter locking ----------
// A normal user never sees the Type/Plan/Option controls at all — the
// server pins those to Open Ended / Regular Plan / Growth regardless of
// what is (or isn't) sent, so hiding them here is purely a UI convenience.
// Role here comes from the SAME session/account as the rest of the site —
// there's no separate Rule Engine role, user badge, or admin panel here
// anymore (the header is just a plain "NAV Dashboard" link back home).
function applyRoleUI() {
  if (!isAdmin()) {
    ['typeLabel', 'planLabel', 'optionLabel'].forEach((id) => { $(id).hidden = true; });
    $('lockedNote').hidden = false;
  }
}

function resetFilters() {
  ['search', 'amc', 'category', 'industry', 'type', 'plan', 'option', 'sipPeriod', 'lumpPeriod', 'cagrReturnPeriod', 'rollingReturnPeriod', 'minReturn', 'lumpMin', 'stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'].forEach((id) => { $(id).value = ''; });
  $('sipPeriod').value = 'All Periods'; $('lumpPeriod').value = 'All Periods'; $('cagrReturnPeriod').value = 'All Periods'; $('rollingReturnPeriod').value = 'All Periods';
  state.page = 1; load();
}

async function init() {
  try {
    const meResponse = await fetch('/api/auth/me');
    if (!meResponse.ok) { window.location.href = '/login'; return; }
    currentUser = (await meResponse.json()).user;
  } catch (_) { window.location.href = '/login'; return; }

  // Keep these mode-specific selectors alongside the rest of the dashboard
  // filters, while leaving the compact HTML layout easy to maintain.
  const returnModeFilters = $('returnModeFilters');
  const filtersPanel = document.querySelector('.panel.filters');
  if (returnModeFilters && filtersPanel) {
    const returnPeriodGrid = returnModeFilters.querySelector('.period-filter-grid');
    if (returnPeriodGrid) filtersPanel.appendChild(returnPeriodGrid);
    returnModeFilters.remove();
  }

  applyRoleUI();
  const meta = await (await authedFetch('/nav-ledger-api/meta')).json();
  // Keep the page compatible with a server that has not been restarted yet.
  // The static fallbacks also guarantee that Option remains usable.
  const planFallback = ['Regular Plan', 'Direct Plan'];
  const optionFallback = ['Growth', 'IDCW', 'Dividend', 'Bonus'];
  [['amc', meta.amcList || []], ['category', meta.schemeCategories || []], ['industry', meta.industries || []], ['type', meta.schemeTypes || []], ['plan', meta.planOptions || planFallback], ['option', meta.optionOptions || optionFallback]].forEach(([id, values]) => values.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value; $(id).appendChild(option); }));
  const allCategories = meta.schemeCategories || [];
  const allTypes = meta.schemeTypes || [];
  const setChoices = (id, values) => {
    const select = $(id); const current = select.value;
    select.replaceChildren(new Option('All', ''));
    values.forEach((value) => select.add(new Option(value, value)));
    select.value = values.includes(current) ? current : '';
  };
  // Category and Type form a valid MFAPI pair. Cascading avoids impossible
  // combinations (e.g. Floater Fund + Interval Fund) that return zero rows.
  $('category').addEventListener('change', () => {
    const types = $('category').value ? (meta.typesByCategory?.[$('category').value] || allTypes) : allTypes;
    setChoices('type', types); state.page = 1; load();
  });
  $('type').addEventListener('change', () => {
    const categories = $('type').value ? (meta.categoriesByType?.[$('type').value] || allCategories) : allCategories;
    setChoices('category', categories); state.page = 1; load();
  });
  $('apply').onclick = () => { state.page = 1; load(); };
  $('resetFilters').onclick = resetFilters;
  // Every filter is reactive as well as supported by Apply Filters. This
  // prevents the table from showing stale API results after a selection.
  ['amc', 'industry', 'plan', 'option', 'frequency', 'sipPeriod', 'lumpPeriod', 'stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'].forEach((id) => $(id).addEventListener('change', () => { state.page = 1; load(); }));
  ['cagrReturnPeriod', 'rollingReturnPeriod'].forEach((id) => $(id).addEventListener('change', () => { renderTable(window.currentItems || []); $('filterCount').textContent = activeFilters(); }));
  ['search', 'sipAmount', 'lumpAmount', 'minReturn', 'lumpMin'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(filterTimer); filterTimer = setTimeout(() => { state.page = 1; load(); }, 350);
  }));
  document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.onclick = () => {
    state.mode = tab.dataset.mode; state.page = 1;
    document.querySelectorAll('.tab[data-mode]').forEach((button) => button.classList.toggle('active', button === tab));
    $('metricMode').textContent = state.mode === 'rolling' ? '(Rolling Returns in %)' : '(Return CAGR in %)';
    load();
  });
  $('pagination').onclick = (event) => { const page = Number(event.target.dataset.page); if (page > 0 && page <= Math.ceil(state.total / state.pageSize)) { state.page = page; load(); } };
  $('pageSize').value = String(state.pageSize);
  $('pageSize').onchange = () => { state.pageSize = Number($('pageSize').value); state.page = 1; load(); };
  $('export').onclick = () => { const csv = [...document.querySelectorAll('table tr')].map((row) => [...row.cells].map((cell) => `"${cell.innerText.replaceAll('"', '""')}"`).join(',')).join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'return-cagr-rule-engine.csv'; link.click(); };
  $('syncBtn').onclick = () => syncData();
  $('oldSyncBtn').onclick = () => { $('syncPanel').classList.contains('open') ? closeSyncPanel() : openSyncPanel(); };
  $('syncPanelClose').onclick = () => closeSyncPanel();
  document.addEventListener('click', (event) => {
    if (!$('syncPanel').classList.contains('open')) return;
    if ($('syncPanel').contains(event.target) || $('oldSyncBtn').contains(event.target)) return;
    closeSyncPanel();
  });
  $('syncPanelBody').addEventListener('click', (event) => {
    const id = event.target.dataset.id; if (!id) return;
    if (event.target.dataset.action === 'restore') restoreSyncEntry(id);
    if (event.target.dataset.action === 'delete') deleteSyncEntry(id);
  });
  load();
}
init();
