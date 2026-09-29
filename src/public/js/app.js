/* ══════════════════════════════════════════════════════
   AMFI NAV Dashboard — app.js  (Light Theme)
   ══════════════════════════════════════════════════════ */

const state = {
  activeFund: null,
  funds: [],
  page: 1,
  limit: 50,
  filters: { search:'', code:'', schemeType:'', plan:'', option:'', category:'', minNav:'', maxNav:'', sortBy:'' },
  navCache: {},
  staticNavs: {}
};

/* ─── WELCOME STATE ─────────────────────────────────── */
const welcomeState = {
  page: 1,
  limit: 50,
  filters: { search:'', code:'', fundHouse:'', schemeType:'', plan:'', option:'', category:'', industry:'', minNav:'', maxNav:'', sortBy:'', cagrPeriod:'', rollingPeriod:'', stdDevBucket:'', betaBucket:'', sharpeBucket:'', jensenBucket:'', largeCapBucket:'', midCapBucket:'', smallCapBucket:'', cashBucket:'' },
  total: 0
};

/* ─── VANGUARD STATE ─────────────────────────────────── */
const vanguardState = {
  data: [],
  filteredData: [],
  page: 1,
  limit: 50,
  search: '',
  minYTD: '',
  maxYTD: '',
  maxExpense: '',
  sortBy: 'name',
  isLoading: false,
  selectedCompany: '',
  companies: []
};

/* ─── UPVALY STATE ───────────────────────────────────── */
let upvalyActiveTab = 'ipo';

const upvalyIpoState = {
  data: [],
  filteredData: [],
  page: 1,
  limit: 50,
  search: '',
  selectedType: '',
  selectedStatus: '',
  sortBy: 'listing_desc',
  isLoading: false,
  types: [],
  statuses: []
};

const upvalyHolidayState = {
  data: [],
  filteredData: [],
  page: 1,
  limit: 50,
  search: '',
  selectedType: '',
  isLoading: false,
  types: []
};

/* ─── DOM ───────────────────────────────────────────── */
const $ = id => document.getElementById(id);

let sessionRedirecting = false;
function redirectToLogin() {
  if (sessionRedirecting) return;
  sessionRedirecting = true;
  window.location.href = '/login';
}

/* ─── CURRENT USER / AUTH ───────────────────────────── */
let CURRENT_USER = null;
const isAdmin = () => !!(CURRENT_USER && CURRENT_USER.role === 'admin');

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const data = await res.json();
    CURRENT_USER = data.user;

    $('userBadgeAvatar').textContent = CURRENT_USER.username.slice(0, 1).toUpperCase();
    $('userBadgeName').textContent = CURRENT_USER.username;
    const roleEl = $('userBadgeRole');
    roleEl.textContent = CURRENT_USER.role === 'admin' ? 'Admin' : 'User (view only)';
    roleEl.className = 'user-badge-role ' + CURRENT_USER.role;
    $('userBadgeAdminLink').classList.toggle('hidden', !isAdmin());

    $('userBadgeLogout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  } catch (err) {
    console.error('Failed to load current user', err);
    window.location.href = '/login';
  }
}

