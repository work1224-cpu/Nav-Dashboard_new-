const $ = (id) => document.getElementById(id);

function goToParentHome(event) {
  if (window.parent !== window && typeof window.parent.closeCalendarSipDashboard === 'function') {
    event.preventDefault();
    window.parent.closeCalendarSipDashboard();
    return false;
  }
  return true;
}

let currentUser = null;
function isAdmin() { return currentUser?.role === 'admin'; }
async function authedFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
  return response;
}

const STATIC_COLUMNS = [['stdDev', 'Std.Dev'], ['beta', 'Beta (Slope)'], ['sharpe', 'Sharpe'], ['jenson', 'Jenson'], ['largeCap', 'Large Cap'], ['midCap', 'Mid Cap'], ['smallCap', 'Small Cap'], ['cash', 'Cash'], ['sector1', '1st Sector'], ['sector2', '2nd Sector'], ['sector3', '3rd Sector'], ['sector4', '4th Sector'], ['sector5', '5th Sector'], ['exitLoad', 'Exit Load']];
const state = { page: 1, pageSize: 25, total: 0, mode: 'sip', years: [], visible: new Set(['scheme', 'amc', 'category', ...STATIC_COLUMNS.map(([id]) => id)]) };
const pct = (n) => n == null ? '—' : `<span class="${n >= 0 ? 'positive' : 'negative'}">${n.toFixed(2)}</span>`;
let filterTimer;

function params() {
  return new URLSearchParams({
    search: $('search').value.trim(), amc: $('amc').value, category: $('category').value,
    industry: $('industry').value, type: $('type').value, plan: $('plan').value, option: $('option').value,
    includeClosed: $('includeClosed').checked ? 'true' : 'false',
    sipFrequency: $('frequency').value,
    investMonth: $('investMonth').value, investDay: $('investDay').value, sipDay: $('sipDay').value,
    page: state.page, pageSize: state.pageSize,
    stdDevBucket: $('stdDevBucket').value, betaBucket: $('betaBucket').value,
    sharpeBucket: $('sharpeBucket').value, jensenBucket: $('jensenBucket').value,
    largeCapBucket: $('largeCapBucket').value, midCapBucket: $('midCapBucket').value,
    smallCapBucket: $('smallCapBucket').value, cashBucket: $('cashBucket').value
  });
}
function activeFilters() {
  const bucketFields = ['stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'];
  return ['search', 'amc', 'category', 'type', 'plan', 'option', 'yearFilter', ...bucketFields].filter((id) => Boolean($(id).value)).length;
}
function esc(v) { const el = document.createElement('span'); el.textContent = v || '—'; return el.innerHTML; }
function money(v) { const n = Number(v) || 0; return `₹${n.toLocaleString('en-IN')}`; }
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function windowLabel() { return `${$('investDay').value} ${MONTH_NAMES[Number($('investMonth').value) - 1]} \u2192 next year`; }

const FREEZE_WIDTH = { scheme: 190, amc: 135, category: 155 };
const FIELD_FOR = { scheme: 'schemeName', amc: 'amc', category: 'category' };
function staticSummary(record) {
  const data = record?.staticData;
  if (!data) return '<span class="muted">No Excel match</span>';
  const parts = [];
  if (data.exitLoad) parts.push(`Exit: ${esc(data.exitLoad)}`);
  if (Array.isArray(data.amfiSectors) && data.amfiSectors.length) parts.push(`Sectors: ${data.amfiSectors.slice(0,2).map((v) => esc(v)).join(', ')}`);
  if (data.riskMeasures && Object.keys(data.riskMeasures).length) parts.push(`Risk: ${Object.entries(data.riskMeasures).slice(0,2).map(([k,v]) => `${esc(k)} ${esc(v)}`).join(' | ')}`);
  if (data.marketCapitalisation && Object.keys(data.marketCapitalisation).length) parts.push(`MCap: ${Object.entries(data.marketCapitalisation).slice(0,2).map(([k,v]) => `${esc(k)} ${esc(v)}`).join(' | ')}`);
  return parts.length ? parts.join('<br>') : '<span class="muted">Profile available</span>';
}