/* ─── INIT ──────────────────────────────────────────── */
async function init() {
  await loadCurrentUser();

  const [stats, funds, opts] = await Promise.all([
    fetch('/api/stats').then(r=>r.json()),
    fetch('/api/funds').then(r=>r.json()),
    fetch('/api/filter-options').then(r=>r.json())
  ]);

  $('welcomeStats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${stats.totalFunds}</div><div class="stat-label">Fund Houses</div></div>
    <div class="stat-card"><div class="stat-num">${stats.totalSchemes.toLocaleString()}</div><div class="stat-label">Total Schemes</div></div>`;

  state.funds = funds;

  populateSelect($('filterSchemeType'), opts.schemeTypes);
  populateSelect($('filterPlan'),       opts.plans);
  populateSelect($('filterOption'),     opts.options);
  populateSelect($('filterCategory'),   opts.categories);

  // AMC (fund house) filter on the Home page — replaces the old sidebar
  // fund-house list. "All AMCs" (blank value) shows every scheme.
  // Keep the list alphabetical in ascending order for easier scanning.
  const sortedFundNames = [...funds.map(f => f.name)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  populateSelect($('welcomeFilterFundHouse'), sortedFundNames);

  populateSelect($('welcomeFilterSchemeType'), opts.schemeTypes);
  populateSelect($('welcomeFilterPlan'),       opts.plans);
  populateSelect($('welcomeFilterOption'),     opts.options);
  populateSelect($('welcomeFilterCategory'),   opts.categories);
  populateSelect($('welcomeFilterIndustry'),   opts.industries);

  // Home page: non-admin ("view only") users are locked to Plan=Regular,
  // Option=Growth and can't change either dropdown. Admins keep full
  // control. This mirrors the server-side lock in /api/all-schemes and
  // /api/download-all-schemes-full, so it can't be bypassed either way.
  if (!isAdmin()) {
    welcomeState.filters.plan = 'Regular';
    welcomeState.filters.option = 'Growth';
    $('welcomeFilterPlan').value = 'Regular';
    $('welcomeFilterOption').value = 'Growth';
    $('welcomeFilterPlan').disabled = true;
    $('welcomeFilterOption').disabled = true;
    $('welcomeFilterPlan').title = 'Only admins can change this';
    $('welcomeFilterOption').title = 'Only admins can change this';
  }

  setupWelcomeFilters();
  setupVanguardFilters();
  setupUpvalyFilters();
  
  $('welcomeBtnDownloadAll').addEventListener('click', downloadAllWelcomeSchemes);
  
  // Calendar Year's schemes table is now behind its own tile — loaded
  // lazily by openCalendarYearView() the first time someone clicks it,
  // instead of fetching it eagerly on every Home page load.
  initSyncBar();
}

function populateSelect(el, values) {
  values.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v; el.appendChild(o);
  });
}

/* ─── SIDEBAR ───────────────────────────────────────── */
// Returning to the Home screen always lands on the 5-tile dashboard index
// (not directly on the Calendar Year table) — this resets that state.
function showDashboardIndex() {
  const cy = $('calendarYearView');
  if (cy) cy.classList.add('hidden');
  const idx = $('dashboardIndexGrid');
  if (idx) idx.classList.remove('hidden');
  const hero = $('homeHero');
  if (hero) hero.classList.remove('hidden');
}

let welcomeSchemesLoaded = false;
function openCalendarYearView() {
  $('dashboardIndexGrid').classList.add('hidden');
  $('calendarYearView').classList.remove('hidden');
  // Hide the hero/stats block too — Calendar Year is data-dense and
  // should get as much of the page as possible, same idea as the other
  // dashboards taking over the full view.
  $('homeHero').classList.add('hidden');
  // Loaded lazily on first visit — no need to hit the API before the
  // person has actually chosen this tile.
  if (!welcomeSchemesLoaded) {
    welcomeSchemesLoaded = true;
    loadWelcomeSchemes();
  }
}
function closeCalendarYearView() {
  showDashboardIndex();
}

function goHome() {
  // Close any open scheme/return modals
  const backdrop = $('modalBackdrop');
  if (backdrop) { backdrop.classList.add('hidden'); document.body.style.overflow = ''; }
  const upvalyModal = document.getElementById('upvalyViewModal');
  if (upvalyModal) upvalyModal.remove();
  const vgModal = document.getElementById('vanguardViewModal');
  if (vgModal) vgModal.remove();

  // Hide every dashboard / detail view
  $('vanguardDashboard').classList.add('hidden');
  $('upvalyDashboard').classList.add('hidden');
  $('ruleEngineDashboard').classList.add('hidden');
  $('calendarCagrDashboard').classList.add('hidden');
  $('calendarSipDashboard').classList.add('hidden');
  $('fundView').classList.add('hidden');

  // Show the welcome/home screen — always back at the dashboard index,
  // never straight into the Calendar Year table.
  $('welcome').classList.remove('hidden');
  document.querySelector('.welcome').style.display = '';
  showDashboardIndex();

  // Hide the "NAV Dashboard" top-center back-link — we're already home.
  $('topHomeNav').classList.add('hidden');

  state.activeFund = null;
}

function renderFundList(funds) {
  const el = $('fundList');
  if (!el) return; // sidebar removed — kept as a harmless no-op for old call sites
  el.innerHTML = funds.map(f => `
    <div class="fund-item ${state.activeFund === f.name ? 'active' : ''}"
         data-name="${escHtml(f.name)}"
         onclick="selectFund('${escJs(f.name)}')">
      <span class="fund-item-name">${escHtml(f.name)}</span>
      <span class="fund-item-badge">${f.count}</span>
    </div>`).join('');
}

if ($('sidebarSearch')) {
  $('sidebarSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    renderFundList(state.funds.filter(f => f.name.toLowerCase().includes(q)));
  });
}

/* ─── SELECT FUND ───────────────────────────────────── */
async function selectFund(name) {
  state.activeFund = name;
  state.page = 1;
  state.navCache = {};
  state.staticNavs = {};
  resetFilters(false);

  document.querySelectorAll('.fund-item').forEach(el =>
    el.classList.toggle('active', el.dataset.name === name));

  $('welcome').classList.add('hidden');
  $('vanguardDashboard').classList.add('hidden');
  $('upvalyDashboard').classList.add('hidden');
  $('ruleEngineDashboard').classList.add('hidden');
  $('fundView').classList.remove('hidden');
  $('fundTitle').textContent = name;
  $('fundMeta').textContent  = 'Loading…';
  $('topHomeNav').classList.remove('hidden');

  await loadSchemes();
}

/* ─── LOAD SCHEMES ──────────────────────────────────── */
async function loadSchemes() {
  if (!state.activeFund) return;

  $('tableBody').innerHTML = `<tr class="loader-row"><td colspan="10">Loading schemes…</td></tr>`;
  $('resultsMeta').textContent = '';
  $('pagination').innerHTML = '';
  renderFilterTags();

  const params = new URLSearchParams({
    page: state.page, limit: state.limit,
    search: state.filters.search,       code:       state.filters.code,
    schemeType: state.filters.schemeType, plan:     state.filters.plan,
    option: state.filters.option,       category:   state.filters.category,
    minNav: state.filters.minNav,       maxNav:     state.filters.maxNav,
    sortBy: state.filters.sortBy
  });

  const data = await fetch(`/api/funds/${encodeURIComponent(state.activeFund)}?${params}`).then(r=>r.json());

  if (data.error) {
    $('tableBody').innerHTML = `<tr class="empty-row"><td colspan="10">Fund not found.</td></tr>`;
    return;
  }

  const offset = (state.page - 1) * state.limit;
  $('fundMeta').textContent = `${data.total.toLocaleString()} scheme${data.total !== 1 ? 's' : ''}`;
  $('resultsMeta').textContent = data.total === 0
    ? 'No schemes match your filters.'
    : `Showing ${offset+1}–${Math.min(state.page*state.limit, data.total)} of ${data.total.toLocaleString()} schemes`;

  data.schemes.forEach(s => { state.staticNavs[s.code] = s.nav; });
  renderTable(data.schemes, offset);
  renderPagination(data.totalPages);
  fetchLiveNAVs(data.schemes);
}

/* ─── LIVE NAVs ─────────────────────────────────────── */
async function fetchLiveNAVs(schemes) {
  const toFetch = schemes.filter(s => !state.navCache[s.code]).map(s => s.code);
  if (!toFetch.length) { patchNavCells(schemes); return; }

  toFetch.forEach(code => {
    const cell = document.querySelector(`td.nav-cell[data-code="${code}"]`);
    if (cell) cell.innerHTML = `<span class="nav-loading">fetching…</span>`;
  });

  try {
    const res  = await fetch(`/api/live-nav?codes=${toFetch.join(',')}`);
    const live = await res.json();
    live.forEach(item => {
      state.navCache[item.code] = (item.live && item.nav)
        ? { nav: item.nav, date: item.date }
        : null;
    });
  } catch {
    toFetch.forEach(code => { state.navCache[code] = null; });
  }
  patchNavCells(schemes);
}

function patchNavCells(schemes) {
  schemes.forEach(s => {
    const navCell  = document.querySelector(`td.nav-cell[data-code="${s.code}"]`);
    const dateCell = document.querySelector(`td.date-cell[data-code="${s.code}"]`);
    if (!navCell) return;
    const cached = state.navCache[s.code];
    if (!cached) { navCell.innerHTML = navHTML(Number(s.nav).toFixed(4), null, s.nav); return; }
    const liveNav = parseFloat(cached.nav);
    navCell.innerHTML = navHTML(liveNav.toFixed(4), liveNav, state.staticNavs[s.code] || 0);
    if (dateCell) dateCell.textContent = cached.date || s.date;
  });
}

function navHTML(displayVal, liveNav, staticNav) {
  let badge = '';
  if (liveNav !== null && staticNav) {
    const diff = liveNav - staticNav;
    const pct  = ((diff / staticNav) * 100).toFixed(2);
    if (Math.abs(diff) > 0.0001) {
      const cls  = diff > 0 ? 'nav-up' : 'nav-down';
      const sign = diff > 0 ? '▲' : '▼';
      badge = `<span class="nav-change ${cls}">${sign}${Math.abs(pct)}%</span>`;
    } else {
      badge = `<span class="nav-change nav-same">—</span>`;
    }
  }
  return `<span class="nav-value">₹${displayVal}</span>${badge}`;
}

/* ─── RENDER TABLE ──────────────────────────────────── */
function renderTable(schemes, offset) {
  if (!schemes.length) {
    $('tableBody').innerHTML = `<tr class="empty-row"><td colspan="10">No results. Try adjusting your filters.</td></tr>`;
    return;
  }
  $('tableBody').innerHTML = schemes.map((s, i) => `
    <tr>
      <td class="td-index">${offset + i + 1}</td>
      <td class="td-code">${escHtml(s.code)}</td>
      <td class="td-name">${escHtml(s.name)}</td>
      <td>${planPill(s.plan)}</td>
      <td>${optionPill(s.option)}</td>
      <td class="td-isin">${s.isin_growth
          ? `<span class="isin-badge">${escHtml(s.isin_growth)}</span>`
          : `<span class="isin-null">—</span>`}</td>
      <td class="td-launch" data-code="${escHtml(s.code)}">${launchDateCellHtml(s.code, s.launchDate)}</td>
      <td class="td-nav nav-cell" data-code="${escHtml(s.code)}">
        <span class="nav-loading">fetching…</span>
      </td>
      <td class="td-date date-cell" data-code="${escHtml(s.code)}">${escHtml(s.date)}</td>
      <td class="td-actions">
        <button class="btn-view" onclick='openModal(${JSON.stringify(s)})'>View</button>
        <button class="btn-export" onclick='exportScheme("${escJs(s.code)}")' title="Export latest NAV">📥 Export</button>
      </td>
    </tr>`).join('');
}

function planPill(plan) {
  const m = { Direct:'pill-direct', Regular:'pill-regular', Retail:'pill-retail', Other:'pill-other' };
  return `<span class="pill ${m[plan]||'pill-other'}">${escHtml(plan)}</span>`;
}
function optionPill(opt) {
  const cls = opt==='Growth' ? 'pill-growth'
            : opt&&opt.includes('IDCW') ? 'pill-idcw'
            : opt==='Bonus' ? 'pill-bonus' : 'pill-opt-other';
  return `<span class="pill ${cls}">${escHtml(opt)}</span>`;
}

/* ─── FILTER TAGS ───────────────────────────────────── */
function renderFilterTags() {
  const labels = { search:'Name', code:'Code', schemeType:'Type', plan:'Plan',
                   option:'Option', category:'Category', minNav:'Min NAV', maxNav:'Max NAV', sortBy:'Sort' };
  $('filterTags').innerHTML = Object.entries(state.filters)
    .filter(([,v]) => v !== '')
    .map(([k,v]) => `
      <span class="filter-tag">
        ${labels[k]}: <strong>${escHtml(v)}</strong>
        <button onclick="clearFilter('${k}')">✕</button>
      </span>`).join('');
}

function clearFilter(key) {
  state.filters[key] = '';
  const el = { search:$('filterSearch'), code:$('filterCode'), schemeType:$('filterSchemeType'),
               plan:$('filterPlan'), option:$('filterOption'), category:$('filterCategory'),
               minNav:$('filterMinNav'), maxNav:$('filterMaxNav'), sortBy:$('filterSort') }[key];
  if (el) el.value = '';
  state.page = 1;
  loadSchemes();
}

/* ─── PAGINATION ────────────────────────────────────── */
function renderPagination(totalPages) {
  if (totalPages <= 1) { $('pagination').innerHTML = ''; return; }
  const cur = state.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p=>p>=1&&p<=totalPages));
  const sorted  = [...visible].sort((a,b)=>a-b);
  let html = `<button class="page-btn" onclick="goPage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goPage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  $('pagination').innerHTML = html;
}

function goPage(p) {
  state.page = p;
  loadSchemes();
  document.querySelector('.fund-view').scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ─── DOWNLOAD ALL WELCOME SCHEMES (full data: NAV + Returns + Rolling) ─ */
async function downloadAllWelcomeSchemes() {
  const btn = $('welcomeBtnDownloadAll');
  btn.classList.add('loading');
  btn.textContent = '⏳ Building full data file…';

  try {
    const params = new URLSearchParams({
      search: welcomeState.filters.search,
      code: welcomeState.filters.code,
      fundHouse: welcomeState.filters.fundHouse,
      schemeType: welcomeState.filters.schemeType,
      plan: welcomeState.filters.plan,
      option: welcomeState.filters.option,
      category: welcomeState.filters.category,
      industry: welcomeState.filters.industry,
      minNav: welcomeState.filters.minNav,
      maxNav: welcomeState.filters.maxNav,
      sortBy: welcomeState.filters.sortBy,
      stdDevBucket: welcomeState.filters.stdDevBucket,
      betaBucket: welcomeState.filters.betaBucket,
      sharpeBucket: welcomeState.filters.sharpeBucket,
      jensenBucket: welcomeState.filters.jensenBucket,
      largeCapBucket: welcomeState.filters.largeCapBucket,
      midCapBucket: welcomeState.filters.midCapBucket,
      smallCapBucket: welcomeState.filters.smallCapBucket,
      cashBucket: welcomeState.filters.cashBucket
    });

    const a = document.createElement('a');
    a.href = `/api/download-all-schemes-full?${params}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    console.error('Download failed:', error);
    alert('Failed to download. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = '⬇ Download All Filtered Schemes (Excel)';
    }, 3000);
  }
}

/* ─── REFRESH ───────────────────────────────────────── */
$('btnRefresh').addEventListener('click', () => {
  state.navCache = {};
  $('btnRefresh').textContent = '↻ Refreshing…';
  loadSchemes().finally(() => { $('btnRefresh').textContent = '↺ Refresh'; });
});

/* ─── EXPORT ALL (current fund house, full data) ────── */
$('btnExportFundAll').addEventListener('click', () => {
  if (!state.activeFund) return;
  const btn = $('btnExportFundAll');
  const original = btn.textContent;
  btn.textContent = '⏳ Building full data file…';
  btn.disabled = true;

  const params = new URLSearchParams({
    search: state.filters.search,       code:       state.filters.code,
    schemeType: state.filters.schemeType, plan:     state.filters.plan,
    option: state.filters.option,       category:   state.filters.category,
    minNav: state.filters.minNav,       maxNav:     state.filters.maxNav,
    sortBy: state.filters.sortBy
  });

  const a = document.createElement('a');
  a.href = `/api/download/${encodeURIComponent(state.activeFund)}/full?${params}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
});

/* ─── FILTER EVENTS ─────────────────────────────────── */
let dt;
function debounce(fn, ms=380) { clearTimeout(dt); dt = setTimeout(fn, ms); }

$('filterSearch').addEventListener('input',      e => { state.filters.search = e.target.value; state.page=1; debounce(loadSchemes); });
$('filterCode').addEventListener('input',        e => { state.filters.code = e.target.value; state.page=1; debounce(loadSchemes); });
$('filterMinNav').addEventListener('input',      e => { state.filters.minNav = e.target.value; state.page=1; debounce(loadSchemes); });
$('filterMaxNav').addEventListener('input',      e => { state.filters.maxNav = e.target.value; state.page=1; debounce(loadSchemes); });
$('filterSchemeType').addEventListener('change', e => { state.filters.schemeType = e.target.value; state.page=1; loadSchemes(); });
$('filterPlan').addEventListener('change',       e => { state.filters.plan = e.target.value; state.page=1; loadSchemes(); });
$('filterOption').addEventListener('change',     e => { state.filters.option = e.target.value; state.page=1; loadSchemes(); });
$('filterCategory').addEventListener('change',   e => { state.filters.category = e.target.value; state.page=1; loadSchemes(); });
$('filterSort').addEventListener('change',       e => { state.filters.sortBy = e.target.value; state.page=1; loadSchemes(); });
$('filterReset').addEventListener('click', () => resetFilters(true));

function resetFilters(reload=true) {
  state.filters = { search:'', code:'', schemeType:'', plan:'', option:'', category:'', minNav:'', maxNav:'', sortBy:'' };
  ['filterSearch','filterCode','filterMinNav','filterMaxNav'].forEach(id => $(id).value = '');
  ['filterSchemeType','filterPlan','filterOption','filterCategory','filterSort'].forEach(id => $(id).value = '');
  $('filterTags').innerHTML = '';
  state.page = 1;
  if (reload && state.activeFund) loadSchemes();
}

/* ─── EXPORT SCHEME ────────────────────────────────── */
async function exportScheme(code) {
  const btn = document.querySelector(`.btn-export[onclick*="${code}"]`);
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = '⏳';
  }
  
  try {
    const a = document.createElement('a');
    a.href = `/api/export-scheme/${code}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export scheme data. Please try again.');
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = '📥 Export';
    }
  }
}

/* ─── MODAL ─────────────────────────────────────────── */
function openModal(scheme) {
  state.currentModalScheme = scheme;

  const cached    = state.navCache[scheme.code];
  const liveNav   = cached ? parseFloat(cached.nav) : null;
  const liveDate  = cached ? cached.date : null;
  const staticNav = scheme.nav;

  let changeHTML = '';
  if (liveNav !== null && staticNav) {
    const diff = liveNav - staticNav;
    const pct  = ((diff / staticNav) * 100).toFixed(3);
    if (Math.abs(diff) > 0.0001) {
      const cls  = diff > 0 ? 'nav-up' : 'nav-down';
      const sign = diff > 0 ? '▲' : '▼';
      changeHTML = `<span class="nav-change ${cls}" style="font-size:13px;padding:3px 9px">${sign} ₹${Math.abs(diff).toFixed(4)} (${Math.abs(pct)}%)</span>`;
    } else {
      changeHTML = `<span class="nav-change nav-same" style="font-size:13px;padding:3px 9px">No change</span>`;
    }
  }

  const planClsMap = { Direct:'pill-direct', Regular:'pill-regular', Retail:'pill-retail', Other:'pill-other' };
  const optCls = scheme.option==='Growth'?'pill-growth':scheme.option&&scheme.option.includes('IDCW')?'pill-idcw':scheme.option==='Bonus'?'pill-bonus':'pill-opt-other';

  $('modalTitle').textContent = scheme.name;
  $('modalSub').textContent   = state.activeFund || 'All Schemes';
  $('modalApiLink').href      = scheme.url;

  $('modalBody').innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">🪪 Identity</div>
      <div class="modal-cards">
        <div class="modal-card">
          <div class="mc-label">Scheme Code</div>
          <div class="mc-value mono">${escHtml(scheme.code)}</div>
        </div>
        <div class="modal-card mc-full">
          <div class="mc-label">Scheme Name</div>
          <div class="mc-value">${escHtml(scheme.name)}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">ISIN Growth / Div Payout</div>
          <div class="mc-value mono">${scheme.isin_growth ? `<span class="isin-badge">${escHtml(scheme.isin_growth)}</span>` : '<span style="color:var(--text-dim)">—</span>'}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">ISIN Div Reinvestment</div>
          <div class="mc-value mono">${scheme.isin_div_reinvestment ? `<span class="isin-badge">${escHtml(scheme.isin_div_reinvestment)}</span>` : '<span style="color:var(--text-dim)">—</span>'}</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">🏷️ Classification</div>
      <div class="modal-cards">
        <div class="modal-card">
          <div class="mc-label">Scheme Type</div>
          <div class="mc-value">${escHtml(scheme.schemeType||'—')}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Category</div>
          <div class="mc-value">${escHtml(scheme.category||'—')}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Plan</div>
          <div class="mc-value"><span class="pill ${planClsMap[scheme.plan]||'pill-other'}">${escHtml(scheme.plan)}</span></div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Option</div>
          <div class="mc-value"><span class="pill ${optCls}">${escHtml(scheme.option)}</span></div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Launch Date</div>
          ${isAdmin() ? `<button class="btn-edit-launch modal-launch-edit" onclick="editModalLaunchDate(this, '${escJs(scheme.code)}', '${escJs(scheme.launchDate||'')}')" title="Edit launch date">✎</button>` : ''}
          <div class="mc-value mono">${scheme.launchDate ? escHtml(scheme.launchDate) : '<span style="color:var(--text-dim)">—</span>'}</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">📈 NAV Details</div>
      <div class="modal-cards">
        <div class="modal-card mc-highlight">
          <div class="mc-label">Live NAV</div>
          <div class="mc-value mc-big">${liveNav !== null ? `₹${liveNav.toFixed(4)}` : '<span style="color:var(--text-dim);font-size:16px">Fetching…</span>'}</div>
          <div style="margin-top:6px">${changeHTML}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Snapshot NAV</div>
          <div class="mc-value mono">₹${Number(staticNav).toFixed(4)}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Live Date</div>
          <div class="mc-value mono">${escHtml(liveDate||scheme.date)}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Snapshot Date</div>
          <div class="mc-value mono">${escHtml(scheme.date)}</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">� Excel Matched Fund Profile</div>
      <div class="modal-cards">
        ${scheme.staticData ? `
          <div class="modal-card mc-full">
            <div class="mc-label">Static Data Match</div>
            <div class="mc-value" style="line-height:1.7;white-space:normal;font-size:13px">
              ${scheme.staticData.exitLoad ? `<div><strong>Exit Load:</strong> ${escHtml(scheme.staticData.exitLoad)}</div>` : ''}
              ${Array.isArray(scheme.staticData.amfiSectors) && scheme.staticData.amfiSectors.length ? `<div><strong>AMFI Sectors:</strong> ${scheme.staticData.amfiSectors.map(item => escHtml(item)).join(', ')}</div>` : ''}
              ${scheme.staticData.riskMeasures && Object.keys(scheme.staticData.riskMeasures).length ? `<div><strong>Risk Measures:</strong> ${Object.entries(scheme.staticData.riskMeasures).map(([k,v]) => `${escHtml(k)}: ${escHtml(v)}`).join(' | ')}</div>` : ''}
              ${scheme.staticData.marketCapitalisation && Object.keys(scheme.staticData.marketCapitalisation).length ? `<div><strong>Market Cap:</strong> ${Object.entries(scheme.staticData.marketCapitalisation).map(([k,v]) => `${escHtml(k)}: ${escHtml(v)}`).join(' | ')}</div>` : ''}
            </div>
          </div>
        ` : `<div class="modal-card mc-full" style="color:var(--text-dim)">No matched Excel record for this scheme.</div>`}
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">�🔗 API Reference</div>
      <div class="modal-cards">
        <div class="modal-card mc-full">
          <div class="mc-label">Latest NAV Endpoint</div>
          <div class="mc-value mono mc-url">
            <span>${escHtml(scheme.url)}</span>
            <button class="btn-copy" onclick="copyToClipboard('${escJs(scheme.url)}',this)">Copy</button>
          </div>
        </div>
        <div class="modal-card mc-full">
          <div class="mc-label">Full History Endpoint</div>
          <div class="mc-value mono mc-url">
            <span>${escHtml(scheme.url.replace('/latest',''))}</span>
            <button class="btn-copy" onclick="copyToClipboard('${escJs(scheme.url.replace('/latest',''))}',this)">Copy</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">📊 Returns (CAGR)</div>
      <div class="modal-cards" id="modalReturnsContainer">
        <div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">Calculating returns for every year of available history…</div>
      </div>

      <div style="margin-top:14px;padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div style="font-size:11px;font-weight:600;color:var(--text-sub);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">📅 Custom Date Range Return</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:130px">
            <label style="font-size:10.5px;color:var(--text-sub);display:block;margin-bottom:4px">From Date</label>
            <input type="date" id="modalReturnFromDate" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:#fff;font-size:13px;font-family:var(--font);color:var(--text)"/>
          </div>
          <div style="flex:1;min-width:130px">
            <label style="font-size:10.5px;color:var(--text-sub);display:block;margin-bottom:4px">To Date</label>
            <input type="date" id="modalReturnToDate" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:#fff;font-size:13px;font-family:var(--font);color:var(--text)"/>
          </div>
          <button class="btn-copy" style="padding:8px 20px;flex-shrink:0" onclick="calculateCustomRangeReturn('${escJs(scheme.code)}')">Calculate</button>
        </div>
        <div id="modalCustomReturnResult" style="margin-top:12px"></div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>🔄 Rolling Returns</span>
        <button class="btn-copy" onclick="exportSchemeRollingReturns('${escJs(scheme.code)}')">📥 Export</button>
      </div>
      <div style="font-size:11.5px;color:var(--text-dim);margin:-6px 0 10px">
        CAGR calculated for every month-start over the scheme's full history — shows how consistent returns have actually been, not just a single point-in-time number.
      </div>
      <div class="modal-cards" id="modalRollingReturnsContainer">
        <div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">Calculating rolling returns…</div>
      </div>
    </div>`;

  $('modalBackdrop').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  loadSchemeReturns(scheme.code);
  loadSchemeRollingReturns(scheme.code);
}

async function loadSchemeReturns(code) {
  const container = document.getElementById('modalReturnsContainer');
  if (!container) return;

  try {
    const endpoint = syncBarState.oldSyncMode
      ? `/api/nav/cached-returns/${encodeURIComponent(code)}`
      : `/api/nav/returns/${encodeURIComponent(code)}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      throw new Error(err.error || 'Failed to fetch returns');
    }
    const data = await res.json();

    if (!data.returns || data.returns.length === 0) {
      container.innerHTML = `<div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">Returns data not available for this scheme</div>`;
      return;
    }

    // Guard against a stale response landing after the modal was reused for another scheme
    if (!$('modalBackdrop') || $('modalBackdrop').classList.contains('hidden')) return;

    const badge = data.cached
      ? `<div style="grid-column:1/-1;font-size:10.5px;color:${data.stale ? '#92400e' : 'var(--text-dim)'};margin-bottom:2px">📦 ${data.stale ? 'Live data unavailable — showing' : 'Cached'} as of ${escHtml(new Date(data.computedAt).toLocaleString())}</div>`
      : '';

    container.innerHTML = badge + data.returns.map(r => {
      if (!r.available) {
        return `
          <div class="modal-card">
            <div class="mc-label">${r.label} Return</div>
            <div class="mc-value" style="color:var(--text-dim);font-size:14px">Not enough history</div>
          </div>`;
      }
      const cls  = r.cagrPct >= 0 ? 'nav-up' : 'nav-down';
      const sign = r.cagrPct >= 0 ? '+' : '';
      return `
        <div class="modal-card">
          <div class="mc-label">${r.label} Return</div>
          <div class="mc-value ${cls}" style="font-size:19px;font-weight:700">${sign}${r.cagrPct}%</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px">from ₹${r.fromNav} on ${escHtml(r.fromDate)}</div>
        </div>`;
    }).join('');
  } catch (error) {
    console.error('Error loading returns:', error);
    if (container) {
      const msg = 'Unable to load returns data right now';
      container.innerHTML = `<div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">${msg}</div>`;
    }
  }
}

async function calculateCustomRangeReturn(code) {
  const fromInput = document.getElementById('modalReturnFromDate');
  const toInput   = document.getElementById('modalReturnToDate');
  const resultBox = document.getElementById('modalCustomReturnResult');
  if (!fromInput || !toInput || !resultBox) return;

  const from = fromInput.value;
  const to   = toInput.value;

  if (!from || !to) {
    resultBox.innerHTML = `<div style="color:var(--red);font-size:12.5px">Please select both From and To dates.</div>`;
    return;
  }
  if (from >= to) {
    resultBox.innerHTML = `<div style="color:var(--red);font-size:12.5px">From date must be earlier than To date.</div>`;
    return;
  }

  resultBox.innerHTML = `<div style="color:var(--text-dim);font-size:12.5px">Calculating…</div>`;

  try {
    const [returnRes, rollingRes] = await Promise.all([
      fetch(`/api/nav/returns/${encodeURIComponent(code)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      fetch(`/api/nav/rolling-returns/${encodeURIComponent(code)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    ]);
    const data = await returnRes.json();
    if (!returnRes.ok) throw new Error(data.error || 'Failed to calculate return');
    const rollingData = await rollingRes.json().catch(() => null);

    // Guard against a stale response landing after the modal was closed/reused
    if (!$('modalBackdrop') || $('modalBackdrop').classList.contains('hidden')) return;

    if (data.customError) {
      resultBox.innerHTML = `<div style="color:var(--red);font-size:12.5px">${escHtml(data.customError)}</div>`;
      return;
    }

    const c = data.custom;
    if (!c) {
      resultBox.innerHTML = `<div style="color:var(--red);font-size:12.5px">No NAV data available for this range.</div>`;
      return;
    }

    const cls  = c.cagrPct >= 0 ? 'nav-up' : 'nav-down';
    const sign = c.cagrPct >= 0 ? '+' : '';

    let rollingHtml = '';
    const cr = rollingRes && rollingRes.ok && rollingData ? rollingData.customRolling : null;
    const crError = rollingData && rollingData.customRollingError;

    if (crError) {
      rollingHtml = `<div style="color:var(--red);font-size:12px;margin-top:10px">${escHtml(crError)}</div>`;
    } else if (cr && cr.available) {
      const rCls  = cr.avgReturn >= 0 ? 'nav-up' : 'nav-down';
      const rSign = cr.avgReturn >= 0 ? '+' : '';
      rollingHtml = `
        <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)">
          <div style="font-size:10.5px;font-weight:600;color:var(--text-sub);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
            🔄 Rolling Return — same ${cr.spanYears}-yr span, repeated over every month-start (${cr.windowCount} windows)
          </div>
          <div class="modal-cards" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
            <div class="modal-card">
              <div class="mc-label">Average</div>
              <div class="mc-value ${rCls}" style="font-size:16px;font-weight:700">${rSign}${cr.avgReturn}%</div>
            </div>
            <div class="modal-card">
              <div class="mc-label">Median</div>
              <div class="mc-value" style="font-size:16px;font-weight:700">${cr.medianReturn}%</div>
            </div>
            <div class="modal-card">
              <div class="mc-label">Minimum</div>
              <div class="mc-value nav-down" style="font-size:16px;font-weight:700">${cr.minReturn}%</div>
            </div>
            <div class="modal-card">
              <div class="mc-label">Maximum</div>
              <div class="mc-value nav-up" style="font-size:16px;font-weight:700">${cr.maxReturn}%</div>
            </div>
            <div class="modal-card">
              <div class="mc-label">Positive %</div>
              <div class="mc-value" style="font-size:16px;font-weight:700">${cr.positivePct}%</div>
            </div>
          </div>
        </div>`;
    } else if (cr && !cr.available) {
      rollingHtml = `<div style="font-size:11.5px;color:var(--text-dim);margin-top:10px">Not enough history to roll this span across multiple windows.</div>`;
    }

    resultBox.innerHTML = `
      <div class="modal-cards" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="modal-card">
          <div class="mc-label">Absolute Return</div>
          <div class="mc-value ${cls}" style="font-size:17px;font-weight:700">${sign}${c.simpleReturnPct}%</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">Annualized (CAGR)</div>
          <div class="mc-value ${cls}" style="font-size:17px;font-weight:700">${sign}${c.cagrPct}%</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">NAV on ${escHtml(c.fromDate)}</div>
          <div class="mc-value mono">₹${c.fromNav}</div>
        </div>
        <div class="modal-card">
          <div class="mc-label">NAV on ${escHtml(c.toDate)}</div>
          <div class="mc-value mono">₹${c.toNav}</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:8px">
        ${c.days} days (${c.years} yrs) between the nearest available trading dates to your selected range
        ${(c.fromDate !== from || c.toDate !== to) ? ' (matched to nearest trading days since markets are closed on weekends/holidays)' : ''}.
      </div>
      ${rollingHtml}`;
  } catch (error) {
    console.error('Custom return calc error:', error);
    resultBox.innerHTML = `<div style="color:var(--red);font-size:12.5px">${escHtml(error.message || 'Unable to calculate return')}</div>`;
  }
}

async function exportSchemeReturns() {
  const scheme = state.currentModalScheme;
  if (!scheme) return;

  const btn = document.getElementById('modalExportReturnsBtn');
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '⏳ Exporting…';
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.7';
  }

  const fromInput = document.getElementById('modalReturnFromDate');
  const toInput   = document.getElementById('modalReturnToDate');
  const from = fromInput ? fromInput.value : '';
  const to   = toInput ? toInput.value : '';

  let url = `/api/nav/returns/${encodeURIComponent(scheme.code)}/export`;
  if (from && to) {
    url += `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Export failed');
    }
    const blob = await response.blob();
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = `Scheme_Details_${scheme.code}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(dlUrl);
  } catch (error) {
    console.error('Export returns error:', error);
    alert('Failed to export returns: ' + error.message);
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
  }
}

async function exportSchemeRollingReturns(code) {
  const btn = document.querySelector(`.btn-copy[onclick*="exportSchemeRollingReturns('${escJs(code)}')"]`);
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '⏳'; btn.style.pointerEvents = 'none'; }

  try {
    const response = await fetch(`/api/nav/rolling-returns/${encodeURIComponent(code)}/export`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Export failed');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RollingReturns_${code}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export rolling returns error:', error);
    alert('Failed to export rolling returns: ' + error.message);
  } finally {
    if (btn) { btn.textContent = originalText; btn.style.pointerEvents = ''; }
  }
}

async function loadSchemeRollingReturns(code) {
  const container = document.getElementById('modalRollingReturnsContainer');
  if (!container) return;

  try {
    const endpoint = syncBarState.oldSyncMode
      ? `/api/nav/cached-rolling-returns/${encodeURIComponent(code)}`
      : `/api/nav/rolling-returns/${encodeURIComponent(code)}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      throw new Error(err.error || 'Failed to fetch rolling returns');
    }
    const data = await res.json();

    // Guard against a stale response landing after the modal was closed/reused
    if (!$('modalBackdrop') || $('modalBackdrop').classList.contains('hidden')) return;

    if (!data.rolling || data.rolling.length === 0) {
      container.innerHTML = `<div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">Rolling returns data not available for this scheme</div>`;
      return;
    }

    const badge = data.cached
      ? `<div style="grid-column:1/-1;font-size:10.5px;color:${data.stale ? '#92400e' : 'var(--text-dim)'};margin-bottom:2px">📦 ${data.stale ? 'Live data unavailable — showing' : 'Cached'} as of ${escHtml(new Date(data.computedAt).toLocaleString())}</div>`
      : '';

    container.innerHTML = badge + data.rolling.map(r => {
      if (!r.available) {
        return `
          <div class="modal-card">
            <div class="mc-label">${r.label} Rolling Return</div>
            <div class="mc-value" style="color:var(--text-dim);font-size:14px">Not enough history</div>
          </div>`;
      }
      const cls = r.avgReturn >= 0 ? 'nav-up' : 'nav-down';
      const sign = r.avgReturn >= 0 ? '+' : '';
      return `
        <div class="modal-card">
          <div class="mc-label">${r.label} Rolling Return <span style="color:var(--text-dim);font-weight:400">(${r.windowCount} windows)</span></div>
          <div class="mc-value ${cls}" style="font-size:19px;font-weight:700">${sign}${r.avgReturn}% <span style="font-size:11px;font-weight:500;color:var(--text-dim)">avg</span></div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap">
            <span>Min: <b style="color:var(--text-sub)">${r.minReturn}%</b></span>
            <span>Median: <b style="color:var(--text-sub)">${r.medianReturn}%</b></span>
            <span>Max: <b style="color:var(--text-sub)">${r.maxReturn}%</b></span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px">Positive in <b style="color:var(--text-sub)">${r.positivePct}%</b> of ${r.label} windows</div>
        </div>`;
    }).join('');
  } catch (error) {
    console.error('Error loading rolling returns:', error);
    if (container) {
      const msg = 'Unable to load rolling returns right now';
      container.innerHTML = `<div class="modal-card mc-full" style="text-align:center;color:var(--text-dim)">${msg}</div>`;
    }
  }
}

function closeModal(e) {
  if (e && e.target !== $('modalBackdrop')) return;
  $('modalBackdrop').classList.add('hidden');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1800);
  });
}

/* ─── WELCOME PAGE FUNCTIONS ────────────────────────── */

async function loadWelcomeSchemes() {
  const params = new URLSearchParams({
    page: welcomeState.page,
    limit: welcomeState.limit,
    search: welcomeState.filters.search,
    code: welcomeState.filters.code,
    fundHouse: welcomeState.filters.fundHouse,
    schemeType: welcomeState.filters.schemeType,
    plan: welcomeState.filters.plan,
    option: welcomeState.filters.option,
    category: welcomeState.filters.category,
      industry: welcomeState.filters.industry,
    minNav: welcomeState.filters.minNav,
    maxNav: welcomeState.filters.maxNav,
    sortBy: welcomeState.filters.sortBy,
    stdDevBucket: welcomeState.filters.stdDevBucket,
    betaBucket: welcomeState.filters.betaBucket,
    sharpeBucket: welcomeState.filters.sharpeBucket,
    jensenBucket: welcomeState.filters.jensenBucket,
    largeCapBucket: welcomeState.filters.largeCapBucket,
    midCapBucket: welcomeState.filters.midCapBucket,
    smallCapBucket: welcomeState.filters.smallCapBucket,
    cashBucket: welcomeState.filters.cashBucket
  });
  
  $('welcomeTableBody').innerHTML = `<tr class="loader-row"><td colspan="50">Loading schemes…</td></tr>`;
  
  const response = await fetch(`/api/all-schemes?${params}`);
  const data = await response.json();
  
  if (data.error) {
    $('welcomeTableBody').innerHTML = `<tr class="empty-row"><td colspan="50">Error loading schemes.</td></tr>`;
    return;
  }
  
  const offset = (welcomeState.page - 1) * welcomeState.limit;
  welcomeState.total = data.total;
  
  $('welcomeResultsMeta').textContent = data.total === 0
    ? 'No schemes match your filters.'
    : `Showing ${offset+1}–${Math.min(welcomeState.page*welcomeState.limit, data.total)} of ${data.total.toLocaleString()} schemes`;
  
  renderWelcomeTable(data.schemes, offset);
  renderWelcomePagination(data.totalPages);
  renderWelcomeFilterTags();
}

async function fetchWelcomeLiveNAVs(schemes) {
  const toFetch = schemes.map(s => s.code);
  if (!toFetch.length) return;

  try {
    const res = await fetch(`/api/live-nav?codes=${toFetch.join(',')}`);
    const live = await res.json();
    live.forEach(item => {
      if (item.live && item.nav) {
        const navCell = document.querySelector(`#welcomeTableBody td.nav-cell[data-code="${item.code}"]`);
        if (navCell) {
          const staticNav = schemes.find(s => s.code === item.code)?.nav || 0;
          navCell.innerHTML = navHTML(parseFloat(item.nav).toFixed(4), parseFloat(item.nav), staticNav);
        }
        const dateCell = document.querySelector(`#welcomeTableBody td.date-cell[data-code="${item.code}"]`);
        if (dateCell && item.date) {
          dateCell.textContent = item.date;
        }
      }
    });
  } catch (error) {
    console.error('Error fetching live NAVs for welcome page:', error);
  }
}

// #/Scheme Name/AMC/Category get a fixed width each so columns line up
// cleanly, but they scroll along with everything else — no sticky/frozen
// columns here, the whole table moves together as one row of horizontal
// scroll (that's the actual ask: "poora table hi scroll hona chahiye").
let cyLastSchemes = [];
let cyLastOffset = 0;

const CY_FREEZE_WIDTH = { index: 44, name: 230, amc: 160, category: 190 };
function cyFreezeCols() {
  return [
    ['index', '#'], ['name', 'Scheme Name'], ['amc', 'AMC'], ['category', 'Category']
  ];
}

function cyFreezeOffsets() {
  let left = 0;
  return cyFreezeCols().map(([id, label]) => {
    const offset = left;
    left += CY_FREEZE_WIDTH[id];
    return [id, label, offset];
  });
}
function cyFreezeStyle(left, w) {
  return `width:${w}px;min-width:${w}px;max-width:${w}px`;
}