function staticProfileCell(value, fallback = '—') {
  const text = value && String(value).trim() ? value : fallback;
  return `<div class="static-value-box">${esc(text)}</div>`;
}

function staticProfileList(items, fallback = 'No data') {
  if (!Array.isArray(items) || !items.length) {
    return `<div class="static-empty">${fallback}</div>`;
  }
  return `<div class="static-profile-sidebar">${items.map((item) => `<div class="static-mini-tag">${esc(item)}</div>`).join('')}</div>`;
}

function staticProfileMap(map, fallback = 'No data') {
  const entries = map && typeof map === 'object' ? Object.entries(map) : [];
  if (!entries.length) {
    return `<div class="static-empty">${fallback}</div>`;
  }
  return `<div class="static-profile-sidebar">${entries.map(([key, value]) => `<div class="static-item-row"><span class="static-item-key">${esc(key)}</span><span class="static-item-value">${esc(value)}</span></div>`).join('')}</div>`;
}

function staticProfileColumns(record, columns) {
  const data = record?.staticData;
  const risk = data?.riskMeasures || {}, market = data?.marketCapitalisation || {}, sectors = data?.amfiSectors || [];
  const value = (item) => `<td class="td-static">${esc(formatProfileNumber(item))}</td>`;
  const values = { stdDev: risk['Std.Dev'], beta: risk['Beta (Slope)'], sharpe: risk.Sharpe, jenson: risk.Jenson, largeCap: market['Large Cap'], midCap: market['Mid Cap'], smallCap: market['Small Cap'], cash: market.Cash, sector1: sectors[0], sector2: sectors[1], sector3: sectors[2], sector4: sectors[3], sector5: sectors[4], exitLoad: data?.exitLoad };
  return columns.map(([id]) => value(values[id])).join('');
}
function formatProfileNumber(value) {
  if (value == null || String(value).trim() === '') return value;
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Math.abs(Number(text)).toFixed(3) : value;
}
function renderTable(items) {
  const core = [['scheme', 'Scheme Name'], ['amc', 'AMC'], ['category', 'Category']].filter(([id]) => state.visible.has(id));
  const selectedYear = $('yearFilter').value;
  const years = state.years.filter((y) => !selectedYear || String(y) === selectedYear);
  const staticColumns = STATIC_COLUMNS.filter(([id]) => state.visible.has(id));
  let leftAcc = 0;
  const coreWithOffset = core.map(([id, label]) => { const left = leftAcc; leftAcc += FREEZE_WIDTH[id]; return [id, label, left]; });
  const freezeStyle = (left, w) => `width:${w}px;min-width:${w}px;max-width:${w}px`;

  const groups = [['Risk Measures', staticColumns.filter(([id]) => ['stdDev', 'beta', 'sharpe', 'jenson'].includes(id))], ['Market Capitalisation(%)', staticColumns.filter(([id]) => ['largeCap', 'midCap', 'smallCap', 'cash'].includes(id))], ['AMFI Sectors(%)', staticColumns.filter(([id]) => id.startsWith('sector'))]];
  $('tableHead').innerHTML = `<tr>${coreWithOffset.map(([id, label, left]) => `<th rowspan="2" class="col-freeze" style="${freezeStyle(left, FREEZE_WIDTH[id])}">${label}</th>`).join('')}${years.length ? `<th colspan="${years.length}">${state.mode === 'lumpsum' ? `Lumpsum Return (${money($('lumpAmount').value)}, ${windowLabel()})` : `SIP Return (${money($('sipAmount').value)} ${$('frequency').value}, day ${$('sipDay').value}, window ${windowLabel()})`}</th>` : ''}${groups.map(([label, cols]) => cols.length ? `<th colspan="${cols.length}" class="static-group-heading">${label}</th>` : '').join('')}${staticColumns.some(([id]) => id === 'exitLoad') ? '<th rowspan="2" class="static-group-heading">Exit Load</th>' : ''}</tr><tr>${years.map((y) => `<th>${y}</th>`).join('')}${staticColumns.filter(([id]) => id !== 'exitLoad').map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
  if (!items.length) { $('tableBody').innerHTML = `<tr><td colspan="${core.length + years.length + staticColumns.length}" class="empty">No scheme matches these filters.</td></tr>`; return; }
  $('tableBody').innerHTML = items.map((record, index) => `<tr>${coreWithOffset.map(([id, , left]) => `<td class="col-freeze" style="${freezeStyle(left, FREEZE_WIDTH[id])}">${id === 'scheme' ? `<b>${(state.page - 1) * state.pageSize + index + 1}. ${esc(record.schemeName)}</b>` : esc(record[FIELD_FOR[id]])}</td>`).join('')}${years.map((y) => `<td>${pct(record.years[y] ? record.years[y][state.mode] : null)}</td>`).join('')}${staticProfileColumns(record, staticColumns)}</tr>`).join('');
  syncStickyScrollbar();
}

function syncStickyScrollbar() {}
function wireStickyScrollbar() {}
function renderPagination() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const start = Math.max(1, Math.min(state.page - 2, pages - 4));
  const numbers = Array.from({ length: Math.min(5, pages - start + 1) }, (_, i) => start + i);
  $('pagination').innerHTML = `<button data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>‹</button>${numbers.map((page) => `<button class="${page === state.page ? 'current' : ''}" data-page="${page}">${page}</button>`).join('')}<button data-page="${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>›</button>`;
}
async function load() {
  $('tableBody').innerHTML = '<tr><td class="empty">Calculating Calendar Year SIP/Lumpsum from MFAPI daily NAV history…</td></tr>';
  $('apply').disabled = true;
  try {
    const response = await authedFetch(`/nav-ledger-api/calendar-sip-lumpsum?${params()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load MFAPI data');
    state.total = data.total; state.years = [...data.years].reverse(); state.years.forEach((year) => state.visible.add(String(year)));
    const selectedYear = $('yearFilter').value;
    $('yearFilter').replaceChildren(new Option('All Years', ''), ...state.years.map((year) => new Option(String(year), String(year))));
    $('yearFilter').value = state.years.some((year) => String(year) === selectedYear) ? selectedYear : '';
    window.currentItems = data.items;
    renderTable(data.items); renderPagination();
    $('schemeCount').textContent = state.total.toLocaleString('en-IN');
    $('entries').textContent = `Showing ${data.items.length ? (state.page - 1) * state.pageSize + 1 : 0} to ${(state.page - 1) * state.pageSize + data.items.length} of ${state.total.toLocaleString('en-IN')} schemes`;
    $('updated').textContent = `◷ Last Updated: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    if (state.years.length) $('dataRange').textContent = `📅 Data available: ${Math.min(...state.years)} \u2013 ${Math.max(...state.years)}`;
    $('filterCount').textContent = activeFilters();
  } catch (error) {
    $('tableBody').innerHTML = `<tr><td class="empty">${esc(error.message)}</td></tr>`;
  } finally { $('apply').disabled = false; }
}

function applyRoleUI() {
  if (!isAdmin()) { ['typeLabel', 'planLabel', 'optionLabel'].forEach((id) => { $(id).hidden = true; }); $('lockedNote').hidden = false; }
}

function resetFilters() {
  ['search', 'amc', 'category', 'industry', 'type', 'plan', 'option', 'yearFilter', 'stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'].forEach((id) => { $(id).value = ''; });
  $('includeClosed').checked = false;
  state.page = 1; load();
}

async function init() {
  try {
    const meResponse = await fetch('/api/auth/me');
    if (!meResponse.ok) { window.location.href = '/login'; return; }
    currentUser = (await meResponse.json()).user;
  } catch (_) { window.location.href = '/login'; return; }

  applyRoleUI();
  wireStickyScrollbar();
  const meta = await (await authedFetch('/nav-ledger-api/meta')).json();
  const planFallback = ['Regular Plan', 'Direct Plan'];
  const optionFallback = ['Growth', 'IDCW', 'Dividend', 'Bonus'];
  [['amc', meta.amcList || []], ['category', meta.schemeCategories || []], ['industry', meta.industries || []], ['type', meta.schemeTypes || []], ['plan', meta.planOptions || planFallback], ['option', meta.optionOptions || optionFallback]].forEach(([id, values]) => values.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value; $(id).appendChild(option); }));
  const allCategories = meta.schemeCategories || [];
  const allTypes = meta.schemeTypes || [];
  const setChoices = (id, values) => { const select = $(id); const current = select.value; select.replaceChildren(new Option('All', '')); values.forEach((value) => select.add(new Option(value, value))); select.value = values.includes(current) ? current : ''; };
  $('category').addEventListener('change', () => { const types = $('category').value ? (meta.typesByCategory?.[$('category').value] || allTypes) : allTypes; setChoices('type', types); state.page = 1; load(); });
  $('type').addEventListener('change', () => { const categories = $('type').value ? (meta.categoriesByType?.[$('type').value] || allCategories) : allCategories; setChoices('category', categories); state.page = 1; load(); });
  $('apply').onclick = () => { state.page = 1; load(); };
  $('resetFilters').onclick = resetFilters;
  ['amc', 'industry', 'plan', 'option', 'frequency', 'investMonth', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket', 'stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket'].forEach((id) => $(id).addEventListener('change', () => { state.page = 1; load(); }));
  $('yearFilter').addEventListener('change', () => { renderTable(window.currentItems || []); $('filterCount').textContent = activeFilters(); });
  $('includeClosed').addEventListener('change', () => { state.page = 1; load(); });
  // Free-typed day numbers — debounce like the search box so it doesn't
  // refetch on every keystroke, and clamp to a valid day (1–28, safe for
  // every month including February) once the person stops typing.
  ['investDay', 'sipDay'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      const clamped = Math.min(28, Math.max(1, Number($(id).value) || 1));
      $(id).value = clamped;
      state.page = 1; load();
    }, 500);
  }));
  // Amount fields don't change the resulting PERCENTAGE (see backend note),
  // so no need to refetch — just re-render so the header reflects the new
  // amount immediately.
  ['sipAmount', 'lumpAmount'].forEach((id) => $(id).addEventListener('input', () => renderTable(window.currentItems || [])));
  $('search').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { state.page = 1; load(); }, 350); });
  document.querySelectorAll('.tab[data-mode]').forEach((tab) => tab.onclick = () => {
    state.mode = tab.dataset.mode;
    document.querySelectorAll('.tab[data-mode]').forEach((button) => button.classList.toggle('active', button === tab));
    $('metricMode').textContent = state.mode === 'lumpsum' ? '(Calendar Year Lumpsum return in %)' : '(Calendar Year SIP return in %)';
    renderTable(window.currentItems || []); // both values are already in the same response — no refetch needed to switch tabs
  });
  $('pagination').onclick = (event) => { const page = Number(event.target.dataset.page); if (page > 0 && page <= Math.ceil(state.total / state.pageSize)) { state.page = page; load(); } };
  $('pageSize').value = String(state.pageSize);
  $('pageSize').onchange = () => { state.pageSize = Number($('pageSize').value); state.page = 1; load(); };
  $('export').onclick = () => { const csv = [...document.querySelectorAll('table tr')].map((row) => [...row.cells].map((cell) => `"${cell.innerText.replaceAll('"', '""')}"`).join(',')).join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'calendar-year-sip-lumpsum.csv'; link.click(); };
  load();
}
init();                                                                                                                                                                 