// Union of every period label present across the current page's schemes
// (however many years of history each one happens to have), ordered
// chronologically — matches the same approach used by the Excel export.
function cyPeriodUnion(schemes, field = 'returns') {
  const months = new Map();
  schemes.forEach(s => (s[field] || []).forEach(r => {
    if (r.available && !months.has(r.label)) months.set(r.label, r.months);
  }));
  return [...months.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
}

function updateCalendarReturnPeriodFilter(id, periods) {
  const select = $(id);
  // A browser can briefly serve an older cached HTML shell alongside the
  // latest script after a deploy. Do not let absent optional controls stop
  // the schemes table from rendering in that case.
  if (!select) return '';
  const previous = select.value;
  select.replaceChildren(new Option('All Periods', ''), ...periods.map(period => new Option(period, period)));
  select.value = periods.includes(previous) ? previous : '';
  return select.value;
}

function cyReturnCell(returns, label, keyField) {
  const entry = (returns || []).find(r => r.label === label && r.available);
  if (!entry) return `<td class="cy-num">—</td>`;
  const value = entry[keyField];
  const cls = value >= 0 ? 'up' : 'down';
  const sign = value >= 0 ? '+' : '';
  return `<td class="cy-num ${cls}">${sign}${value}%</td>`;
}

function renderWelcomeTable(schemes, offset) {
  cyLastSchemes = schemes;
  cyLastOffset = offset;

  const freeze = cyFreezeOffsets();
  const availableCagrPeriods = cyPeriodUnion(schemes, 'returns');
  const availableRollingPeriods = cyPeriodUnion(schemes, 'rolling');
  const selectedCagrPeriod = updateCalendarReturnPeriodFilter('welcomeFilterCagrPeriod', availableCagrPeriods);
  const selectedRollingPeriod = updateCalendarReturnPeriodFilter('welcomeFilterRollingPeriod', availableRollingPeriods);
  welcomeState.filters.cagrPeriod = selectedCagrPeriod;
  welcomeState.filters.rollingPeriod = selectedRollingPeriod;
  const cagrPeriods = selectedCagrPeriod ? [selectedCagrPeriod] : availableCagrPeriods;
  const rollingPeriods = selectedRollingPeriod ? [selectedRollingPeriod] : availableRollingPeriods;
  const showCagr = cagrPeriods.length > 0;
  const showRolling = rollingPeriods.length > 0;
  const groupCols = cagrPeriods.length + rollingPeriods.length;

  const groupHeaders = [
    showCagr ? `<th colspan="${cagrPeriods.length}">Return (CAGR)</th>` : '',
    showRolling ? `<th colspan="${rollingPeriods.length}">Rolling Return</th>` : ''
  ].join('');
  const periodHeaderRow = [
    showCagr ? cagrPeriods.map(p => `<th>${escHtml(p)}</th>`).join('') : '',
    showRolling ? rollingPeriods.map(p => `<th>${escHtml(p)}</th>`).join('') : ''
  ].join('');

  $('welcomeTableHead').innerHTML = `
    <tr>
      ${freeze.map(([id, label, left]) => `<th rowspan="2" class="col-freeze" style="${cyFreezeStyle(left, CY_FREEZE_WIDTH[id])}">${label}</th>`).join('')}
      ${groupHeaders}
      <th colspan="4" class="static-group-heading">Risk Measures</th>
      <th colspan="4" class="static-group-heading">Market Capitalisation(%)</th>
      <th colspan="5" class="static-group-heading">AMFI Sectors(%)</th>
      <th rowspan="2" class="static-group-heading">Exit Load</th>
      <th rowspan="2">Action</th>
    </tr>
    <tr>
      ${periodHeaderRow}
      <th>Std.Dev</th><th>Beta (Slope)</th><th>Sharpe</th><th>Jenson</th>
      <th>Large Cap</th><th>Mid Cap</th><th>Small Cap</th><th>Cash</th>
      <th>1st Sector</th><th>2nd Sector</th><th>3rd Sector</th><th>4th Sector</th><th>5th Sector</th>
    </tr>`;

  const totalCols = freeze.length + groupCols + 15;

    if (!schemes.length) {
      $('welcomeTableBody').innerHTML = `<tr class="empty-row"><td colspan="${totalCols}">No results. Try adjusting your filters.</td></tr>`;
      return;
    }

    $('welcomeTableBody').innerHTML = schemes.map((s, i) => {
      const freezeCells = freeze.map(([id, , left]) => {
        const w = CY_FREEZE_WIDTH[id];
        const content = id === 'index' ? offset + i + 1
          : id === 'name' ? escHtml(s.name)
          : id === 'amc' ? escHtml(s.fundHouse || '—')
          : escHtml(s.category || '—');
        return `<td class="col-freeze" style="${cyFreezeStyle(left, w)}">${content}</td>`;
      }).join('');

      let returnCells = '';
      if (groupCols > 0) {
        returnCells = !s.returnsSynced
          ? `<td class="cy-empty" colspan="${groupCols}">Not synced yet — run Sync</td>`
          : (showCagr ? cagrPeriods.map(p => cyReturnCell(s.returns, p, 'cagrPct')).join('') : '') +
            (showRolling ? rollingPeriods.map(p => cyReturnCell(s.rolling, p, 'avgReturn')).join('') : '');
      }

      const staticColumns = staticProfileColumns(s);

      return `<tr>
        ${freezeCells}
        ${returnCells}
        ${staticColumns}
      <td class="td-actions">
        <button class="btn-view" onclick='openModal(${JSON.stringify(schemeForModal(s))})'>View</button>
        <button class="btn-export" onclick='exportScheme("${escJs(s.code)}")' title="Export latest NAV">📥</button>
      </td>
    </tr>`;
  }).join('');
}

// Only the fields the detail modal actually needs — the table's own
// Return CAGR / Rolling Return columns already carry s.returns/s.rolling,
// which the modal doesn't use (it fetches its own via the API once
// opened), so they're dropped here to keep this inline JSON small.
function schemeForModal(s) {
  const { returns, rolling, returnsSynced, ...rest } = s;
  return rest;
}

function staticProfileSummary(s) {
  const staticData = s && s.staticData ? s.staticData : null;
  if (!staticData) return '<span style="color:var(--text-dim)">No Excel profile matched</span>';

  const entries = [];
  if (staticData.exitLoad) entries.push(`Exit: ${escHtml(staticData.exitLoad)}`);
  if (Array.isArray(staticData.amfiSectors) && staticData.amfiSectors.length) {
    entries.push(`Sectors: ${staticData.amfiSectors.slice(0, 2).map(escHtml).join(', ')}`);
  }
  const riskEntries = staticData.riskMeasures ? Object.entries(staticData.riskMeasures).slice(0, 2) : [];
  if (riskEntries.length) {
    entries.push(`Risk: ${riskEntries.map(([k, v]) => `${escHtml(k)} ${escHtml(v)}`).join(' | ')}`);
  }
  const marketEntries = staticData.marketCapitalisation ? Object.entries(staticData.marketCapitalisation).slice(0, 2) : [];
  if (marketEntries.length) {
    entries.push(`MCap: ${marketEntries.map(([k, v]) => `${escHtml(k)} ${escHtml(v)}`).join(' | ')}`);
  }

  return entries.length ? entries.join('<br>') : '<span style="color:var(--text-dim)">Profile available</span>';
}

function staticProfileCell(value, emptyText = '—') {
  const safeValue = value && String(value).trim() ? value : emptyText;
  return `<div class="static-value-box">${escHtml(safeValue)}</div>`;
}

function staticProfileList(items, emptyText = '—') {
  if (!Array.isArray(items) || !items.length) {
    return `<div class="static-empty">${emptyText}</div>`;
  }

  return `<div class="static-profile-sidebar">${items.map(item => `<div class="static-mini-tag">${escHtml(item)}</div>`).join('')}</div>`;
}

function staticProfileMapEntries(map, emptyText = '—') {
  const entries = map && typeof map === 'object' ? Object.entries(map) : [];
  if (!entries.length) {
    return `<div class="static-empty">${emptyText}</div>`;
  }

  return `<div class="static-profile-sidebar">${entries.map(([key, value]) => `<div class="static-item-row"><span class="static-item-key">${escHtml(key)}</span><span class="static-item-value">${escHtml(value)}</span></div>`).join('')}</div>`;
}

function staticProfileColumns(s) {
  const staticData = s && s.staticData ? s.staticData : null;
  const risk = staticData?.riskMeasures || {};
  const market = staticData?.marketCapitalisation || {};
  const sectors = staticData?.amfiSectors || [];
  const value = (item) => `<td class="td-static">${escHtml(formatProfileNumber(item))}</td>`;

  if (!staticData) {
    return Array.from({ length: 14 }, () => value('—')).join('');
  }

  return [
    value(risk['Std.Dev']), value(risk['Beta (Slope)']), value(risk.Sharpe), value(risk.Jenson),
    value(market['Large Cap']), value(market['Mid Cap']), value(market['Small Cap']), value(market.Cash),
    ...Array.from({ length: 5 }, (_, index) => value(sectors[index])),
    value(staticData.exitLoad)
  ].join('');
}
function formatProfileNumber(value) {
  if (value == null || String(value).trim() === '') return '—';
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Math.abs(Number(text)).toFixed(3) : value;
}

function renderWelcomePagination(totalPages) {
  if (totalPages <= 1) { $('welcomePagination').innerHTML = ''; return; }
  const cur = welcomeState.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p=>p>=1&&p<=totalPages));
  const sorted  = [...visible].sort((a,b)=>a-b);
  let html = `<button class="page-btn" onclick="goWelcomePage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goWelcomePage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goWelcomePage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  $('welcomePagination').innerHTML = html;
}

function goWelcomePage(p) {
  welcomeState.page = p;
  loadWelcomeSchemes();
  document.querySelector('.welcome').scrollIntoView({ behavior:'smooth', block:'start' });
}

function renderWelcomeFilterTags() {
  const labels = { search:'Name', code:'Code', fundHouse:'AMC', schemeType:'Type', plan:'Plan',
                   option:'Option', category:'Category', industry:'Industry', minNav:'Min NAV', maxNav:'Max NAV', sortBy:'Sort', cagrPeriod:'Return CAGR', rollingPeriod:'Rolling Return', stdDevBucket:'Std.Dev', betaBucket:'Beta', sharpeBucket:'Sharpe', jensenBucket:'Jensen', largeCapBucket:'Large Cap', midCapBucket:'Mid Cap', smallCapBucket:'Small Cap', cashBucket:'Cash' };
  // Plan/Option are a fixed, non-removable lock for non-admin users — don't
  // show them as a dismissible filter tag.
  const lockedKeys = isAdmin() ? [] : ['plan', 'option'];
  $('welcomeFilterTags').innerHTML = Object.entries(welcomeState.filters)
    .filter(([k,v]) => v !== '' && !lockedKeys.includes(k))
    .map(([k,v]) => `
      <span class="filter-tag">
        ${labels[k]}: <strong>${escHtml(v)}</strong>
        <button onclick="clearWelcomeFilter('${k}')">✕</button>
      </span>`).join('');
}

function clearWelcomeFilter(key) {
  if (!isAdmin() && (key === 'plan' || key === 'option')) return; // locked
  welcomeState.filters[key] = '';
  const el = { search:$('welcomeFilterSearch'), code:$('welcomeFilterCode'),
               fundHouse:$('welcomeFilterFundHouse'),
               schemeType:$('welcomeFilterSchemeType'), plan:$('welcomeFilterPlan'),
               option:$('welcomeFilterOption'), category:$('welcomeFilterCategory'),
               industry:$('welcomeFilterIndustry'),
               minNav:$('welcomeFilterMinNav'), maxNav:$('welcomeFilterMaxNav'),
               sortBy:$('welcomeFilterSort'), cagrPeriod:$('welcomeFilterCagrPeriod'),
               rollingPeriod:$('welcomeFilterRollingPeriod'), stdDevBucket:$('welcomeFilterStdDev'), betaBucket:$('welcomeFilterBeta'), sharpeBucket:$('welcomeFilterSharpe'), jensenBucket:$('welcomeFilterJensen'), largeCapBucket:$('welcomeFilterLargeCap'), midCapBucket:$('welcomeFilterMidCap'), smallCapBucket:$('welcomeFilterSmallCap'), cashBucket:$('welcomeFilterCash') }[key];
  if (el) el.value = '';
  welcomeState.page = 1;
  loadWelcomeSchemes();
}

function setupWelcomeFilters() {
  ['welcomeFilterSearch', 'welcomeFilterCode', 'welcomeFilterMinNav', 'welcomeFilterMaxNav'].forEach(id => {
    $(id).addEventListener('input', e => {
      const keyMap = {
        'welcomeFilterSearch': 'search',
        'welcomeFilterCode': 'code',
        'welcomeFilterMinNav': 'minNav',
        'welcomeFilterMaxNav': 'maxNav'
      };
      welcomeState.filters[keyMap[id]] = e.target.value;
      welcomeState.page = 1;
      debounce(loadWelcomeSchemes);
    });
  });
  
  ['welcomeFilterFundHouse', 'welcomeFilterSchemeType', 'welcomeFilterPlan', 'welcomeFilterOption', 'welcomeFilterCategory', 'welcomeFilterIndustry', 'welcomeFilterSort'].forEach(id => {
    $(id).addEventListener('change', e => {
      const keyMap = {
        'welcomeFilterFundHouse': 'fundHouse',
        'welcomeFilterSchemeType': 'schemeType',
        'welcomeFilterPlan': 'plan',
        'welcomeFilterOption': 'option',
        'welcomeFilterCategory': 'category',
        'welcomeFilterIndustry': 'industry',
        'welcomeFilterSort': 'sortBy'
      };
      welcomeState.filters[keyMap[id]] = e.target.value;
      welcomeState.page = 1;
      loadWelcomeSchemes();
    });
  });
  [['welcomeFilterCagrPeriod', 'cagrPeriod'], ['welcomeFilterRollingPeriod', 'rollingPeriod']].forEach(([id, key]) => {
    const control = $(id);
    if (!control) return;
    control.addEventListener('change', event => {
      welcomeState.filters[key] = event.target.value;
      renderWelcomeTable(cyLastSchemes, cyLastOffset);
      renderWelcomeFilterTags();
    });
  });
  [['welcomeFilterStdDev', 'stdDevBucket'], ['welcomeFilterBeta', 'betaBucket'], ['welcomeFilterSharpe', 'sharpeBucket'], ['welcomeFilterJensen', 'jensenBucket'], ['welcomeFilterLargeCap', 'largeCapBucket'], ['welcomeFilterMidCap', 'midCapBucket'], ['welcomeFilterSmallCap', 'smallCapBucket'], ['welcomeFilterCash', 'cashBucket']].forEach(([id, key]) => {
    const control = $(id);
    if (!control) return;
    control.addEventListener('change', event => {
      welcomeState.filters[key] = event.target.value;
      welcomeState.page = 1;
      loadWelcomeSchemes();
    });
  });
  
  $('welcomeFilterReset').addEventListener('click', () => {
    welcomeState.filters = { search:'', code:'', fundHouse:'', schemeType:'', plan:'', option:'', category:'', industry:'', minNav:'', maxNav:'', sortBy:'', cagrPeriod:'', rollingPeriod:'', stdDevBucket:'', betaBucket:'', sharpeBucket:'', jensenBucket:'', largeCapBucket:'', midCapBucket:'', smallCapBucket:'', cashBucket:'' };
    ['welcomeFilterSearch','welcomeFilterCode','welcomeFilterMinNav','welcomeFilterMaxNav'].forEach(id => $(id).value = '');
    ['welcomeFilterFundHouse','welcomeFilterSchemeType','welcomeFilterPlan','welcomeFilterOption','welcomeFilterCategory','welcomeFilterIndustry','welcomeFilterSort','welcomeFilterCagrPeriod','welcomeFilterRollingPeriod','welcomeFilterStdDev','welcomeFilterBeta','welcomeFilterSharpe','welcomeFilterJensen','welcomeFilterLargeCap','welcomeFilterMidCap','welcomeFilterSmallCap','welcomeFilterCash'].forEach(id => $(id).value = '');

    // Non-admins stay locked to Plan=Regular / Option=Growth even after
    // a reset — this restriction never gets cleared by the Reset button.
    if (!isAdmin()) {
      welcomeState.filters.plan = 'Regular';
      welcomeState.filters.option = 'Growth';
      $('welcomeFilterPlan').value = 'Regular';
      $('welcomeFilterOption').value = 'Growth';
    }

    $('welcomeFilterTags').innerHTML = '';
    welcomeState.page = 1;
    loadWelcomeSchemes();
  });
}

/* ─── RULE ENGINE (NAV Ledger) — embedded in-page via iframe ────────
   Same session/cookies apply automatically (same-origin), so this opens
   straight to the dashboard — no separate login, no new tab. */
function openRuleEngineDashboard() {
  document.getElementById('vanguardDashboard').classList.add('hidden');
  document.getElementById('upvalyDashboard').classList.add('hidden');
  document.getElementById('calendarCagrDashboard').classList.add('hidden');
  document.getElementById('calendarSipDashboard').classList.add('hidden');
  document.getElementById('fundView').classList.add('hidden');
  document.querySelector('.welcome').style.display = 'none';
  $('topHomeNav').classList.remove('hidden');

  const frame = document.getElementById('ruleEngineFrame');
  // Only (re)load the iframe the first time — switching away and back
  // shouldn't reset filters/scroll position inside it.
  if (!frame.dataset.loaded) {
    frame.src = '/nav-ledger/index.html';
    frame.dataset.loaded = '1';
  }
  document.getElementById('ruleEngineDashboard').classList.remove('hidden');
}

function closeRuleEngineDashboard() {
  document.getElementById('ruleEngineDashboard').classList.add('hidden');
  document.querySelector('.welcome').style.display = '';
  $('topHomeNav').classList.add('hidden');
  showDashboardIndex();
}

/* ─── CALENDAR YEAR CAGR & ROLLING RETURN — embedded in-page via iframe,
   same pattern as the Rule Engine above. ────────────────────────────── */
function openCalendarCagrDashboard() {
  document.getElementById('vanguardDashboard').classList.add('hidden');
  document.getElementById('upvalyDashboard').classList.add('hidden');
  document.getElementById('ruleEngineDashboard').classList.add('hidden');
  document.getElementById('calendarSipDashboard').classList.add('hidden');
  document.getElementById('fundView').classList.add('hidden');
  document.querySelector('.welcome').style.display = 'none';
  $('topHomeNav').classList.remove('hidden');

  const frame = document.getElementById('calendarCagrFrame');
  if (!frame.dataset.loaded) {
    frame.src = '/nav-ledger/calendar-returns.html';
    frame.dataset.loaded = '1';
  }
  document.getElementById('calendarCagrDashboard').classList.remove('hidden');
}

function closeCalendarCagrDashboard() {
  document.getElementById('calendarCagrDashboard').classList.add('hidden');
  document.querySelector('.welcome').style.display = '';
  $('topHomeNav').classList.add('hidden');
  showDashboardIndex();
}

/* ─── CALENDAR YEAR SIP & LUMPSUM — embedded in-page via iframe, same
   pattern as the Rule Engine above. ─────────────────────────────────── */
function openCalendarSipDashboard() {
  document.getElementById('vanguardDashboard').classList.add('hidden');
  document.getElementById('upvalyDashboard').classList.add('hidden');
  document.getElementById('ruleEngineDashboard').classList.add('hidden');
  document.getElementById('calendarCagrDashboard').classList.add('hidden');
  document.getElementById('fundView').classList.add('hidden');
  document.querySelector('.welcome').style.display = 'none';
  $('topHomeNav').classList.remove('hidden');

  const frame = document.getElementById('calendarSipFrame');
  if (!frame.dataset.loaded) {
    frame.src = '/nav-ledger/calendar-sip-lumpsum.html';
    frame.dataset.loaded = '1';
  }
  document.getElementById('calendarSipDashboard').classList.remove('hidden');
}

function closeCalendarSipDashboard() {
  document.getElementById('calendarSipDashboard').classList.add('hidden');
  document.querySelector('.welcome').style.display = '';
  $('topHomeNav').classList.add('hidden');
  showDashboardIndex();
}

function updateSidebarForZerodha() {
  if (!$('fundList')) return; // sidebar removed
  if (zerodhaState.amcs.length === 0) {
    $('fundList').innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--text-sub);font-size:13px;">
        <div style="margin-bottom:8px;">⏳ Loading AMCs…</div>
        <div style="font-size:11px;">Please refresh to load data</div>
      </div>
    `;
    return;
  }
  
  const amcCounts = {};
  zerodhaState.data.forEach(item => {
    const amc = item.amc || item.AMC || 'Unknown';
    amcCounts[amc] = (amcCounts[amc] || 0) + 1;
  });
  
  $('fundList').innerHTML = Object.keys(amcCounts).sort().map(amc => `
    <div class="fund-item ${zerodhaState.selectedAMC === amc ? 'active' : ''}"
         onclick="filterZerodhaByAMC('${escJs(amc)}')">
      <span class="fund-item-name">${escHtml(amc)}</span>
      <span class="fund-item-badge">${amcCounts[amc]}</span>
    </div>
  `).join('');
}

function filterZerodhaByAMC(amc) {
  zerodhaState.selectedAMC = amc;
  document.getElementById('zerodhaAMCFilter').value = amc;
  zerodhaState.page = 1;
  applyZerodhaFilters();
  updateSidebarForZerodha();
}

async function exportAllZerodhaData() {
  const btn = document.querySelector('.btn-export-zerodha');
  btn.classList.add('loading');
  btn.textContent = '⏳ Preparing…';
  
  try {
    const dataToExport = zerodhaState.filteredData.length > 0 ? zerodhaState.filteredData : zerodhaState.data;
    if (dataToExport.length === 0) {
      alert('No data to export. Please load data first.');
      return;
    }
    
    const wsData = [
      ['Trading Symbol', 'AMC', 'Scheme Name', 'Purchase Allowed', 'Redemption Allowed',
       'Min Purchase Amount', 'Min Additional Purchase', 'Min Redemption Qty',
       'Dividend Type', 'Scheme Type', 'Plan', 'Settlement Type', 'NAV (₹)', 'NAV Date']
    ];
    
    dataToExport.forEach(item => {
      wsData.push([
        item.tradingsymbol || 'N/A',
        item.amc || item.AMC || 'N/A',
        item.name || 'N/A',
        item.purchase_allowed === '1' ? 'Yes' : 'No',
        item.redemption_allowed === '1' ? 'Yes' : 'No',
        item.minimum_purchase_amount || 'N/A',
        item.minimum_additional_purchase_amount || 'N/A',
        item.minimum_redemption_quantity || 'N/A',
        item.dividend_type || 'N/A',
        item.scheme_type || 'N/A',
        item.plan || 'N/A',
        item.settlement_type || 'N/A',
        item.last_price || 'N/A',
        item.last_price_date || 'N/A'
      ]);
    });
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      {wch:18}, {wch:30}, {wch:50}, {wch:15}, {wch:18},
      {wch:20}, {wch:22}, {wch:18}, {wch:15}, {wch:15},
      {wch:12}, {wch:15}, {wch:15}, {wch:15}
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Zerodha Instruments');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().slice(0,10);
    const filename = `Zerodha_Instruments_${timestamp}.xlsx`;
    
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export data. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = '⬇ Export All (Excel)';
    }, 2000);
  }
}

async function exportAllZerodhaDataFromServer() {
  const btn = document.querySelector('.btn-export-zerodha');
  if (!btn) return;

  btn.classList.add('loading');
  btn.textContent = 'Preparing...';

  try {
    const response = await fetch('/api/zerodha/export-all');
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Export failed (HTTP ${response.status})`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Zerodha_Instruments_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Zerodha export failed:', error);
    alert('Failed to export data. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = 'Export All (Excel)';
    }, 500);
  }
}

function viewZerodhaInstrument(symbol) {
  const item = zerodhaState.data.find(d => (d.tradingsymbol || '') === symbol);
  if (!item) {
    alert('Instrument not found');
    return;
  }
  
  const modalHtml = `
    <div class="zerodha-view-modal">
      <div class="zerodha-view-header">
        <h3>📊 Instrument Details</h3>
        <button onclick="closeZerodhaViewModal()" class="modal-close-btn">✕</button>
      </div>
      <div class="zerodha-view-body">
        <div class="view-grid">
          <div class="view-item">
            <span class="view-label">Trading Symbol</span>
            <span class="view-value highlight">${escHtml(item.tradingsymbol || 'N/A')}</span>
          </div>
          <div class="view-item full-width">
            <span class="view-label">Scheme Name</span>
            <span class="view-value">${escHtml(item.name || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">AMC</span>
            <span class="view-value">${escHtml(item.amc || item.AMC || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Scheme Type</span>
            <span class="view-value">${escHtml(item.scheme_type || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Plan</span>
            <span class="view-value"><span class="pill ${(item.plan || '').toLowerCase() === 'direct' ? 'pill-direct' : 'pill-regular'}">${escHtml(item.plan || 'N/A')}</span></span>
          </div>
          <div class="view-item">
            <span class="view-label">Dividend Type</span>
            <span class="view-value">${escHtml(item.dividend_type || 'N/A')}</span>
          </div>
          <div class="view-item highlight-nav">
            <span class="view-label">NAV (₹)</span>
            <span class="view-value nav-large">₹${parseFloat(item.last_price || 0).toFixed(4)}</span>
          </div>
          <div class="view-item">
            <span class="view-label">NAV Date</span>
            <span class="view-value">${escHtml(item.last_price_date || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Settlement</span>
            <span class="view-value">${escHtml(item.settlement_type || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Purchase Allowed</span>
            <span class="view-value ${item.purchase_allowed === '1' ? 'text-green' : 'text-red'}">${item.purchase_allowed === '1' ? '✅ Yes' : '❌ No'}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Redemption Allowed</span>
            <span class="view-value ${item.redemption_allowed === '1' ? 'text-green' : 'text-red'}">${item.redemption_allowed === '1' ? '✅ Yes' : '❌ No'}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Min Purchase</span>
            <span class="view-value">₹${item.minimum_purchase_amount || 'N/A'}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Min Redemption</span>
            <span class="view-value">${item.minimum_redemption_quantity || 'N/A'}</span>
          </div>
        </div>
      </div>
      <div class="zerodha-view-footer">
        <button onclick="closeZerodhaViewModal()" class="btn-modal-close">Close</button>
        <button onclick="exportZerodhaInstrument('${escJs(symbol)}')" class="btn-export">📥 Export</button>
      </div>
    </div>
  `;
  
  const modalContainer = document.createElement('div');
  modalContainer.id = 'zerodhaViewModal';
  modalContainer.className = 'modal-backdrop';
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);
  document.body.style.overflow = 'hidden';
}

function closeZerodhaViewModal() {
  const modal = document.getElementById('zerodhaViewModal');
  if (modal) {
    modal.remove();
    document.body.style.overflow = '';
  }
}

function renderZerodhaTable() {
  const tbody = document.getElementById('zerodhaTableBody');
  const start = (zerodhaState.page - 1) * zerodhaState.limit;
  const end = Math.min(start + zerodhaState.limit, zerodhaState.filteredData.length);
  const pageData = zerodhaState.filteredData.slice(start, end);
  
  if (!pageData.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No instruments match your filters.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = pageData.map((item, index) => {
    const nav = parseFloat(item.last_price || 0).toFixed(4);
    const name = item.name || 'N/A';
    const symbol = item.tradingsymbol || 'N/A';
    const amc = item.amc || item.AMC || 'N/A';
    const date = item.last_price_date || new Date().toISOString().slice(0, 10);
    const plan = item.plan || 'regular';
    const planClass = plan.toLowerCase() === 'direct' ? 'pill-direct' : 'pill-regular';
    
    return `
      <tr>
        <td class="td-index">${start + index + 1}</td>
        <td class="td-code" title="${escHtml(symbol)}">${escHtml(symbol)}</td>
        <td class="td-name">${escHtml(name)}</td>
        <td class="td-amc">${escHtml(amc)}</td>
        <td><span class="pill ${planClass}">${escHtml(plan)}</span></td>
        <td class="td-nav"><span class="nav-value">₹${nav}</span></td>
        <td class="td-date">${escHtml(date)}</td>
        <td class="td-actions">
          <button class="btn-view" onclick="viewZerodhaInstrument('${escJs(symbol)}')">View</button>
          <button class="btn-export" onclick="exportZerodhaInstrument('${escJs(symbol)}')" title="Export instrument data">📥</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderZerodhaPagination() {
  const totalPages = Math.ceil(zerodhaState.filteredData.length / zerodhaState.limit);
  const container = document.getElementById('zerodhaPagination');
  
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  const cur = zerodhaState.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...visible].sort((a,b) => a-b);
  
  let html = `<button class="page-btn" onclick="goZerodhaPage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goZerodhaPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goZerodhaPage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  container.innerHTML = html;
}

function goZerodhaPage(p) {
  zerodhaState.page = p;
  renderZerodhaTable();
  renderZerodhaPagination();
  document.querySelector('.zerodha-dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadZerodhaData() {
  if (zerodhaState.isLoading) return;
  zerodhaState.isLoading = true;
  
  const tbody = document.getElementById('zerodhaTableBody');
  tbody.innerHTML = `<tr class="loader-row"><td colspan="8">Fetching Zerodha instruments…</td></tr>`;
  document.getElementById('zerodhaMeta').textContent = 'Fetching data from Zerodha API…';

  try {
    const response = await fetch('/api/zerodha/instruments');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const contentType = response.headers.get('content-type');
    let data;
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = parseZerodhaCSV(text);
    }
    
    if (Array.isArray(data) && data.length > 0) {
      zerodhaState.data = data;
      zerodhaState.amcs = [...new Set(data.map(item => item.amc || item.AMC || ''))].filter(Boolean).sort();
      populateZerodhaAMCFilter(zerodhaState.amcs);
      populateZerodhaFilterOptions(data);
      updateSidebarForZerodha();
      document.getElementById('zerodhaMeta').textContent = `Loaded ${zerodhaState.data.length} instruments`;
      zerodhaState.page = 1;
      applyZerodhaFilters();
    } else {
      throw new Error('No data received from Zerodha API');
    }
    
  } catch (error) {
    console.error('Error loading Zerodha data:', error);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Failed to load Zerodha data. Please check the API endpoint.</td></tr>`;
    document.getElementById('zerodhaMeta').textContent = 'Error loading data';
  } finally {
    zerodhaState.isLoading = false;
  }
}

function parseZerodhaCSV(csvText) {
  const lines = csvText.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const headerLine = lines[0];
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
  
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const obj = {};
    headers.forEach((header, index) => {
      let value = values[index] ? values[index].trim() : '';
      if (header === 'last_price' || header === 'minimum_purchase_amount' || 
          header === 'purchase_amount_multiplier' || header === 'minimum_additional_purchase_amount' ||
          header === 'minimum_redemption_quantity' || header === 'redemption_quantity_multiplier') {
        value = parseFloat(value) || 0;
      }
      obj[header] = value;
    });
    result.push(obj);
  }
  return result;
}

function populateZerodhaAMCFilter(amcs) {
  const select = document.getElementById('zerodhaAMCFilter');
  select.innerHTML = '<option value="">All AMCs</option>';
  amcs.forEach(amc => {
    const option = document.createElement('option');
    option.value = amc;
    option.textContent = amc;
    select.appendChild(option);
  });
}

function populateZerodhaSelect(id, values, allLabel) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${allLabel}</option>`;
  values.forEach(v => {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = v;
    select.appendChild(option);
  });
  if (current && values.includes(current)) select.value = current;
}

function populateZerodhaFilterOptions(data) {
  zerodhaState.schemeTypes = [...new Set(data.map(item => item.scheme_type || ''))].filter(Boolean).sort();
  zerodhaState.plans = [...new Set(data.map(item => item.plan || ''))].filter(Boolean).sort();
  zerodhaState.dividendTypes = [...new Set(data.map(item => item.dividend_type || ''))].filter(Boolean).sort();
  zerodhaState.settlementTypes = [...new Set(data.map(item => item.settlement_type || ''))].filter(Boolean).sort();

  populateZerodhaSelect('zerodhaSchemeTypeFilter', zerodhaState.schemeTypes, 'All Types');
  populateZerodhaSelect('zerodhaPlanFilter', zerodhaState.plans, 'All Plans');
  populateZerodhaSelect('zerodhaDividendTypeFilter', zerodhaState.dividendTypes, 'All Dividend Types');
  populateZerodhaSelect('zerodhaSettlementTypeFilter', zerodhaState.settlementTypes, 'All Settlement Types');
}

function applyZerodhaFilters() {
  let data = [...zerodhaState.data];
  
  if (zerodhaState.selectedAMC) {
    data = data.filter(item => (item.amc || item.AMC || '') === zerodhaState.selectedAMC);
  }
  
  if (zerodhaState.search) {
    const searchTerm = zerodhaState.search.toLowerCase();
    data = data.filter(item => {
      const name = (item.name || '').toLowerCase();
      const tradingsymbol = (item.tradingsymbol || '').toLowerCase();
      return name.includes(searchTerm) || tradingsymbol.includes(searchTerm);
    });
  }

  if (zerodhaState.symbol) {
    const symbolTerm = zerodhaState.symbol.toLowerCase();
    data = data.filter(item => (item.tradingsymbol || '').toLowerCase().includes(symbolTerm));
  }

  if (zerodhaState.selectedSchemeType) {
    data = data.filter(item => (item.scheme_type || '') === zerodhaState.selectedSchemeType);
  }

  if (zerodhaState.selectedPlan) {
    data = data.filter(item => (item.plan || '') === zerodhaState.selectedPlan);
  }

  if (zerodhaState.selectedDividendType) {
    data = data.filter(item => (item.dividend_type || '') === zerodhaState.selectedDividendType);
  }

  if (zerodhaState.selectedSettlementType) {
    data = data.filter(item => (item.settlement_type || '') === zerodhaState.selectedSettlementType);
  }

  if (zerodhaState.purchaseAllowed !== '') {
    data = data.filter(item => String(item.purchase_allowed) === zerodhaState.purchaseAllowed);
  }

  if (zerodhaState.redemptionAllowed !== '') {
    data = data.filter(item => String(item.redemption_allowed) === zerodhaState.redemptionAllowed);
  }
  
  if (zerodhaState.minNav) {
    const min = parseFloat(zerodhaState.minNav);
    data = data.filter(item => parseFloat(item.last_price || 0) >= min);
  }
  if (zerodhaState.maxNav) {
    const max = parseFloat(zerodhaState.maxNav);
    data = data.filter(item => parseFloat(item.last_price || 0) <= max);
  }

  if (zerodhaState.navDate) {
    data = data.filter(item => (item.last_price_date || '') === zerodhaState.navDate);
  }

  if (zerodhaState.minPurchaseAmt) {
    const min = parseFloat(zerodhaState.minPurchaseAmt);
    data = data.filter(item => parseFloat(item.minimum_purchase_amount || 0) >= min);
  }
  if (zerodhaState.maxPurchaseAmt) {
    const max = parseFloat(zerodhaState.maxPurchaseAmt);
    data = data.filter(item => parseFloat(item.minimum_purchase_amount || 0) <= max);
  }

  if (zerodhaState.minAdditionalPurchase) {
    const min = parseFloat(zerodhaState.minAdditionalPurchase);
    data = data.filter(item => parseFloat(item.minimum_additional_purchase_amount || 0) >= min);
  }
  if (zerodhaState.maxAdditionalPurchase) {
    const max = parseFloat(zerodhaState.maxAdditionalPurchase);
    data = data.filter(item => parseFloat(item.minimum_additional_purchase_amount || 0) <= max);
  }

  if (zerodhaState.minRedemptionQty) {
    const min = parseFloat(zerodhaState.minRedemptionQty);
    data = data.filter(item => parseFloat(item.minimum_redemption_quantity || 0) >= min);
  }
  if (zerodhaState.maxRedemptionQty) {
    const max = parseFloat(zerodhaState.maxRedemptionQty);
    data = data.filter(item => parseFloat(item.minimum_redemption_quantity || 0) <= max);
  }
  
  data.sort((a, b) => {
    const aName = a.name || '';
    const bName = b.name || '';
    const aNav = parseFloat(a.last_price || 0);
    const bNav = parseFloat(b.last_price || 0);
    const aSymbol = a.tradingsymbol || '';
    const bSymbol = b.tradingsymbol || '';
    const aAmc = a.amc || a.AMC || '';
    const bAmc = b.amc || b.AMC || '';
    const aDate = a.last_price_date || '';
    const bDate = b.last_price_date || '';
    
    switch(zerodhaState.sortBy) {
      case 'name':
        return aName.localeCompare(bName);
      case 'name_desc':
        return bName.localeCompare(aName);
      case 'nav_asc':
        return aNav - bNav;
      case 'nav_desc':
        return bNav - aNav;
      case 'symbol':
        return aSymbol.localeCompare(bSymbol);
      case 'symbol_desc':
        return bSymbol.localeCompare(aSymbol);
      case 'amc':
        return aAmc.localeCompare(bAmc);
      case 'amc_desc':
        return bAmc.localeCompare(aAmc);
      case 'date_asc':
        return aDate.localeCompare(bDate);
      case 'date_desc':
        return bDate.localeCompare(aDate);
      default:
        return 0;
    }
  });
  
  zerodhaState.filteredData = data;
  renderZerodhaTable();
  renderZerodhaPagination();
  renderZerodhaFilterTags();
}

function setupZerodhaFilters() {
  let zDt;
  const zDebounce = (fn, ms = 300) => { clearTimeout(zDt); zDt = setTimeout(fn, ms); };

  document.getElementById('zerodhaSearch').addEventListener('input', e => {
    zerodhaState.search = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaSymbolFilter').addEventListener('input', e => {
    zerodhaState.symbol = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });
  
  document.getElementById('zerodhaAMCFilter').addEventListener('change', e => {
    zerodhaState.selectedAMC = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaSchemeTypeFilter').addEventListener('change', e => {
    zerodhaState.selectedSchemeType = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaPlanFilter').addEventListener('change', e => {
    zerodhaState.selectedPlan = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaDividendTypeFilter').addEventListener('change', e => {
    zerodhaState.selectedDividendType = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaSettlementTypeFilter').addEventListener('change', e => {
    zerodhaState.selectedSettlementType = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaPurchaseAllowedFilter').addEventListener('change', e => {
    zerodhaState.purchaseAllowed = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaRedemptionAllowedFilter').addEventListener('change', e => {
    zerodhaState.redemptionAllowed = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });
  
  document.getElementById('zerodhaMinNav').addEventListener('input', e => {
    zerodhaState.minNav = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });
  
  document.getElementById('zerodhaMaxNav').addEventListener('input', e => {
    zerodhaState.maxNav = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaNavDateFilter').addEventListener('change', e => {
    zerodhaState.navDate = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaMinPurchaseAmt').addEventListener('input', e => {
    zerodhaState.minPurchaseAmt = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaMaxPurchaseAmt').addEventListener('input', e => {
    zerodhaState.maxPurchaseAmt = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaMinAdditionalPurchase').addEventListener('input', e => {
    zerodhaState.minAdditionalPurchase = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaMaxAdditionalPurchase').addEventListener('input', e => {
    zerodhaState.maxAdditionalPurchase = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaMinRedemptionQty').addEventListener('input', e => {
    zerodhaState.minRedemptionQty = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });

  document.getElementById('zerodhaMaxRedemptionQty').addEventListener('input', e => {
    zerodhaState.maxRedemptionQty = e.target.value;
    zerodhaState.page = 1;
    zDebounce(applyZerodhaFilters);
  });
  
  document.getElementById('zerodhaSort').addEventListener('change', e => {
    zerodhaState.sortBy = e.target.value;
    zerodhaState.page = 1;
    applyZerodhaFilters();
  });

  document.getElementById('zerodhaFilterReset').addEventListener('click', resetZerodhaFilters);
}

/* ─── ZERODHA FILTER TAGS & RESET ────────────────────── */
const ZERODHA_FILTER_META = {
  search:               { label: 'Search',              elId: 'zerodhaSearch' },
  symbol:                { label: 'Symbol',              elId: 'zerodhaSymbolFilter' },
  selectedAMC:           { label: 'AMC',                 elId: 'zerodhaAMCFilter' },
  selectedSchemeType:    { label: 'Scheme Type',         elId: 'zerodhaSchemeTypeFilter' },
  selectedPlan:          { label: 'Plan',                elId: 'zerodhaPlanFilter' },
  selectedDividendType:  { label: 'Dividend Type',       elId: 'zerodhaDividendTypeFilter' },
  selectedSettlementType:{ label: 'Settlement Type',     elId: 'zerodhaSettlementTypeFilter' },
  purchaseAllowed:       { label: 'Purchase Allowed',    elId: 'zerodhaPurchaseAllowedFilter', display: v => v === '1' ? 'Yes' : 'No' },
  redemptionAllowed:     { label: 'Redemption Allowed',  elId: 'zerodhaRedemptionAllowedFilter', display: v => v === '1' ? 'Yes' : 'No' },
  minNav:                { label: 'Min NAV',             elId: 'zerodhaMinNav' },
  maxNav:                { label: 'Max NAV',             elId: 'zerodhaMaxNav' },
  navDate:               { label: 'NAV Date',            elId: 'zerodhaNavDateFilter' },
  minPurchaseAmt:        { label: 'Min Purchase Amt',    elId: 'zerodhaMinPurchaseAmt' },
  maxPurchaseAmt:        { label: 'Max Purchase Amt',    elId: 'zerodhaMaxPurchaseAmt' },
  minAdditionalPurchase: { label: 'Min Additional Purchase', elId: 'zerodhaMinAdditionalPurchase' },
  maxAdditionalPurchase: { label: 'Max Additional Purchase', elId: 'zerodhaMaxAdditionalPurchase' },
  minRedemptionQty:      { label: 'Min Redemption Qty',  elId: 'zerodhaMinRedemptionQty' },
  maxRedemptionQty:      { label: 'Max Redemption Qty',  elId: 'zerodhaMaxRedemptionQty' }
};

function renderZerodhaFilterTags() {
  const container = document.getElementById('zerodhaFilterTags');
  if (!container) return;
  container.innerHTML = Object.entries(ZERODHA_FILTER_META)
    .filter(([key]) => zerodhaState[key] !== '' && zerodhaState[key] !== undefined && zerodhaState[key] !== null)
    .map(([key, meta]) => {
      const raw = zerodhaState[key];
      const display = meta.display ? meta.display(raw) : raw;
      return `
        <span class="filter-tag">
          ${meta.label}: <strong>${escHtml(String(display))}</strong>
          <button onclick="clearZerodhaFilter('${key}')">✕</button>
        </span>`;
    }).join('');
}

function clearZerodhaFilter(key) {
  zerodhaState[key] = '';
  const meta = ZERODHA_FILTER_META[key];
  if (meta) {
    const el = document.getElementById(meta.elId);
    if (el) el.value = '';
  }
  zerodhaState.page = 1;
  applyZerodhaFilters();
}

function resetZerodhaFilters() {
  Object.keys(ZERODHA_FILTER_META).forEach(key => { zerodhaState[key] = ''; });
  Object.values(ZERODHA_FILTER_META).forEach(meta => {
    const el = document.getElementById(meta.elId);
    if (el) el.value = '';
  });
  zerodhaState.sortBy = 'name';
  document.getElementById('zerodhaSort').value = 'name';
  zerodhaState.page = 1;
  applyZerodhaFilters();
}

async function exportZerodhaInstrument(symbol) {
  const btn = document.querySelector(`.btn-export[onclick*="${symbol}"]`);
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = '⏳';
  }
  
  try {
    const response = await fetch(`/api/zerodha/export/${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error('Export failed');
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Zerodha_${symbol}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export instrument data');
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = '📥';
    }
  }
}

/* ─── VANGUARD DASHBOARD FUNCTIONS ────────────────────── */

function openVanguardDashboard() {
  document.getElementById('vanguardDashboard').classList.remove('hidden');
  document.querySelector('.welcome').style.display = 'none';
  document.getElementById('upvalyDashboard').classList.add('hidden');
  document.getElementById('ruleEngineDashboard').classList.add('hidden');
  document.getElementById('calendarCagrDashboard').classList.add('hidden');
  document.getElementById('calendarSipDashboard').classList.add('hidden');
  $('topHomeNav').classList.remove('hidden');
  updateSidebarForVanguard();
  
  if (vanguardState.data.length === 0) {
    loadVanguardData();
  } else {
    applyVanguardFilters();
  }
}

function closeVanguardDashboard() {
  document.getElementById('vanguardDashboard').classList.add('hidden');
  document.querySelector('.welcome').style.display = '';
  $('topHomeNav').classList.add('hidden');
  showDashboardIndex();
}

function updateSidebarForVanguard() {
  if (!$('fundList')) return; // sidebar removed
  if (vanguardState.companies.length === 0) {
    const companies = new Set();
    vanguardState.data.forEach(item => {
      const name = item['Fund name'] || '';
      let company = name;
      if (name.includes(' Index')) {
        company = name.split(' Index')[0];
      } else if (name.includes(' Fund')) {
        company = name.split(' Fund')[0];
      } else if (name.includes(' ETF')) {
        company = name.split(' ETF')[0];
      } else if (name.includes(',')) {
        company = name.split(',')[0];
      }
      const parts = company.split(' ');
      if (parts.length > 2) {
        company = parts.slice(0, 2).join(' ');
      }
      if (company && company.length > 2) {
        companies.add(company.trim());
      }
    });
    vanguardState.companies = [...companies].sort();
  }
  
  if (vanguardState.companies.length === 0) {
    $('fundList').innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--text-sub);font-size:13px;">
        <div style="margin-bottom:8px;">⏳ Loading Vanguard funds…</div>
        <div style="font-size:11px;">Please refresh to load data</div>
      </div>
    `;
    return;
  }
  
  const companyCounts = {};
  vanguardState.data.forEach(item => {
    const name = item['Fund name'] || '';
    let company = name;
    if (name.includes(' Index')) {
      company = name.split(' Index')[0];
    } else if (name.includes(' Fund')) {
      company = name.split(' Fund')[0];
    } else if (name.includes(' ETF')) {
      company = name.split(' ETF')[0];
    } else if (name.includes(',')) {
      company = name.split(',')[0];
    }
    const parts = company.split(' ');
    if (parts.length > 2) {
      company = parts.slice(0, 2).join(' ');
    }
    company = company.trim();
    if (company && company.length > 2) {
      companyCounts[company] = (companyCounts[company] || 0) + 1;
    }
  });
  
  $('fundList').innerHTML = Object.keys(companyCounts).sort().map(company => `
    <div class="fund-item ${vanguardState.selectedCompany === company ? 'active' : ''}"
         onclick="filterVanguardByCompany('${escJs(company)}')">
      <span class="fund-item-name">${escHtml(company)}</span>
      <span class="fund-item-badge">${companyCounts[company]}</span>
    </div>
  `).join('');
}

function filterVanguardByCompany(company) {
  vanguardState.selectedCompany = company;
  document.getElementById('vanguardCompanyFilter').value = company;
  vanguardState.page = 1;
  applyVanguardFilters();
  updateSidebarForVanguard();
}

function loadVanguardData() {
  if (vanguardState.isLoading) return;
  vanguardState.isLoading = true;
  
  const tbody = document.getElementById('vanguardTableBody');
  tbody.innerHTML = `<tr class="loader-row"><td colspan="10">Loading Vanguard funds…</td></tr>`;
  document.getElementById('vanguardMeta').textContent = 'Loading Vanguard data…';

  try {
    fetch('/api/vanguard/funds')
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          vanguardState.data = data;
          const companies = new Set();
          data.forEach(item => {
            const name = item['Fund name'] || '';
            let company = name;
            if (name.includes(' Index')) {
              company = name.split(' Index')[0];
            } else if (name.includes(' Fund')) {
              company = name.split(' Fund')[0];
            } else if (name.includes(' ETF')) {
              company = name.split(' ETF')[0];
            } else if (name.includes(',')) {
              company = name.split(',')[0];
            }
            const parts = company.split(' ');
            if (parts.length > 2) {
              company = parts.slice(0, 2).join(' ');
            }
            company = company.trim();
            if (company && company.length > 2) {
              companies.add(company);
            }
          });
          vanguardState.companies = [...companies].sort();
          
          const select = document.getElementById('vanguardCompanyFilter');
          select.innerHTML = '<option value="">All Companies</option>';
          vanguardState.companies.forEach(c => {
            const option = document.createElement('option');
            option.value = c;
            option.textContent = c;
            select.appendChild(option);
          });
          
          document.getElementById('vanguardMeta').textContent = `Loaded ${vanguardState.data.length} funds`;
          vanguardState.page = 1;
          updateSidebarForVanguard();
          applyVanguardFilters();
        } else {
          throw new Error('No data received from Vanguard');
        }
      })
      .catch(error => {
        console.error('Error loading Vanguard data:', error);
        tbody.innerHTML = `<tr class="empty-row"><td colspan="10">Failed to load Vanguard data: ${error.message}</td></tr>`;
        document.getElementById('vanguardMeta').textContent = 'Unable to load the current Vanguard data.';
      })
      .finally(() => {
        vanguardState.isLoading = false;
      });
  } catch (error) {
    console.error('Error loading Vanguard data:', error);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">Failed to load Vanguard data: ${error.message}</td></tr>`;
    document.getElementById('vanguardMeta').textContent = 'Error loading data';
    vanguardState.isLoading = false;
  }
}

function applyVanguardFilters() {
  let data = [...vanguardState.data];
  
  if (vanguardState.selectedCompany) {
    data = data.filter(item => {
      const name = item['Fund name'] || '';
      let company = name;
      if (name.includes(' Index')) {
        company = name.split(' Index')[0];
      } else if (name.includes(' Fund')) {
        company = name.split(' Fund')[0];
      } else if (name.includes(' ETF')) {
        company = name.split(' ETF')[0];
      } else if (name.includes(',')) {
        company = name.split(',')[0];
      }
      const parts = company.split(' ');
      if (parts.length > 2) {
        company = parts.slice(0, 2).join(' ');
      }
      return company.trim() === vanguardState.selectedCompany;
    });
  }
  
  if (vanguardState.search) {
    const searchTerm = vanguardState.search.toLowerCase();
    data = data.filter(item => {
      const name = (item['Fund name'] || '').toLowerCase();
      const symbol = (item.Symbol || '').toLowerCase();
      return name.includes(searchTerm) || symbol.includes(searchTerm);
    });
  }
  
  if (vanguardState.minYTD) {
    const min = parseFloat(vanguardState.minYTD);
    data = data.filter(item => {
      const ytd = parseFloat(item.YTD);
      return !isNaN(ytd) && ytd >= min;
    });
  }
  if (vanguardState.maxYTD) {
    const max = parseFloat(vanguardState.maxYTD);
    data = data.filter(item => {
      const ytd = parseFloat(item.YTD);
      return !isNaN(ytd) && ytd <= max;
    });
  }
  
  if (vanguardState.maxExpense) {
    const max = parseFloat(vanguardState.maxExpense);
    data = data.filter(item => {
      const expense = parseFloat(item['Expense Ratio']);
      return !isNaN(expense) && expense <= max;
    });
  }
  
  data.sort((a, b) => {
    const aName = a['Fund name'] || '';
    const bName = b['Fund name'] || '';
    const aYTD = parseFloat(a.YTD) || 0;
    const bYTD = parseFloat(b.YTD) || 0;
    const aExpense = parseFloat(a['Expense Ratio']) || 0;
    const bExpense = parseFloat(b['Expense Ratio']) || 0;
    const aReturn1Y = parseFloat(a['1Y']) || 0;
    const bReturn1Y = parseFloat(b['1Y']) || 0;
    
    switch(vanguardState.sortBy) {
      case 'name':
        return aName.localeCompare(bName);
      case 'name_desc':
        return bName.localeCompare(aName);
      case 'ytd_asc':
        return aYTD - bYTD;
      case 'ytd_desc':
        return bYTD - aYTD;
      case 'expense_asc':
        return aExpense - bExpense;
      case 'expense_desc':
        return bExpense - aExpense;
      case 'return_1y_asc':
        return aReturn1Y - bReturn1Y;
      case 'return_1y_desc':
        return bReturn1Y - aReturn1Y;
      default:
        return 0;
    }
  });
  
  vanguardState.filteredData = data;
  renderVanguardTable();
  renderVanguardPagination();
  updateVanguardMeta();
}

function updateVanguardMeta() {
  const total = vanguardState.filteredData.length;
  const start = (vanguardState.page - 1) * vanguardState.limit;
  const end = Math.min(start + vanguardState.limit, total);
  document.getElementById('vanguardMeta').textContent = total === 0 
    ? 'No funds match your filters.'
    : `Showing ${start + 1}–${end} of ${total.toLocaleString()} funds`;
}

function renderVanguardTable() {
  const tbody = document.getElementById('vanguardTableBody');
  const start = (vanguardState.page - 1) * vanguardState.limit;
  const end = Math.min(start + vanguardState.limit, vanguardState.filteredData.length);
  const pageData = vanguardState.filteredData.slice(start, end);
  
  if (!pageData.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">No funds match your filters.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = pageData.map((item, index) => {
    const symbol = item.Symbol || 'N/A';
    const name = item['Fund name'] || 'N/A';
    const ytd = item.YTD || 'N/A';
    const return1Y = item['1Y'] || 'N/A';
    const return3Y = item['3Y'] || 'N/A';
    const return5Y = item['5Y'] || 'N/A';
    const expense = item['Expense Ratio'] || 'N/A';
    const secYield = item['SEC Yield'] || 'N/A';
    
    const ytdNum = parseFloat(ytd);
    const ytdClass = !isNaN(ytdNum) ? (ytdNum > 0 ? 'text-green' : (ytdNum < 0 ? 'text-red' : '')) : '';
    
    return `
      <tr>
        <td class="td-index">${start + index + 1}</td>
        <td class="td-code">${escHtml(symbol)}</td>
        <td class="td-name">${escHtml(name)}</td>
        <td class="${ytdClass}">${ytd}%</td>
        <td>${return1Y}%</td>
        <td>${return3Y}%</td>
        <td>${return5Y}%</td>
        <td>${expense}%</td>
        <td>${escHtml(secYield)}</td>
        <td class="td-actions">
          <button class="btn-view" onclick="viewVanguardFund('${escJs(symbol)}')">View</button>
          <button class="btn-export" onclick="exportVanguardFund('${escJs(symbol)}')" title="Export fund data">📥</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderVanguardPagination() {
  const totalPages = Math.ceil(vanguardState.filteredData.length / vanguardState.limit);
  const container = document.getElementById('vanguardPagination');
  
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  const cur = vanguardState.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...visible].sort((a,b) => a-b);
  
  let html = `<button class="page-btn" onclick="goVanguardPage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goVanguardPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goVanguardPage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  container.innerHTML = html;
}

function goVanguardPage(p) {
  vanguardState.page = p;
  renderVanguardTable();
  renderVanguardPagination();
  document.querySelector('.vanguard-dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Vanguard's own data already gives annualized (i.e. CAGR-equivalent)
// returns for each period, so no extra math is needed here — just a
// card matching this app's "Return (CAGR)" styling used elsewhere.
function vanguardCagrCard(label, rawValue) {
  const value = parseFloat(rawValue);
  const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== '' && !isNaN(value);
  const cls = hasValue && value >= 0 ? 'nav-up' : hasValue ? 'nav-down' : '';
  const sign = hasValue && value >= 0 ? '+' : '';
  return `
    <div class="modal-card">
      <div class="mc-label">${escHtml(label)}</div>
      <div class="mc-value ${cls}" style="font-size:16px;font-weight:700">${hasValue ? `${sign}${rawValue}%` : '—'}</div>
    </div>`;
}

function viewVanguardFund(symbol) {
  const item = vanguardState.data.find(d => (d.Symbol || '') === symbol);
  if (!item) {
    alert('Fund not found');
    return;
  }
  
  const modalHtml = `
    <div class="vanguard-view-modal">
      <div class="vanguard-view-header">
        <h3>📊 ${escHtml(item['Fund name'] || 'Fund Details')}</h3>
        <button onclick="closeVanguardViewModal()" class="modal-close-btn">✕</button>
      </div>
      <div class="vanguard-view-body">
        <div class="view-grid">
          <div class="view-item">
            <span class="view-label">Symbol</span>
            <span class="view-value highlight">${escHtml(item.Symbol || 'N/A')}</span>
          </div>
          <div class="view-item full-width">
            <span class="view-label">Fund Name</span>
            <span class="view-value">${escHtml(item['Fund name'] || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Expense Ratio</span>
            <span class="view-value">${item['Expense Ratio'] || 'N/A'}%</span>
          </div>
          <div class="view-item">
            <span class="view-label">SEC Yield</span>
            <span class="view-value">${escHtml(item['SEC Yield'] || 'N/A')}</span>
          </div>
          <div class="view-item">
            <span class="view-label">Dividend</span>
            <span class="view-value">${item.Dividend || 'N/A'}</span>
          </div>
          <div class="view-item full-width">
            <span class="view-label">Benchmark</span>
            <span class="view-value">${escHtml(item.Benchmark || 'N/A')}</span>
          </div>
        </div>

        <div class="modal-section-title">📈 &nbsp;Return (CAGR)</div>
        <div class="modal-cards" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
          ${vanguardCagrCard('YTD', item.YTD)}
          ${vanguardCagrCard('1 Year', item['1Y'])}
          ${vanguardCagrCard('3 Year', item['3Y'])}
          ${vanguardCagrCard('5 Year', item['5Y'])}
          ${vanguardCagrCard('10 Year', item['10Y'])}
          ${vanguardCagrCard('Since Inception', item['Since Inception'])}
        </div>
        <div class="rolling-unavailable-note">
          ⓘ Rolling Return isn't shown here — it needs full historical NAV data, and Vanguard's own data source only provides point-in-time returns (no daily/monthly price history), so it genuinely can't be calculated for these funds.
        </div>
      </div>
      <div class="vanguard-view-footer">
        <button onclick="closeVanguardViewModal()" class="btn-modal-close">Close</button>
        <button onclick="exportVanguardFund('${escJs(symbol)}')" class="btn-export">📥 Export</button>
      </div>
    </div>
  `;
  
  const modalContainer = document.createElement('div');
  modalContainer.id = 'vanguardViewModal';
  modalContainer.className = 'modal-backdrop';
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);
  document.body.style.overflow = 'hidden';
}

function closeVanguardViewModal() {
  const modal = document.getElementById('vanguardViewModal');
  if (modal) {
    modal.remove();
    document.body.style.overflow = '';
  }
}

async function exportVanguardFund(symbol) {
  const btn = document.querySelector(`.btn-export[onclick*="${symbol}"]`);
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = '⏳';
  }
  
  try {
    const response = await fetch(`/api/vanguard/export/${encodeURIComponent(symbol)}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Export failed');
    }
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Vanguard_${symbol}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export fund data: ' + error.message);
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = '📥';
    }
  }
}

async function exportAllVanguardData() {
  const btn = document.querySelector('.btn-export-vanguard');
  if (!btn) return;
  btn.classList.add('loading');
  btn.textContent = '⏳ Preparing…';
  
  try {
    const response = await fetch('/api/vanguard/export-all');
    if (!response.ok) throw new Error('Export failed');
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Vanguard_Funds_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export data. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = '⬇ Export All (Excel)';
    }, 2000);
  }
}

function setupVanguardFilters() {
  document.getElementById('vanguardSearch').addEventListener('input', e => {
    vanguardState.search = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
  });
  
  document.getElementById('vanguardCompanyFilter').addEventListener('change', e => {
    vanguardState.selectedCompany = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
    updateSidebarForVanguard();
  });
  
  document.getElementById('vanguardMinYTD').addEventListener('input', e => {
    vanguardState.minYTD = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
  });
  
  document.getElementById('vanguardMaxYTD').addEventListener('input', e => {
    vanguardState.maxYTD = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
  });
  
  document.getElementById('vanguardMaxExpense').addEventListener('input', e => {
    vanguardState.maxExpense = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
  });
  
  document.getElementById('vanguardSort').addEventListener('change', e => {
    vanguardState.sortBy = e.target.value;
    vanguardState.page = 1;
    applyVanguardFilters();
  });
}

/* ─── UPVALY DASHBOARD FUNCTIONS ─────────────────────── */

function openUpvalyDashboard() {
  document.getElementById('upvalyDashboard').classList.remove('hidden');
  document.querySelector('.welcome').style.display = 'none';
  document.getElementById('vanguardDashboard').classList.add('hidden');
  document.getElementById('ruleEngineDashboard').classList.add('hidden');
  document.getElementById('calendarCagrDashboard').classList.add('hidden');
  document.getElementById('calendarSipDashboard').classList.add('hidden');
  $('topHomeNav').classList.remove('hidden');
  updateSidebarForUpvaly();
  switchUpvalyTab(upvalyActiveTab, true);
}

function closeUpvalyDashboard() {
  document.getElementById('upvalyDashboard').classList.add('hidden');
  document.querySelector('.welcome').style.display = '';
  $('topHomeNav').classList.add('hidden');
  showDashboardIndex();
}

function updateSidebarForUpvaly() {
  if (!$('fundList')) return; // sidebar removed
  const items = [
    { key: 'ipo', label: 'IPOs', badge: upvalyIpoState.data.length },
    { key: 'holidays', label: 'Exchange Holidays', badge: upvalyHolidayState.data.length }
  ];
  $('fundList').innerHTML = items.map(item => `
    <div class="fund-item ${upvalyActiveTab === item.key ? 'active' : ''}"
         onclick="switchUpvalyTab('${item.key}')">
      <span class="fund-item-name">${escHtml(item.label)}</span>
      <span class="fund-item-badge">${item.badge || ''}</span>
    </div>
  `).join('');
}

function switchUpvalyTab(tab, force) {
  if (!force && upvalyActiveTab === tab) return;
  upvalyActiveTab = tab;

  document.querySelectorAll('.upvaly-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab));

  $('upvalyPaneIpo').classList.toggle('hidden', tab !== 'ipo');
  $('upvalyPaneHolidays').classList.toggle('hidden', tab !== 'holidays');

  updateSidebarForUpvaly();

  if (tab === 'ipo') {
    if (upvalyIpoState.data.length === 0) loadUpvalyIpoData(); else applyUpvalyIpoFilters();
  } else if (tab === 'holidays') {
    if (upvalyHolidayState.data.length === 0) loadUpvalyHolidayData(); else applyUpvalyHolidayFilters();
  }
}

/* ── Upvaly IPOs ── */

function loadUpvalyIpoData() {
  if (upvalyIpoState.isLoading) return;
  upvalyIpoState.isLoading = true;

  const tbody = $('upvalyIpoTableBody');
  tbody.innerHTML = `<tr class="loader-row"><td colspan="11">Loading Upvaly IPOs…</td></tr>`;
  $('upvalyIpoMeta').textContent = 'Loading Upvaly IPO data…';

  fetch('/api/upvaly/ipo')
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data)) throw new Error('No data received from Upvaly IPO API');
      upvalyIpoState.data = data;

      const types = new Set(), statuses = new Set();
      data.forEach(d => {
        if (d.Type) types.add(d.Type);
        if (d.Status) statuses.add(d.Status);
      });
      upvalyIpoState.types = [...types].sort();
      upvalyIpoState.statuses = [...statuses].sort();

      const typeSelect = $('upvalyIpoTypeFilter');
      typeSelect.innerHTML = '<option value="">All Types</option>' +
        upvalyIpoState.types.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
      const statusSelect = $('upvalyIpoStatusFilter');
      statusSelect.innerHTML = '<option value="">All Statuses</option>' +
        upvalyIpoState.statuses.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');

      upvalyIpoState.page = 1;
      updateSidebarForUpvaly();
      applyUpvalyIpoFilters();
    })
    .catch(error => {
      console.error('Error loading Upvaly IPO data:', error);
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11">Failed to load Upvaly IPO data: ${escHtml(error.message)}</td></tr>`;
      $('upvalyIpoMeta').textContent = 'Unable to load the current Upvaly IPO data.';
    })
    .finally(() => { upvalyIpoState.isLoading = false; });
}

function applyUpvalyIpoFilters() {
  let data = [...upvalyIpoState.data];

  if (upvalyIpoState.selectedType) {
    data = data.filter(d => d.Type === upvalyIpoState.selectedType);
  }
  if (upvalyIpoState.selectedStatus) {
    data = data.filter(d => d.Status === upvalyIpoState.selectedStatus);
  }
  if (upvalyIpoState.search) {
    const term = upvalyIpoState.search.toLowerCase();
    data = data.filter(d =>
      (d.Name || '').toLowerCase().includes(term) ||
      (d.Symbol || '').toLowerCase().includes(term));
  }

  data.sort((a, b) => {
    switch (upvalyIpoState.sortBy) {
      case 'name': return (a.Name || '').localeCompare(b.Name || '');
      case 'name_desc': return (b.Name || '').localeCompare(a.Name || '');
      case 'status': return (a.Status || '').localeCompare(b.Status || '');
      case 'listing_asc': return (a['Listing Date'] || '').localeCompare(b['Listing Date'] || '');
      case 'listing_desc':
      default: return (b['Listing Date'] || '').localeCompare(a['Listing Date'] || '');
    }
  });

  upvalyIpoState.filteredData = data;
  renderUpvalyIpoTable();
  renderUpvalyIpoPagination();
  updateUpvalyIpoMeta();
}

function updateUpvalyIpoMeta() {
  const total = upvalyIpoState.filteredData.length;
  const start = (upvalyIpoState.page - 1) * upvalyIpoState.limit;
  const end = Math.min(start + upvalyIpoState.limit, total);
  $('upvalyIpoMeta').textContent = total === 0
    ? 'No IPOs match your filters.'
    : `Showing ${start + 1}–${end} of ${total} IPOs`;
}

function renderUpvalyIpoTable() {
  const tbody = $('upvalyIpoTableBody');
  const start = (upvalyIpoState.page - 1) * upvalyIpoState.limit;
  const end = Math.min(start + upvalyIpoState.limit, upvalyIpoState.filteredData.length);
  const pageData = upvalyIpoState.filteredData.slice(start, end);

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="11">No IPOs match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = pageData.map((ipo, i) => {
    const statusLower = (ipo.Status || '').toLowerCase();
    const statusClass = statusLower === 'live' ? 'pill-live' : statusLower === 'closed' ? 'pill-closed' : 'pill-upcoming';
    const symbol = ipo.Symbol || '';
    return `
      <tr>
        <td class="td-index">${start + i + 1}</td>
        <td class="td-name">${escHtml(ipo.Name || 'N/A')}</td>
        <td class="td-code">${escHtml(symbol || 'N/A')}</td>
        <td>${escHtml(ipo.Type || 'N/A')}</td>
        <td><span class="pill-ipo ${statusClass}">${escHtml(ipo.Status || 'N/A')}</span></td>
        <td>${escHtml(ipo['Price Range'] || 'N/A')}</td>
        <td>${escHtml(ipo['Lot Size'] || 'N/A')}</td>
        <td>${escHtml(ipo['Open Date'] || 'N/A')}</td>
        <td>${escHtml(ipo['Close Date'] || 'N/A')}</td>
        <td>${escHtml(ipo['Listing Date'] || 'N/A')}</td>
        <td class="td-actions">
          <button class="btn-view" onclick="viewUpvalyIpo('${escJs(symbol)}')">View</button>
          <button class="btn-export" onclick="exportUpvalyIpo('${escJs(symbol)}')" title="Export IPO data">📥</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderUpvalyIpoPagination() {
  const totalPages = Math.ceil(upvalyIpoState.filteredData.length / upvalyIpoState.limit);
  const container = $('upvalyIpoPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const cur = upvalyIpoState.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...visible].sort((a,b) => a-b);

  let html = `<button class="page-btn" onclick="goUpvalyIpoPage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goUpvalyIpoPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goUpvalyIpoPage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  container.innerHTML = html;
}

function goUpvalyIpoPage(p) {
  upvalyIpoState.page = p;
  renderUpvalyIpoTable();
  renderUpvalyIpoPagination();
  document.querySelector('.upvaly-dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function viewUpvalyIpo(symbol) {
  const item = upvalyIpoState.data.find(d => (d.Symbol || '') === symbol);
  if (!item) { alert('IPO not found'); return; }

  const modalHtml = `
    <div class="vanguard-view-modal">
      <div class="vanguard-view-header">
        <h3>🚀 ${escHtml(item.Name || 'IPO Details')}</h3>
        <button onclick="closeUpvalyViewModal()" class="modal-close-btn">✕</button>
      </div>
      <div class="vanguard-view-body">
        <div class="view-grid">
          <div class="view-item"><span class="view-label">Symbol</span><span class="view-value highlight">${escHtml(item.Symbol || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Type</span><span class="view-value">${escHtml(item.Type || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Status</span><span class="view-value">${escHtml(item.Status || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Price Range</span><span class="view-value">${escHtml(item['Price Range'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Lot Size</span><span class="view-value">${escHtml(item['Lot Size'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Issue Size (Cr.)</span><span class="view-value">${escHtml(item['Issue Size (Cr.)'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Open Date</span><span class="view-value">${escHtml(item['Open Date'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Close Date</span><span class="view-value">${escHtml(item['Close Date'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Listing Date</span><span class="view-value">${escHtml(item['Listing Date'] || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Exchanges</span><span class="view-value">${escHtml(item.Exchanges || 'N/A')}</span></div>
          <div class="view-item full-width"><span class="view-label">About</span><span class="view-value">${escHtml((item.aboutCompany || '').slice(0, 600) || 'N/A')}</span></div>
        </div>
      </div>
      <div class="vanguard-view-footer">
        ${item.detailsUrl ? `<a class="btn-api-link" href="${escHtml(item.detailsUrl)}" target="_blank" rel="noopener">Open Details ↗</a>` : ''}
        <button onclick="closeUpvalyViewModal()" class="btn-modal-close">Close</button>
        <button onclick="exportUpvalyIpo('${escJs(symbol)}')" class="btn-export">📥 Export</button>
      </div>
    </div>
  `;

  const modalContainer = document.createElement('div');
  modalContainer.id = 'upvalyViewModal';
  modalContainer.className = 'modal-backdrop';
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);
  document.body.style.overflow = 'hidden';
}

function closeUpvalyViewModal() {
  const modal = document.getElementById('upvalyViewModal');
  if (modal) {
    modal.remove();
    document.body.style.overflow = '';
  }
}

async function exportUpvalyIpo(symbol) {
  const btn = document.querySelector(`.btn-export[onclick*="exportUpvalyIpo('${escJs(symbol)}')"]`);
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = '⏳';
  }

  try {
    const response = await fetch(`/api/upvaly/ipo/export/${encodeURIComponent(symbol)}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Export failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Upvaly_IPO_${symbol}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export IPO data: ' + error.message);
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = originalText || '📥';
    }
  }
}

async function exportAllUpvalyIpoData(btn) {
  btn = btn || document.querySelector('#upvalyPaneIpo .btn-export-upvaly');
  if (!btn) return;
  btn.classList.add('loading');
  btn.textContent = '⏳ Preparing…';

  try {
    const response = await fetch('/api/upvaly/ipo/export-all');
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Upvaly_IPOs_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export data. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = '⬇ Export All (Excel)';
    }, 2000);
  }
}

/* ── Upvaly Exchange Holidays ── */

function loadUpvalyHolidayData() {
  if (upvalyHolidayState.isLoading) return;
  upvalyHolidayState.isLoading = true;

  const tbody = $('upvalyHolidayTableBody');
  tbody.innerHTML = `<tr class="loader-row"><td colspan="7">Loading Upvaly exchange holidays…</td></tr>`;
  $('upvalyHolidayMeta').textContent = 'Loading Upvaly holiday data…';

  fetch('/api/upvaly/holidays')
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data)) throw new Error('No data received from Upvaly holidays API');
      upvalyHolidayState.data = data;

      const types = new Set();
      data.forEach(d => { if (d.Type) types.add(d.Type); });
      upvalyHolidayState.types = [...types].sort();

      const select = $('upvalyHolidayTypeFilter');
      select.innerHTML = '<option value="">All Types</option>' +
        upvalyHolidayState.types.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');

      upvalyHolidayState.page = 1;
      updateSidebarForUpvaly();
      applyUpvalyHolidayFilters();
    })
    .catch(error => {
      console.error('Error loading Upvaly holiday data:', error);
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Failed to load Upvaly holiday data: ${escHtml(error.message)}</td></tr>`;
      $('upvalyHolidayMeta').textContent = 'Unable to load the current Upvaly holiday data.';
    })
    .finally(() => { upvalyHolidayState.isLoading = false; });
}

function applyUpvalyHolidayFilters() {
  let data = [...upvalyHolidayState.data];

  if (upvalyHolidayState.selectedType) {
    data = data.filter(d => d.Type === upvalyHolidayState.selectedType);
  }
  if (upvalyHolidayState.search) {
    const term = upvalyHolidayState.search.toLowerCase();
    data = data.filter(d => (d.Description || '').toLowerCase().includes(term));
  }

  data.sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));

  upvalyHolidayState.filteredData = data;
  renderUpvalyHolidayTable();
  renderUpvalyHolidayPagination();
  updateUpvalyHolidayMeta();
}

function updateUpvalyHolidayMeta() {
  const total = upvalyHolidayState.filteredData.length;
  const start = (upvalyHolidayState.page - 1) * upvalyHolidayState.limit;
  const end = Math.min(start + upvalyHolidayState.limit, total);
  $('upvalyHolidayMeta').textContent = total === 0
    ? 'No holidays match your filters.'
    : `Showing ${start + 1}–${end} of ${total} holidays`;
}

function renderUpvalyHolidayTable() {
  const tbody = $('upvalyHolidayTableBody');
  const start = (upvalyHolidayState.page - 1) * upvalyHolidayState.limit;
  const end = Math.min(start + upvalyHolidayState.limit, upvalyHolidayState.filteredData.length);
  const pageData = upvalyHolidayState.filteredData.slice(start, end);

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No holidays match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = pageData.map((h, i) => `
    <tr>
      <td class="td-index">${start + i + 1}</td>
      <td class="td-code">${escHtml(h.Date || 'N/A')}</td>
      <td class="td-name">${escHtml(h.Description || 'N/A')}</td>
      <td>${escHtml(h.Type || 'N/A')}</td>
      <td>${escHtml(h['Closed Exchanges'] || '—')}</td>
      <td>${escHtml(h['Open Exchanges'] || '—')}</td>
      <td class="td-actions">
        <button class="btn-view" onclick="viewUpvalyHoliday('${escJs(h.Date || '')}')">View</button>
        <button class="btn-export" onclick="exportUpvalyHoliday('${escJs(h.Date || '')}')" title="Export holiday data">📥</button>
      </td>
    </tr>
  `).join('');
}

function renderUpvalyHolidayPagination() {
  const totalPages = Math.ceil(upvalyHolidayState.filteredData.length / upvalyHolidayState.limit);
  const container = $('upvalyHolidayPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const cur = upvalyHolidayState.page;
  const visible = new Set([1, totalPages, cur-2, cur-1, cur, cur+1, cur+2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...visible].sort((a,b) => a-b);

  let html = `<button class="page-btn" onclick="goUpvalyHolidayPage(${cur-1})" ${cur===1?'disabled':''}>‹ Prev</button>`;
  let prev = null;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="page-btn" style="cursor:default;opacity:.4">…</span>`;
    html += `<button class="page-btn ${p===cur?'active':''}" onclick="goUpvalyHolidayPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="goUpvalyHolidayPage(${cur+1})" ${cur===totalPages?'disabled':''}>Next ›</button>`;
  container.innerHTML = html;
}

function goUpvalyHolidayPage(p) {
  upvalyHolidayState.page = p;
  renderUpvalyHolidayTable();
  renderUpvalyHolidayPagination();
  document.querySelector('.upvaly-dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function exportAllUpvalyHolidayData(btn) {
  btn = btn || document.querySelector('#upvalyPaneHolidays .btn-export-upvaly');
  if (!btn) return;
  btn.classList.add('loading');
  btn.textContent = '⏳ Preparing…';

  try {
    const response = await fetch('/api/upvaly/holidays/export-all');
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Upvaly_Holidays_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export data. Please try again.');
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      btn.textContent = '⬇ Export All (Excel)';
    }, 2000);
  }
}

function viewUpvalyHoliday(date) {
  const item = upvalyHolidayState.data.find(d => (d.Date || '') === date);
  if (!item) { alert('Holiday not found'); return; }

  const modalHtml = `
    <div class="vanguard-view-modal">
      <div class="vanguard-view-header">
        <h3>📅 ${escHtml(item.Description || 'Holiday Details')}</h3>
        <button onclick="closeUpvalyViewModal()" class="modal-close-btn">✕</button>
      </div>
      <div class="vanguard-view-body">
        <div class="view-grid">
          <div class="view-item"><span class="view-label">Date</span><span class="view-value highlight">${escHtml(item.Date || 'N/A')}</span></div>
          <div class="view-item"><span class="view-label">Type</span><span class="view-value">${escHtml(item.Type || 'N/A')}</span></div>
          <div class="view-item full-width"><span class="view-label">Description</span><span class="view-value">${escHtml(item.Description || 'N/A')}</span></div>
          <div class="view-item full-width"><span class="view-label">Closed Exchanges</span><span class="view-value">${escHtml(item['Closed Exchanges'] || '—')}</span></div>
          <div class="view-item full-width"><span class="view-label">Open Exchanges</span><span class="view-value">${escHtml(item['Open Exchanges'] || '—')}</span></div>
        </div>
      </div>
      <div class="vanguard-view-footer">
        <button onclick="closeUpvalyViewModal()" class="btn-modal-close">Close</button>
        <button onclick="exportUpvalyHoliday('${escJs(item.Date || '')}')" class="btn-export">📥 Export</button>
      </div>
    </div>
  `;

  const modalContainer = document.createElement('div');
  modalContainer.id = 'upvalyViewModal';
  modalContainer.className = 'modal-backdrop';
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);
  document.body.style.overflow = 'hidden';
}

async function exportUpvalyHoliday(date) {
  const btn = document.querySelector(`.btn-export[onclick*="exportUpvalyHoliday('${escJs(date)}')"]`);
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = '⏳';
  }

  try {
    const response = await fetch(`/api/upvaly/holidays/export/${encodeURIComponent(date)}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Export failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Upvaly_Holiday_${date}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export holiday data: ' + error.message);
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = originalText || '📥';
    }
  }
}

function setupUpvalyFilters() {
  $('upvalyIpoSearch').addEventListener('input', e => {
    upvalyIpoState.search = e.target.value;
    upvalyIpoState.page = 1;
    debounce(applyUpvalyIpoFilters);
  });
  $('upvalyIpoTypeFilter').addEventListener('change', e => {
    upvalyIpoState.selectedType = e.target.value;
    upvalyIpoState.page = 1;
    applyUpvalyIpoFilters();
  });
  $('upvalyIpoStatusFilter').addEventListener('change', e => {
    upvalyIpoState.selectedStatus = e.target.value;
    upvalyIpoState.page = 1;
    applyUpvalyIpoFilters();
  });
  $('upvalyIpoSort').addEventListener('change', e => {
    upvalyIpoState.sortBy = e.target.value;
    applyUpvalyIpoFilters();
  });

  $('upvalyHolidaySearch').addEventListener('input', e => {
    upvalyHolidayState.search = e.target.value;
    upvalyHolidayState.page = 1;
    debounce(applyUpvalyHolidayFilters);
  });
  $('upvalyHolidayTypeFilter').addEventListener('change', e => {
    upvalyHolidayState.selectedType = e.target.value;
    upvalyHolidayState.page = 1;
    applyUpvalyHolidayFilters();
  });
}

/* ─── HELPERS ───────────────────────────────────────── */
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escJs(str) {
  return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

/* ─── EDITABLE LAUNCH DATE ──────────────────────────── */
const MONTHS_3 = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

function launchDateToIso(str) {
  if (!str) return '';
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(str.trim());
  if (!m) return '';
  const mm = MONTHS_3[m[2][0].toUpperCase() + m[2].slice(1,3).toLowerCase()];
  if (!mm) return '';
  return `${m[3]}-${mm}-${m[1].padStart(2,'0')}`;
}

function launchDateCellHtml(code, launchDate) {
  const editBtn = isAdmin()
    ? `<button class="btn-edit-launch" onclick="editLaunchDate(this, '${escJs(code)}', '${escJs(launchDate||'')}')" title="Edit launch date">✎</button>`
    : '';
  return `
    <span class="launch-display">${launchDate ? escHtml(launchDate) : '<span class="isin-null">—</span>'}</span>
    ${editBtn}`;
}

function editLaunchDate(btn, code, currentValue) {
  const td = btn.closest('td');
  const iso = launchDateToIso(currentValue);
  td.innerHTML = `
    <input type="date" class="launch-date-input" value="${iso}" />
    <button class="btn-save-launch" onclick="saveLaunchDate(this, '${escJs(code)}')" title="Save">✓</button>
    <button class="btn-cancel-launch" onclick="cancelLaunchDateEdit(this, '${escJs(code)}', '${escJs(currentValue)}')" title="Cancel">✕</button>`;
  td.querySelector('input').focus();
}

function editModalLaunchDate(btn, code, currentValue) {
  const value = btn.closest('.modal-card').querySelector('.mc-value');
  const iso = launchDateToIso(currentValue);
  value.innerHTML = `
    <input type="date" class="launch-date-input" value="${iso}" />
    <button class="btn-save-launch" onclick="saveModalLaunchDate(this, '${escJs(code)}')" title="Save">✓</button>
    <button class="btn-cancel-launch" onclick="cancelModalLaunchDateEdit(this, '${escJs(code)}', '${escJs(currentValue)}')" title="Cancel">✕</button>`;
  btn.hidden = true;
  value.querySelector('input').focus();
}

function cancelModalLaunchDateEdit(btn, code, originalValue) {
  const card = btn.closest('.modal-card');
  card.querySelector('.mc-value').innerHTML = originalValue ? escHtml(originalValue) : '<span style="color:var(--text-dim)">—</span>';
  card.querySelector('.modal-launch-edit').hidden = false;
}

async function saveModalLaunchDate(btn, code) {
  const card = btn.closest('.modal-card');
  const value = card.querySelector('.mc-value');
  const newValue = value.querySelector('input').value;
  if (!newValue) { alert('Please pick a date first.'); return; }

  btn.disabled = true;
  const previousLabel = btn.textContent;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/scheme/${encodeURIComponent(code)}/launch-date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchDate: newValue })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save');

    value.textContent = data.launchDate;
    const editButton = card.querySelector('.modal-launch-edit');
    editButton.hidden = false;
    editButton.setAttribute('onclick', `editModalLaunchDate(this, '${escJs(code)}', '${escJs(data.launchDate)}')`);
    if (state.currentModalScheme && state.currentModalScheme.code === code) {
      state.currentModalScheme.launchDate = data.launchDate;
    }
    document.querySelectorAll(`td.td-launch[data-code="${CSS.escape(code)}"]`).forEach(td => {
      td.innerHTML = launchDateCellHtml(code, data.launchDate);
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = previousLabel;
    alert('Failed to save launch date: ' + err.message);
  }
}

function cancelLaunchDateEdit(btn, code, originalValue) {
  const td = btn.closest('td');
  td.innerHTML = launchDateCellHtml(code, originalValue);
}

async function saveLaunchDate(btn, code) {
  const td = btn.closest('td');
  const input = td.querySelector('input');
  const newValue = input.value;
  if (!newValue) { alert('Please pick a date first.'); return; }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = '…';

  try {
    const res = await fetch(`/api/scheme/${encodeURIComponent(code)}/launch-date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchDate: newValue })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save');
    td.innerHTML = launchDateCellHtml(code, data.launchDate);
    // keep every open copy of this row's launch date in sync (welcome + fund views)
    document.querySelectorAll(`td.td-launch[data-code="${CSS.escape(code)}"]`).forEach(otherTd => {
      if (otherTd !== td) otherTd.innerHTML = launchDateCellHtml(code, data.launchDate);
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevLabel;
    alert('Failed to save launch date: ' + err.message);
  }
}


/* ─── SYNC BAR: full Returns/Rolling-Returns pre-compute + cached "Old Sync" mode ─── */
const syncBarState = {
  pollTimer: null,
  oldSyncMode: false
};

function formatSyncTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// Wraps fetch() for the sync endpoints: throws a clear, specific error
// instead of silently returning a malformed object when the session has
// expired (e.g. after a server/nodemon restart) or another request fails.
async function fetchSyncJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Your session has expired (often happens after the server restarts). Please refresh the page and log in again.');
    }
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

async function initSyncBar() {
  try {
    const status = await fetchSyncJson('/api/sync/status');
    renderSyncStatus(status);
    if (status.running) startSyncPolling();
  } catch (err) {
    $('syncStatusText').textContent = err.message.startsWith('Your session')
      ? 'Session expired — refresh the page'
      : 'Sync status unavailable';
  }
}

function renderSyncStatus(status) {
  const btn = $('syncNowBtn');
  const label = $('syncNowLabel');
  const statusText = $('syncStatusText');

  if (!status || !status.cache) {
    statusText.textContent = 'Sync status unavailable';
    return;
  }

  if (status.running) {
    btn.classList.add('syncing');
    btn.disabled = true;
    label.textContent = `Syncing ${status.completed + status.failed}/${status.total} (${status.percent}%)`;
    statusText.textContent = `${status.cache.totalCached.toLocaleString()} schemes cached so far…`;
  } else {
    btn.classList.remove('syncing');
    btn.disabled = false;
    label.textContent = 'Sync';
    const lastSync = status.cache.lastFullSyncCompletedAt;
    if (lastSync) {
      statusText.textContent = `Last synced ${formatSyncTimestamp(lastSync)} · ${status.cache.totalCached.toLocaleString()}/${status.cache.totalSchemes.toLocaleString()} cached`;
    } else if (status.cache.totalCached > 0) {
      statusText.textContent = `${status.cache.totalCached.toLocaleString()}/${status.cache.totalSchemes.toLocaleString()} schemes cached`;
    } else {
      statusText.textContent = 'Not synced yet';
    }
  }
}

function startSyncPolling() {
  if (syncBarState.pollTimer) return;
  syncBarState.pollTimer = setInterval(async () => {
    try {
      const status = await fetchSyncJson('/api/sync/status');
      renderSyncStatus(status);
      if (!status.running) {
        clearInterval(syncBarState.pollTimer);
        syncBarState.pollTimer = null;
      }
    } catch (err) {
      clearInterval(syncBarState.pollTimer);
      syncBarState.pollTimer = null;
      $('syncStatusText').textContent = err.message.startsWith('Your session')
        ? 'Session expired — refresh the page'
        : 'Sync status unavailable';
    }
  }, 2000);
}

async function startFullSync() {
  const btn = $('syncNowBtn');
  if (btn.classList.contains('syncing')) return;

  const confirmMsg = 'This recalculates Returns + Rolling Returns for every scheme in the dashboard (thousands of schemes) and can take a while to complete in the background. Continue?';
  if (!confirm(confirmMsg)) return;

  try {
    const status = await fetchSyncJson('/api/sync/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });
    renderSyncStatus(status);
    startSyncPolling();
  } catch (err) {
    alert('Failed to start sync: ' + err.message);
  }
}

function toggleOldSyncMode() {
  syncBarState.oldSyncMode = !syncBarState.oldSyncMode;
  const btn = $('oldSyncBtn');
  const banner = $('oldSyncBanner');
  if (syncBarState.oldSyncMode) {
    btn.classList.add('active');
    banner.classList.remove('hidden');
  } else {
    btn.classList.remove('active');
    banner.classList.add('hidden');
  }
}

// Initialize the app
init();
