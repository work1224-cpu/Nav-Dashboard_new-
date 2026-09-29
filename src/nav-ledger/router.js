// ══════════════════════════════════════════════════════
// NAV Ledger — "Return CAGR Rule Engine" (mounted sub-app)
// ══════════════════════════════════════════════════════
// This is the NAV Ledger project's dashboard, adapted from a standalone
// Express app into an Express Router mounted inside the main NAV
// Dashboard project at /nav-ledger-api. It shares the SAME login,
// SAME session, and SAME admin panel as the rest of this site — there is
// only one login/register flow and one Admin Console for the whole
// project. This router only supplies the Rule Engine's own dataset
// (src/nav-ledger/data/) and calculations; it has no auth or user
// management of its own anymore.
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { build, isRegularGrowth, parseSchemePlan, parseSchemeOption } = require('./scripts/build-data');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { INDUSTRIES, classifyIndustry } = require('../lib/industryClassifier');
const staticFundDataStore = require('../services/staticFundDataStore');
const DATA_DIR = path.join(__dirname, 'data');
// A normal (non-admin) user's scheme filters are pinned to this exact
// combination — Open Ended / Regular / Growth — no matter what the client
// sends. This is enforced here on the server so it cannot be bypassed by
// editing the page or calling the API directly.
const LOCKED_FILTERS = { type: 'Open Ended', plan: 'Regular', option: 'Growth' };
// A record built before schemePlan/schemeOption existed on disk falls back
// to classifying its name on the fly, so filtering works immediately
// without forcing a data rebuild first.
function planOf(record) { return record.schemePlan || parseSchemePlan(record.schemeName); }
function optionOf(record) { return record.schemeOption || parseSchemeOption(record.schemeName); }

// A Router, not a full app — the parent server.js supplies the HTTP
// server, session middleware, JSON body parsing, and static file
// serving. Mounted at /nav-ledger-api by src/server.js (already wrapped
// in the main project's own requireAuth there, so every route below runs
// with req.session.user already guaranteed to exist).
const router = express.Router();

// The main dashboard stores the Excel-derived profile against a scheme name.
// Keep the calendar and SIP/Lumpsum dashboards on that same source of truth.
function staticDataForScheme(schemeName) {
  const data = staticFundDataStore.getBySchemeName(schemeName);
  if (!data) return null;
  return {
    ...data,
    riskMeasures: data.riskMeasures || {},
    marketCapitalisation: data.marketCapitalisation || {},
    amfiSectors: data.amfiSectors || [],
    exitLoad: data.exitLoad || ''
  };
}

// "12.4", "12.4%", " 12.4 " -> 12.4 ; "--", "", null -> null
function parseNumericValue(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[%,]/g, '').trim();
  if (cleaned === '' || cleaned === '--' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Risk Measures (Std.Dev / Beta / Sharpe / Jensen) use preset-range
// dropdown filters; Market Capitalisation (%) fields (Large/Mid/Small Cap,
// Cash) use fixed 0-25 / 25-50 / 50-75 / 75-100 percentage-band filters,
// per the dashboard's filter bar. A scheme with no static data, or a
// missing value for a field being actively filtered on, does not match.
function passesStaticFilters(schemeName, q) {
  const rangeKeys = ['stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket'];
  const bucketKeys = ['largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'];
  const hasAny = [...rangeKeys, ...bucketKeys].some(k => q[k] !== undefined && q[k] !== null && String(q[k]).trim() !== '');
  if (!hasAny) return true;

  const data = staticFundDataStore.findExactBySchemeName(schemeName);
  const risk = data?.riskMeasures || {};
  const market = data?.marketCapitalisation || {};

  // Preset-range codes: "" = All, "ltX" = below X, "gteX" = X and above,
  // "lo-hi" = lo (inclusive) up to hi (exclusive) — so bands never
  // double-count a value that sits exactly on a boundary.
  const inPresetRange = (value, bucketKey) => {
    const code = q[bucketKey];
    if (!code) return true;
    if (value === null) return false;
    if (code.startsWith('lt')) return value < Number(code.slice(2));
    if (code.startsWith('gte')) return value >= Number(code.slice(3));
    const [lo, hi] = code.split('-').map(Number);
    return value >= lo && value < hi;
  };

  const inBucket = (value, bucketKey) => {
    const bucket = q[bucketKey];
    if (!bucket) return true;
    if (value === null) return false;
    const [lo, hi] = String(bucket).split('-').map(Number);
    return value >= lo && value <= hi;
  };

  if (!inPresetRange(parseNumericValue(risk['Std.Dev']), 'stdDevBucket')) return false;
  if (!inPresetRange(parseNumericValue(risk['Beta (Slope)']), 'betaBucket')) return false;
  if (!inPresetRange(parseNumericValue(risk.Sharpe), 'sharpeBucket')) return false;
  if (!inPresetRange(parseNumericValue(risk.Jenson), 'jensenBucket')) return false;

  if (!inBucket(parseNumericValue(market['Large Cap']), 'largeCapBucket')) return false;
  if (!inBucket(parseNumericValue(market['Mid Cap']), 'midCapBucket')) return false;
  if (!inBucket(parseNumericValue(market['Small Cap']), 'smallCapBucket')) return false;
  if (!inBucket(parseNumericValue(market.Cash), 'cashBucket')) return false;

  return true;
}


// Reading and JSON.parse-ing master.json from disk on every single request
// was the actual bottleneck — for ~14,000 schemes with full daily NAV
// history that file is huge, so every filter change, page click, and sync
// request was paying that full disk-read + parse cost on top of any
// calculation. Cache each file's parsed contents in memory, keyed by its
// on-disk modified time, so a request only re-reads a file when it has
// actually changed (e.g. after running the data rebuild) — every other
// request reuses the already-parsed object straight from memory.
const jsonCache = new Map();

// master.json is 600MB+ — parsing it in one synchronous pass (the old
// readJsonArrayFile) blocked the ENTIRE event loop for ~40 seconds on every
// server start, meaning nothing (not even the login page or static assets)
// could be served during that window even though the port was already
// listening. This async version reads the same way but yields back to the
// event loop after every chunk, so other requests keep flowing while this
// runs in the background.
async function readJsonArrayFileAsync(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  const records = [];
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let pending = '';
  let record = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  try {
    let bytesRead;
    while ((({ bytesRead } = await fh.read(buffer, 0, buffer.length, null)), bytesRead) > 0) {
      pending += buffer.toString('utf8', 0, bytesRead);
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const char = pending[i];
        if (depth === 0) {
          if (char === '{') {
            depth = 1;
            record = '{';
            start = i + 1;
          }
          continue;
        }

        record += char;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') {
          inString = true;
        } else if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            records.push(JSON.parse(record));
            record = '';
            start = i + 1;
          }
        }
      }
      // If an object is still open, every character in this chunk has
      // already been appended to `record`; retain only unread data after a
      // completed object, otherwise the next chunk would duplicate bytes.
      pending = depth > 0 ? '' : pending.slice(start);
      // Hand control back to the event loop between chunks so pending HTTP
      // requests (login page, static assets, other routes) get serviced
      // while this multi-second parse is still going.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (record || depth !== 0) throw new Error(`Invalid JSON array: ${filePath}`);
  } finally {
    await fh.close();
  }
  return records;
}

// Small files (meta.json etc.) are cheap enough to read/parse synchronously.
function loadJSON(file) {
  const p = path.join(DATA_DIR, file);
  let stat;
  try { stat = fs.statSync(p); } catch (_) { return null; }
  const cached = jsonCache.get(p);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  jsonCache.set(p, { mtimeMs: stat.mtimeMs, data });
  return data;
}

// master.json gets its own loader: cached by mtime like loadJSON, but async
// so it never blocks the event loop, and with in-flight de-duplication so
// several requests that land while a parse is already running all await the
// SAME parse instead of each kicking off their own redundant 600MB read.
const MASTER_PATH = path.join(DATA_DIR, 'master.json');
let masterCache = null; // { mtimeMs, data }
let masterLoadingPromise = null;
async function loadMaster() {
  let stat;
  try { stat = await fs.promises.stat(MASTER_PATH); } catch (_) { return null; }
  if (masterCache && masterCache.mtimeMs === stat.mtimeMs) return masterCache.data;
  if (masterLoadingPromise) return masterLoadingPromise;
  masterLoadingPromise = readJsonArrayFileAsync(MASTER_PATH)
    .then((data) => {
      masterCache = { mtimeMs: stat.mtimeMs, data };
      return data;
    })
    .finally(() => { masterLoadingPromise = null; });
  return masterLoadingPromise;
}

// GET /api/meta -> years covered, AMC list, counts
router.get('/meta', requireAuth, async (req, res) => {
  const meta = loadJSON('meta.json');
  if (!meta) return res.status(404).json({ error: 'Data not built yet. Run: node scripts/build-data.js' });
  const master = (await loadMaster()) || [];
  // Reflects everything present in the dataset — an admin can filter across
  // every plan/option/type/category combination that exists, not just the
  // Regular Plan + Growth subset a locked-down user is restricted to.
  const typesByCategory = {};
  const categoriesByType = {};
  for (const record of master) {
    if (record.schemeCategory && record.schemeType) {
      (typesByCategory[record.schemeCategory] ||= new Set()).add(record.schemeType);
      (categoriesByType[record.schemeType] ||= new Set()).add(record.schemeCategory);
    }
  }
  res.json({
    ...meta,
    schemeTypes: [...new Set(master.map((r) => r.schemeType).filter(Boolean))].sort(),
    schemeCategories: [...new Set(master.map((r) => r.schemeCategory).filter(Boolean))].sort(),
    planOptions: [...new Set(master.map(planOf))].sort(),
    optionOptions: [...new Set(master.map(optionOf))].sort(),
    industries: INDUSTRIES,
    typesByCategory: Object.fromEntries(Object.entries(typesByCategory).map(([key, values]) => [key, [...values].sort()])),
    categoriesByType: Object.fromEntries(Object.entries(categoriesByType).map(([key, values]) => [key, [...values].sort()]))
  });
});

// The rule engine uses the complete daily NAV history.  A short cache keeps
// the dashboard responsive while ensuring return calculations use real NAVs.
const historyCache = new Map();
const HISTORY_TTL = 30 * 60 * 1000;
// SIP/Lumpsum return PERCENTAGES don't depend on the invested amount — only
// on Frequency (for SIP) — since scaling every cash flow by a constant
// doesn't change an XIRR or a NAV-ratio CAGR. So the expensive part (11
// periods x rolling-window averaging) only ever needs to be computed once
// per scheme/mode/frequency combination, no matter what amount, filters,
// or page any user requests afterwards. This is what brings a full-catalog
// computation down from several seconds to a lookup.
const returnsCache = new Map();
function returnsCacheKey(schemeCode, mode, frequency) { return `${schemeCode}:${mode}:${frequency}`; }

// ── Persisting the returns cache across restarts ──────────────────────
// Before this, warmUp() below recomputed SIP + Lumpsum returns for every
// scheme from scratch on EVERY server start/restart — at ~90-110ms/scheme
// for the rolling computation alone, that's 40-90+ minutes of pure CPU work
// repeated every single time the process restarted (including every
// nodemon reload in dev), even though the underlying NAV data hadn't
// changed. This was the actual reason the project felt like it "took too
// long to start". Persisting the computed cache to disk and only
// recomputing entries whose scheme has genuinely new NAV data turns every
// restart after the first into a near-instant load.
const RETURNS_CACHE_PATH = path.join(DATA_DIR, 'returns-cache.json');
function latestNavDateInRecord(record) {
  const history = record.navHistory;
  if (!Array.isArray(history) || !history.length) return null;
  const last = history[history.length - 1];
  return Array.isArray(last) ? last[0] : last.d;
}
function loadReturnsCacheFromDisk(master) {
  let raw;
  try { raw = fs.readFileSync(RETURNS_CACHE_PATH, 'utf-8'); } catch (_) { return; }
  let saved;
  try { saved = JSON.parse(raw); } catch (_) { return; }
  const currentLatestByCode = new Map(master.map((r) => [r.schemeCode, latestNavDateInRecord(r)]));
  let restored = 0;
  for (const [key, value] of Object.entries(saved)) {
    // Only trust a cached entry if the scheme it belongs to still has the
    // same latest NAV date — if new NAV data has come in since this was
    // saved (e.g. after the nightly AMFI refresh), it's stale and warmUp()
    // below will recompute just that entry instead of using it.
    const schemeCode = key.split(':')[0];
    if (currentLatestByCode.get(schemeCode) === value.latestNavDate) {
      returnsCache.set(key, value);
      restored++;
    }
  }
  console.log(`[nav-ledger] Restored ${restored} of ${Object.keys(saved).length} cached return entries from disk (rest were stale or removed).`);
}
let savePending = false;
async function persistReturnsCacheToDisk() {
  // Coalesce overlapping save calls — if a save is already in flight when
  // another checkpoint fires, skip it; the in-flight save already reflects
  // everything computed up to a moment ago.
  if (savePending) return;
  savePending = true;
  try {
    const obj = Object.fromEntries(returnsCache);
    const tmpPath = `${RETURNS_CACHE_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(obj));
    await fs.promises.rename(tmpPath, RETURNS_CACHE_PATH);
  } catch (err) {
    console.warn('[nav-ledger] Failed to persist returns cache:', err.message);
  } finally {
    savePending = false;
  }
}
const PERIODS = [
  ['1 Day', 1], ['7 Day', 7], ['1 Month', 30], ['3 Month', 91], ['6 Month', 182],
  ['1 Yr', 365], ['2 Yr', 730], ['3 Yr', 1095], ['5 Yr', 1826], ['10 Yr', 3652], ['12 Yr', 4383]
];

function parseNavDate(value) {
  const [day, month, year] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}
function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { return new Date(date.getTime() + days * 86400000); }
async function getHistory(record) {
  const schemeCode = record.schemeCode;
  if (Array.isArray(record.navHistory) && record.navHistory.length) {
    // Supports both the compact [date, nav] pair format and the older
    // {d, n} object format, so already-built data keeps working.
    return record.navHistory.map((row) => Array.isArray(row)
      ? { date: new Date(`${row[0]}T00:00:00Z`), nav: Number(row[1]) }
      : { date: new Date(`${row.d}T00:00:00Z`), nav: Number(row.n) })
      .filter((row) => Number.isFinite(row.nav) && row.nav > 0);
  }
  const cached = historyCache.get(schemeCode);
  if (cached && Date.now() - cached.savedAt < HISTORY_TTL) return cached.rows;
  const response = await axios.get(`https://api.mfapi.in/mf/${schemeCode}`, { timeout: 20000 });
  const rows = (response.data?.data || []).map((row) => ({ date: parseNavDate(row.date), nav: Number(row.nav) }))
    .filter((row) => Number.isFinite(row.nav) && row.nav > 0)
    .sort((a, b) => a.date - b.date);
  historyCache.set(schemeCode, { rows, savedAt: Date.now() });
  return rows;
}
function navOnOrBefore(rows, date) {
  let lo = 0, hi = rows.length - 1, answer = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) { answer = rows[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return answer;
}
function navOnOrAfter(rows, date) {
  let lo = 0, hi = rows.length - 1, answer = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date >= date) { answer = rows[mid]; hi = mid - 1; } else lo = mid + 1;
  }
  return answer;
}
function annualisedReturn(startNav, endNav, days) {
  if (!startNav || !endNav || days <= 0) return null;
  const gain = endNav / startNav;
  return days >= 365 ? (Math.pow(gain, 365.2425 / days) - 1) * 100 : (gain - 1) * 100;
}
function xirr(flows) {
  if (flows.length < 2 || !flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const first = flows[0].date;
  const f = (rate) => flows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, (flow.date - first) / 86400000 / 365.2425), 0);
  let low = -0.9999, high = 10, fLow = f(low), fHigh = f(high);
  for (let i = 0; i < 12 && fLow * fHigh > 0; i++) { high *= 2; fHigh = f(high); }
  if (fLow * fHigh > 0) return null;
  for (let i = 0; i < 80; i++) { const mid = (low + high) / 2, value = f(mid); if (value * fLow > 0) { low = mid; fLow = value; } else high = mid; }
  return ((low + high) / 2) * 100;
}
function sipReturn(rows, endRow, days, amount, frequency) {
  const start = addDays(endRow.date, -days);
  const gap = frequency === 'Weekly' ? 7 : frequency === 'Daily' ? 1 : 30;
  const flows = [];
  let units = 0;
  for (let date = start; date <= endRow.date; date = addDays(date, gap)) {
    // SIP debit placed on a holiday is allotted at the next published NAV.
    const navRow = navOnOrAfter(rows, date);
    // A contribution made on the valuation date has no holding period and
    // must not be included in XIRR (it makes the equation ill-conditioned).
    if (!navRow || navRow.date >= endRow.date) continue;
    units += amount / navRow.nav;
    flows.push({ date: navRow.date, amount: -amount });
  }
  if (!flows.length) return null;
  const value = units * endRow.nav;
  // XIRR is an annualised metric. For shorter windows, display the actual
  // holding-period return, matching the meaning of the 1D–6M columns.
  if (days < 365) return (value / (flows.length * amount) - 1) * 100;
  flows.push({ date: endRow.date, amount: value });
  return xirr(flows);
}
function rollingLumpReturn(rows, days) {
  const last = rows.at(-1);
  if (!last) return null;
  const from = addDays(last.date, -365);
  const values = [];
  // Weekly sample of every trailing window ending in the most recent year.
  for (let end = navOnOrAfter(rows, from); end && end.date <= last.date; end = navOnOrAfter(rows, addDays(end.date, 7))) {
    const start = navOnOrBefore(rows, addDays(end.date, -days));
    if (start) values.push(annualisedReturn(start.nav, end.nav, (end.date - start.date) / 86400000));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function rollingSipReturn(rows, days, amount, frequency) {
  const last = rows.at(-1);
  if (!last) return null;
  const from = addDays(last.date, -365);
  const values = [];
  for (let end = navOnOrAfter(rows, from); end && end.date <= last.date; end = navOnOrAfter(rows, addDays(end.date, 30))) {
    const value = sipReturn(rows, end, days, amount, frequency);
    if (value != null) values.push(value);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// Computes (or returns the already-cached) full 11-period sip/lump return
// percentages for one scheme + mode + frequency. Shared by the live
// /api/rule-engine route and the startup cache-warmer below, so both stay
// in exact sync and nothing has to be duplicated or kept in step by hand.
async function computeReturns(record, mode, frequency) {
  const cacheKey = returnsCacheKey(record.schemeCode, mode, frequency);
  let computed = returnsCache.get(cacheKey);
  if (computed) return computed;
  const rows = await getHistory(record); const end = rows.at(-1);
  if (!end) return null;
  const lump = {}, sip = {};
  for (const [label, days] of PERIODS) {
    const startRow = navOnOrBefore(rows, addDays(end.date, -days));
    lump[label] = startRow ? annualisedReturn(startRow.nav, end.nav, (end.date - startRow.date) / 86400000) : null;
    // The amount here is a placeholder (any fixed value works — the
    // resulting percentage is the same for every amount), purely so the
    // cached percentages can be reused across every user/request.
    sip[label] = mode === 'rolling' ? rollingSipReturn(rows, days, 1000, frequency) : sipReturn(rows, end, days, 1000, frequency);
    if (mode === 'rolling') lump[label] = rollingLumpReturn(rows, days);
  }
  computed = { latestNavDate: isoDate(end.date), sip, lump };
  returnsCache.set(cacheKey, computed);
  return computed;
}

router.get('/rule-engine', requireAuth, async (req, res) => {
  const master = await loadMaster();
  if (!master) return res.status(404).json({ error: 'Data not built yet.' });
  const isAdmin = !!(req.session && req.session.user && req.session.user.role === 'admin');
  let { search = '', amc = '', category = '', type = '', plan = '', option = '', industry = '', hasLaunch = 'false', mode = 'cagr', sipAmount = '5000', sipFrequency = 'Monthly', sipPeriod = 'All Periods', sipMinReturn = '', lumpAmount = '50000', lumpPeriod = 'All Periods', lumpMinReturn = '', page = '1', pageSize = '25' } = req.query;
  // Non-admin accounts are pinned to Open Ended / Regular Plan / Growth on
  // the server, regardless of what the client sends — this cannot be
  // bypassed from the browser console or a direct API call.
  if (!isAdmin) { type = LOCKED_FILTERS.type; plan = LOCKED_FILTERS.plan; option = LOCKED_FILTERS.option; }
  const text = search.toLowerCase();
  // Non-admins only ever see Regular+Growth records; admins can filter
  // across every plan/option combination present in the dataset.
  let candidates = master.filter((r) => (isAdmin || isRegularGrowth(r.schemeName)) && (!text || r.schemeName.toLowerCase().includes(text)) && (!amc || r.amc === amc) && (!category || r.schemeCategory === category) && (!type || r.schemeType === type) && (!industry || classifyIndustry(r.schemeName, r.schemeCategory) === industry) && passesStaticFilters(r.schemeName, req.query));
  if (hasLaunch === 'true') candidates = candidates.filter((r) => !r.dateOfLaunch);
  if (plan) candidates = candidates.filter((r) => planOf(r) === plan);
  if (option) candidates = candidates.filter((r) => optionOf(r) === option);
  // Cap history downloads, then rank selected page by latest stored CAGR.
  candidates.sort((a, b) => (b.cagr ?? -Infinity) - (a.cagr ?? -Infinity));
  // Page size is user-selectable (25/50/150/200/400) via the "Show X per
  // page" control; 400 is a sane upper bound so one request can't be asked
  // to compute returns for the entire multi-thousand-scheme dataset at once.
  const pageSizeNum = Math.min(400, Math.max(1, Number(pageSize) || 25));
  const start = (Math.max(1, Number(page)) - 1) * pageSizeNum;
  const requested = candidates.slice(start, start + pageSizeNum);
  const records = await Promise.all(requested.map(async (r) => {
    try {
      const computed = await computeReturns(r, mode, sipFrequency);
      if (!computed) return null;
      return { schemeCode: r.schemeCode, schemeName: r.schemeName, amc: r.amc, category: r.schemeCategory, industry: classifyIndustry(r.schemeName, r.schemeCategory), latestNavDate: computed.latestNavDate, sip: computed.sip, lump: computed.lump, staticData: staticDataForScheme(r.schemeName) };
    } catch (_) { return null; }
  }));
  // A blank minimum means no return rule. "All Periods" means a scheme may
  // qualify through any available period; a chosen period applies exactly to
  // that column. Both SIP and Lumpsum rules must pass when supplied.
  const meetsRule = (returns, period, minimum) => {
    if (minimum === '' || minimum == null || !Number.isFinite(Number(minimum))) return true;
    const values = period === 'All Periods' ? Object.values(returns) : [returns[period]];
    return values.some((value) => value != null && value >= Number(minimum));
  };
  const items = records.filter(Boolean).filter((r) => meetsRule(r.sip, sipPeriod, sipMinReturn) && meetsRule(r.lump, lumpPeriod, lumpMinReturn));
  res.json({ items, total: candidates.length, periods: PERIODS.map(([label]) => label), asOf: items[0]?.latestNavDate || null, sipAmount: Number(sipAmount), lumpAmount: Number(lumpAmount) });
});

// GET /api/schemes?search=&amc=&sort=cagr|nav|name&dir=asc|desc&page=1&pageSize=50
router.get('/schemes', requireAuth, async (req, res) => {
  const master = await loadMaster();
  if (!master) return res.status(404).json({ error: 'Data not built yet. Run: node scripts/build-data.js' });

  let list = master;

  const isAdmin = !!(req.session && req.session.user && req.session.user.role === 'admin');
  // Non-admins are pinned to Open Ended / Regular Plan / Growth (see
  // LOCKED_FILTERS below); admins can browse every plan/option combination
  // that exists in the dataset — no hard-coded Regular+Growth filter here.
  if (!isAdmin) list = list.filter((r) => isRegularGrowth(r.schemeName));

  let {
    search, amc, minCagr, maxCagr, schemeType, schemeCategory,
    minGrowth, maxGrowth, launchYearFrom, launchYearTo,
    hasFundManager, hasLaunchDate, fullHistory, hasRollingReturn
  } = req.query;
  if (!isAdmin) schemeType = LOCKED_FILTERS.type;
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((r) =>
      r.schemeName.toLowerCase().includes(s) ||
      (r.amc || '').toLowerCase().includes(s) ||
      (r.schemeCode || '').toLowerCase().includes(s) ||
      (r.nsdlCode || '').toLowerCase().includes(s)
    );
  }
  if (amc) {
    list = list.filter((r) => r.amc === amc);
  }
  if (schemeType) {
    list = list.filter((r) => r.schemeType === schemeType);
  }
  if (schemeCategory) {
    list = list.filter((r) => r.schemeCategory === schemeCategory);
  }
  if (minCagr) {
    const m = Number(minCagr);
    list = list.filter((r) => r.cagr != null && r.cagr >= m);
  }
  if (maxCagr) {
    const m = Number(maxCagr);
    list = list.filter((r) => r.cagr != null && r.cagr <= m);
  }
  if (minGrowth) {
    const m = Number(minGrowth);
    list = list.filter((r) => r.absoluteGrowthPct != null && r.absoluteGrowthPct >= m);
  }
  if (maxGrowth) {
    const m = Number(maxGrowth);
    list = list.filter((r) => r.absoluteGrowthPct != null && r.absoluteGrowthPct <= m);
  }
  if (launchYearFrom || launchYearTo) {
    const from = launchYearFrom ? Number(launchYearFrom) : -Infinity;
    const to = launchYearTo ? Number(launchYearTo) : Infinity;
    list = list.filter((r) => {
      const m = r.dateOfLaunch && String(r.dateOfLaunch).match(/(\d{4})/);
      if (!m) return false;
      const y = Number(m[1]);
      return y >= from && y <= to;
    });
  }
  if (hasLaunchDate === 'true') {
    list = list.filter((r) => !!r.dateOfLaunch);
  }
  if (hasFundManager === 'true') {
    list = list.filter((r) => !!r.fundManagerDetails);
  }
  if (hasRollingReturn === 'true') {
    list = list.filter((r) => r.rollingReturnsByYear && Object.keys(r.rollingReturnsByYear).length > 0);
  }
  if (fullHistory === 'true') {
    const metaYears = (loadJSON('meta.json') || {}).years || [];
    if (metaYears.length) {
      const yMin = Math.min(...metaYears), yMax = Math.max(...metaYears);
      list = list.filter((r) => r.firstYear === yMin && r.lastYear === yMax);
    }
  }

  const sort = req.query.sort || 'cagr';
  const dir = req.query.dir === 'asc' ? 1 : -1;
  list = [...list].sort((a, b) => {
    let av = a[sort];
    let bv = b[sort];
    if (sort === 'name') { av = a.schemeName; bv = b.schemeName; }
    if (sort === 'dateOfLaunch') {
      av = av ? Date.parse(av) : null;
      bv = bv ? Date.parse(bv) : null;
    }
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Number(req.query.pageSize) || 50);
  const start = (page - 1) * pageSize;
  const pageItems = list.slice(start, start + pageSize);

  res.json({
    total: list.length,
    page,
    pageSize,
    items: pageItems
  });
});

// GET /api/scheme/:key -> full detail for one scheme (key = amc|||schemeName, url-encoded)
router.get('/scheme/:key', requireAuth, async (req, res) => {
  const master = await loadMaster();
  if (!master) return res.status(404).json({ error: 'Data not built yet.' });
  const key = decodeURIComponent(req.params.key).toLowerCase();
  const found = master.find((r) => `${r.amc || ''}|||${r.schemeName}`.toLowerCase() === key);
  if (!found) return res.status(404).json({ error: 'Scheme not found' });
  res.json(found);
});

// POST /api/refresh-latest -> rebuild histories from MFAPI
router.post('/refresh-latest', requireAuth, requireAdmin, async (req, res) => {
  try {
    await build();
    const refreshed = loadJSON('meta.json');
    res.json({ ok: true, matched: refreshed.totalSchemes, total: refreshed.totalSchemes });
    // Re-warm in the background: schemes whose NAV didn't change reuse their
    // cached returns instantly (see loadReturnsCacheFromDisk), so this only
    // does real work for the schemes the refresh actually updated.
    warmUp().catch((err) => console.error('[nav-ledger] Post-refresh warm-up failed:', err.message));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// Calendar Year calculations (CAGR, Rolling Return, SIP, Lumpsum) — all
// computed from the same full daily NAV history already stored per scheme
// in master.json (originally sourced from https://api.mfapi.in/mf/<code>).
//
// IMPORTANT — "Calendar Year" in this app means the NAV as of 31 March of
// that year (India's financial-year end), the exact same convention the
// existing Calendar Year tile already uses (see valueOnMarch31 in
// scripts/build-data.js) — NOT 31 December. A year label like "2025" means
// the NAV as on 31-Mar-2025. Rolling Return for a year is the year-over-year
// change from the PREVIOUS year's 31-March NAV; CAGR for a year is the
// annualised growth from the scheme's very FIRST tracked year's 31-March
// NAV all the way through to that year (cumulative, growing each year) —
// exactly like the existing cagrByYear/rollingReturnsByYear fields, just
// recomputed live from the full daily history instead of a fixed snapshot.
// ══════════════════════════════════════════════════════
function valueOnMarch31(rows, year) {
  const targetIso = `${year}-03-31`;
  let exact = null;
  let latestInMarch = null;
  for (const row of rows) {
    const iso = isoDate(row.date);
    if (iso === targetIso) { exact = row; break; }
    if (iso.slice(0, 4) === String(year) && iso.slice(5, 7) === '03') {
      if (!latestInMarch || row.date > latestInMarch.date) latestInMarch = row;
    }
  }
  return exact || latestInMarch || null; // returns the ROW ({date, nav}), not just the number — callers need the date for discontinuity checks below
}

// Detects a NAV data discontinuity — a scheme's face-value change, merger,
// or similar restructuring event baked into MFAPI's raw history, where the
// NAV jumps by a huge multiple between two consecutive data points with no
// real market move behind it. A mutual fund's NAV essentially never moves
// more than 4x (or drops below 1/4x) between one available NAV and the
// next; when it does, treating that ratio as a genuine "return" produces
// nonsense — we saw a real scheme report a 10,000%+ CAGR from exactly this
// (its NAV jumped ~100x between two 2018 data points, clearly a face-value
// change, not a market move). Any CAGR/Rolling/SIP/Lumpsum window whose
// start and end straddle such a jump is now reported as unavailable
// (null) instead of a misleading number.
function findDiscontinuities(rows) {
  const points = [];
  for (let i = 1; i < rows.length; i++) {
    const prevNav = rows[i - 1].nav;
    const nav = rows[i].nav;
    if (prevNav > 0 && (nav / prevNav > 4 || nav / prevNav < 0.25)) points.push(rows[i].date);
  }
  return points;
}
function hasDiscontinuityInRange(discontinuities, fromDate, toDate) {
  return discontinuities.some((d) => d > fromDate && d <= toDate);
}

// Computes CAGR and Rolling Return for EVERY year in `years` at once (they
// share the same "first tracked year" base, so it's cheaper and more
// correct to do them together than one year at a time).
function calendarYearSeries(rows, years) {
  const discontinuities = findDiscontinuities(rows);
  const rowByYear = {};
  for (const year of years) {
    const row = valueOnMarch31(rows, year);
    if (row) rowByYear[year] = row;
  }
  const yearsWithData = years.filter((y) => rowByYear[y] != null);
  const cagr = {};
  const rolling = {};

  // Rolling: plain year-over-year vs the immediately preceding calendar
  // year — nulled only for the one specific year whose window actually
  // straddles a discontinuity, not every year after it.
  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    const prevYear = years[i - 1];
    const r0 = prevYear != null ? rowByYear[prevYear] : null;
    const r1 = rowByYear[year];
    if (r0 != null && r1 != null && r0.nav > 0 && !hasDiscontinuityInRange(discontinuities, r0.date, r1.date)) {
      rolling[year] = ((r1.nav - r0.nav) / r0.nav) * 100;
    }
  }

  // CAGR: cumulative growth from a BASE year — but if a discontinuity
  // (face-value change, merger) happened somewhere between the original
  // base and a later year, that stretch can't be compared directly, the
  // raw NAV ratio across it is meaningless. Rather than nulling every year
  // forever after just one such event (which is what a fixed "first
  // tracked year" base would do), the base RESTARTS at the first year
  // after the discontinuity, so "since inception" CAGR resumes being
  // meaningful for the post-rebase era instead of staying null forever.
  let baseYear = null;
  for (const year of yearsWithData) {
    if (baseYear == null) { baseYear = year; continue; }
    const baseRow = rowByYear[baseYear];
    const row = rowByYear[year];
    if (hasDiscontinuityInRange(discontinuities, baseRow.date, row.date)) {
      baseYear = year; // restart the base here; this year has no valid prior base of its own
      continue;
    }
    if (baseRow.nav > 0) cagr[year] = (Math.pow(row.nav / baseRow.nav, 1 / (year - baseYear)) - 1) * 100;
  }
  return { cagr, rolling };
}

// Jan-Dec calendar year bounds — used by Lumpsum/SIP below (per your
// confirmation: "Jan-Dec ke liye SIP/Lumpsum return"). CAGR/Rolling above
// use the 31-March convention instead, matching the existing Calendar Year
// tile. investMonth/investDay let the person move the "start of year" away
// from 1 January — e.g. investMonth=4, investDay=1 measures 1-Apr to
// 31-Mar (financial year) instead. Defaults (1, 1) keep the plain Jan-Dec
// behaviour.
function yearBounds(year, investMonth = 1, investDay = 1) {
  return { start: new Date(Date.UTC(year, investMonth - 1, investDay)), end: new Date(Date.UTC(year + 1, investMonth - 1, investDay)) };
}

// A one-time investment on the chosen date, valued exactly one year later —
// reported as the actual (non-annualised) gain for that year, which is
// what "which year performed best" comparisons expect. `discontinuities`
// is optional — pass a precomputed list (see findDiscontinuities above)
// when calling this repeatedly for the same scheme to avoid rescanning its
// whole history every time; computed fresh here if omitted.
function calendarYearLumpsum(rows, year, investMonth = 1, investDay = 1, discontinuities = null) {
  const { start, end } = yearBounds(year, investMonth, investDay);
  const startRow = navOnOrAfter(rows, start);
  const endRow = navOnOrBefore(rows, end);
  if (!startRow || !endRow || startRow.date >= endRow.date) return null;
  const disc = discontinuities || findDiscontinuities(rows);
  if (hasDiscontinuityInRange(disc, startRow.date, endRow.date)) return null;
  return (endRow.nav / startRow.nav - 1) * 100;
}

// An installment every Frequency-period starting from the chosen date (or
// up to the scheme's last available NAV if the year is still in progress),
// valued one year later — reported as the actual (non-annualised) gain on
// total invested for that year.
function calendarYearSip(rows, year, frequency, investMonth = 1, investDay = 1, sipDay = 1, discontinuities = null) {
  const { start: yearStart, end } = yearBounds(year, investMonth, investDay);
  // sipDay shifts WHICH day of the month each monthly installment lands on
  // (only meaningful for Monthly; Weekly/Daily always start from yearStart).
  const start = frequency === 'Monthly' ? new Date(Date.UTC(yearStart.getUTCFullYear(), yearStart.getUTCMonth(), sipDay)) : yearStart;
  const last = rows.at(-1);
  if (!last) return null;
  const effectiveEnd = end < last.date ? end : last.date;
  const endRow = navOnOrBefore(rows, effectiveEnd);
  if (!endRow) return null;
  const disc = discontinuities || findDiscontinuities(rows);
  if (hasDiscontinuityInRange(disc, start, endRow.date)) return null; // a SIP whose installments straddle a face-value change can't be represented sanely — be honest and report unavailable
  const gap = frequency === 'Weekly' ? 7 : frequency === 'Daily' ? 1 : 30;
  const amount = 1000; // placeholder — the resulting PERCENTAGE doesn't depend on the amount
  const flows = [];
  let units = 0;
  for (let date = start; date <= endRow.date; date = addDays(date, gap)) {
    const navRow = navOnOrAfter(rows, date);
    if (!navRow || navRow.date >= endRow.date) continue;
    units += amount / navRow.nav;
    flows.push(navRow);
  }
  if (!flows.length) return null;
  const value = units * endRow.nav;
  return (value / (flows.length * amount) - 1) * 100;
}

// ── Calendar Year cache (disk-persisted) ──────────────────────────────
// Computed lazily, per page actually viewed (same pattern as returnsCache
// above) rather than eagerly warmed for all ~38,000 schemes × ~10 years —
// a completed calendar year's numbers never change once that year has
// closed, so those entries are cached to disk FOREVER once computed; only
// the current (still in-progress) year is re-checked against the scheme's
// latest NAV date, exactly like the trailing returns cache above.
const CALENDAR_CACHE_PATH = path.join(DATA_DIR, 'calendar-cache.json');
const calendarCache = new Map();
function calendarCacheKey(schemeCode, calcType, year, frequency) {
  return frequency ? `${schemeCode}:${calcType}:${year}:${frequency}` : `${schemeCode}:${calcType}:${year}`;
}
function loadCalendarCacheFromDisk(master) {
  let raw;
  try { raw = fs.readFileSync(CALENDAR_CACHE_PATH, 'utf-8'); } catch (_) { return; }
  let saved;
  try { saved = JSON.parse(raw); } catch (_) { return; }
  const currentLatestByCode = new Map(master.map((r) => [r.schemeCode, latestNavDateInRecord(r)]));
  let restored = 0;
  for (const [key, entry] of Object.entries(saved)) {
    const schemeCode = key.split(':')[0];
    if (entry.final || currentLatestByCode.get(schemeCode) === entry.latestNavDate) {
      calendarCache.set(key, entry);
      restored++;
    }
  }
  console.log(`[nav-ledger] Restored ${restored} of ${Object.keys(saved).length} cached calendar-year entries from disk.`);
}
let calendarSavePending = false;
let calendarSaveTimer = null;
async function persistCalendarCacheToDisk() {
  if (calendarSavePending) return;
  calendarSavePending = true;
  try {
    const obj = Object.fromEntries(calendarCache);
    const tmpPath = `${CALENDAR_CACHE_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(obj));
    await fs.promises.rename(tmpPath, CALENDAR_CACHE_PATH);
  } catch (err) {
    console.warn('[nav-ledger] Failed to persist calendar cache:', err.message);
  } finally {
    calendarSavePending = false;
  }
}
// Debounced: several page views in quick succession shouldn't each trigger
// a full disk write — wait for a short quiet period after the last new
// computation before actually saving.
function scheduleCalendarCacheSave() {
  if (calendarSaveTimer) clearTimeout(calendarSaveTimer);
  calendarSaveTimer = setTimeout(() => { calendarSaveTimer = null; persistCalendarCacheToDisk(); }, 4000);
}
// A year is "final" (permanently cacheable) once the scheme has NAV data
// reaching at least the window's end date — later data can never change a
// closed year's numbers, only the current/in-progress year's.
function isYearFinal(rows, year, investMonth = 1, investDay = 1) {
  const last = rows.at(-1);
  return !!last && last.date >= yearBounds(year, investMonth, investDay).end;
}

// One cache entry per scheme covers ALL years at once (CAGR is cumulative
// from the first tracked year, so every year's value depends on the same
// base — computing them together is both correct and cheap: a single pass
// over the daily history rather than re-scanning it per year).
async function computeCalendarReturns(record, years) {
  const key = calendarCacheKey(record.schemeCode, 'calYearSeries', 'all');
  const currentLatestNavDate = latestNavDateInRecord(record);
  const cached = calendarCache.get(key);
  if (cached && cached.latestNavDate === currentLatestNavDate) return cached;
  const rows = await getHistory(record);
  const { cagr, rolling } = calendarYearSeries(rows, years);
  const entry = { cagr, rolling, latestNavDate: currentLatestNavDate };
  calendarCache.set(key, entry);
  scheduleCalendarCacheSave();
  return entry;
}

// investMonth/investDay (Lumpsum + SIP's year-window start) and sipDay
// (which day of the month each SIP installment lands on) are baked into
// the cache key — changing any of them is a genuinely different
// calculation, not a cache hit for the old one.
async function computeCalendarSipLumpsum(record, year, frequency, investMonth, investDay, sipDay) {
  const dateTag = `${investMonth}-${investDay}`;
  const lumpKey = calendarCacheKey(record.schemeCode, 'calLump', year, dateTag);
  const sipKey = calendarCacheKey(record.schemeCode, 'calSip', year, `${frequency}:${dateTag}:${sipDay}`);
  let lumpEntry = calendarCache.get(lumpKey);
  let sipEntry = calendarCache.get(sipKey);
  if (lumpEntry && sipEntry) return { lumpsum: lumpEntry.value, sip: sipEntry.value };
  const rows = await getHistory(record);
  const discontinuities = findDiscontinuities(rows);
  const final = isYearFinal(rows, year, investMonth, investDay);
  const latestNavDate = rows.length ? isoDate(rows.at(-1).date) : null;
  if (!lumpEntry) { lumpEntry = { value: calendarYearLumpsum(rows, year, investMonth, investDay, discontinuities), final, latestNavDate }; calendarCache.set(lumpKey, lumpEntry); }
  if (!sipEntry) { sipEntry = { value: calendarYearSip(rows, year, frequency, investMonth, investDay, sipDay, discontinuities), final, latestNavDate }; calendarCache.set(sipKey, sipEntry); }
  scheduleCalendarCacheSave();
  return { lumpsum: lumpEntry.value, sip: sipEntry.value };
}

// Shared filter set for both Calendar Year routes below — same shape as
// the Rule Engine's own filters (search / AMC / category / type / plan /
// option / industry), with the same server-side lock for non-admins.
// The full scheme master list includes decades of closed/matured/merged
// schemes going back to the 1990s — their NAV history genuinely stops
// years ago, that's correct data, not a bug. But surfacing them by default
// (sorted only by a static `cagr` field) meant most of what people saw on
// page 1 were long-dead schemes whose "recent" calendar years are just
// empty, which looked broken. "Active" here means the scheme's own last
// NAV date falls within ACTIVE_WINDOW_DAYS of the dataset's overall most
// recent NAV date — computed once and cached, since scanning 38,000
// schemes' navHistory on every request would be wasteful.
const ACTIVE_WINDOW_DAYS = 60;
let activeSchemeCodesCache = null; // { asOfMtimeMs, set }
// A column is only useful when at least one scheme has a March NAV for that
// calendar year. Some raw histories begin mid-year (e.g. Sep-2013), which
// previously created a completely empty "2013" column. Build the list from
// actual usable March observations, not merely a record's first/last date.
let calendarYearsCache = null; // { asOfMtimeMs, years }
function allCalendarYears(master) {
  let stat;
  try { stat = fs.statSync(MASTER_PATH); } catch (_) { stat = null; }
  const mtimeMs = stat ? stat.mtimeMs : null;
  if (calendarYearsCache && calendarYearsCache.asOfMtimeMs === mtimeMs) return calendarYearsCache.years;
  let minYear = null;
  let maxYear = null;
  for (const r of master) {
    if (!Array.isArray(r.navHistory) || !r.navHistory.length) continue;
    const first = r.navHistory[0];
    const last = r.navHistory[r.navHistory.length - 1];
    const firstIso = Array.isArray(first) ? first[0] : first.d;
    const lastIso = Array.isArray(last) ? last[0] : last.d;
    const fy = firstIso ? parseInt(firstIso.slice(0, 4), 10) : null;
    const ly = lastIso ? parseInt(lastIso.slice(0, 4), 10) : null;
    if (fy && (minYear == null || fy < minYear)) minYear = fy;
    if (ly && (maxYear == null || ly > maxYear)) maxYear = ly;
  }
  const candidateYears = [];
  if (minYear != null && maxYear != null) for (let y = minYear; y <= maxYear; y++) candidateYears.push(y);
  const usableYears = new Set();
  const wanted = new Set(candidateYears.map(String));
  for (const record of master) {
    if (usableYears.size === candidateYears.length) break;
    for (const row of record.navHistory || []) {
      const date = Array.isArray(row) ? row[0] : row?.d;
      if (!date || String(date).slice(5, 7) !== '03') continue;
      const year = String(date).slice(0, 4);
      if (wanted.has(year)) usableYears.add(Number(year));
    }
  }
  const years = candidateYears.filter((year) => usableYears.has(year));
  calendarYearsCache = { asOfMtimeMs: mtimeMs, years };
  return years;
}

function activeSchemeCodes(master) {
  let stat;
  try { stat = fs.statSync(MASTER_PATH); } catch (_) { stat = null; }
  const mtimeMs = stat ? stat.mtimeMs : null;
  if (activeSchemeCodesCache && activeSchemeCodesCache.asOfMtimeMs === mtimeMs) return activeSchemeCodesCache.set;
  let maxDate = null;
  for (const r of master) {
    const d = latestNavDateInRecord(r);
    if (d && (!maxDate || d > maxDate)) maxDate = d;
  }
  const cutoff = maxDate ? isoDate(addDays(new Date(`${maxDate}T00:00:00Z`), -ACTIVE_WINDOW_DAYS)) : null;
  const set = new Set();
  if (cutoff) for (const r of master) { const d = latestNavDateInRecord(r); if (d && d >= cutoff) set.add(r.schemeCode); }
  activeSchemeCodesCache = { asOfMtimeMs: mtimeMs, set };
  return set;
}

function filterMasterForCalendar(master, req, isAdmin) {
  let { search = '', amc = '', category = '', type = '', plan = '', option = '', industry = '', hasLaunch = 'false', includeClosed = 'false' } = req.query;
  if (!isAdmin) { type = LOCKED_FILTERS.type; plan = LOCKED_FILTERS.plan; option = LOCKED_FILTERS.option; }
  const text = search.toLowerCase();
  const active = includeClosed === 'true' ? null : activeSchemeCodes(master);
  let candidates = master.filter((r) => (isAdmin || isRegularGrowth(r.schemeName)) && (!active || active.has(r.schemeCode)) && (!text || r.schemeName.toLowerCase().includes(text)) && (!amc || r.amc === amc) && (!category || r.schemeCategory === category) && (!type || r.schemeType === type) && (!industry || classifyIndustry(r.schemeName, r.schemeCategory) === industry) && passesStaticFilters(r.schemeName, req.query));
  if (hasLaunch === 'true') candidates = candidates.filter((r) => !r.dateOfLaunch);
  if (plan) candidates = candidates.filter((r) => planOf(r) === plan);
  if (option) candidates = candidates.filter((r) => optionOf(r) === option);
  // Default sort favours ESTABLISHED schemes (longer history) over brand-new
  // ones — sorting purely by cagr surfaced newly-launched, high-volatility
  // funds (e.g. Silver ETFs launched in 2024-25) at the very top, and since
  // they're new, most of their year columns are correctly empty — which
  // looked like "missing data" even though nothing was actually wrong.
  // firstYear (ascending, oldest first) surfaces schemes with a full
  // 2017-2026 track record first; cagr breaks ties among equally old ones.
  candidates.sort((a, b) => {
    const yearDiff = (a.firstYear ?? Infinity) - (b.firstYear ?? Infinity);
    if (yearDiff !== 0) return yearDiff;
    return (b.cagr ?? -Infinity) - (a.cagr ?? -Infinity);
  });
  return candidates;
}

// GET /calendar-returns?mode=cagr|rolling&...filters...&page&pageSize
// Calendar Year CAGR & Rolling Return — one row per scheme, one column per
// calendar year (Jan-Dec).
router.get('/calendar-returns', requireAuth, async (req, res) => {
  const master = await loadMaster();
  if (!master) return res.status(404).json({ error: 'Data not built yet.' });
  const years = allCalendarYears(master);
  const isAdmin = !!(req.session && req.session.user && req.session.user.role === 'admin');
  const candidates = filterMasterForCalendar(master, req, isAdmin);
  const mode = req.query.mode === 'rolling' ? 'rolling' : 'cagr';
  const pageSizeNum = Math.min(400, Math.max(1, Number(req.query.pageSize) || 25));
  const page = Math.max(1, Number(req.query.page) || 1);
  const start = (page - 1) * pageSizeNum;
  const requested = candidates.slice(start, start + pageSizeNum);
  const items = await Promise.all(requested.map(async (r) => {
    const byYear = {};
    try {
      const series = await computeCalendarReturns(r, years);
      for (const year of years) byYear[year] = series[mode][year] ?? null;
    } catch (_) {
      for (const year of years) byYear[year] = null;
    }
    return { schemeCode: r.schemeCode, schemeName: r.schemeName, amc: r.amc, category: r.schemeCategory, years: byYear, staticData: staticDataForScheme(r.schemeName) };
  }));
  res.json({ items, years, total: candidates.length, page, pageSize: pageSizeNum, mode });
});

// GET /calendar-sip-lumpsum?sipFrequency=Monthly&...filters...&page&pageSize
// Calendar Year SIP & Lumpsum — one row per scheme, one column per calendar
// year, each cell holding that year's SIP return and Lumpsum return.
router.get('/calendar-sip-lumpsum', requireAuth, async (req, res) => {
  const master = await loadMaster();
  if (!master) return res.status(404).json({ error: 'Data not built yet.' });
  const years = allCalendarYears(master);
  const isAdmin = !!(req.session && req.session.user && req.session.user.role === 'admin');
  const candidates = filterMasterForCalendar(master, req, isAdmin);
  const frequency = ['Weekly', 'Daily'].includes(req.query.sipFrequency) ? req.query.sipFrequency : 'Monthly';
  // Investment date customisation — defaults (1 Jan) reproduce the original
  // plain Jan-Dec behaviour exactly; e.g. investMonth=4 measures Apr-to-Apr
  // (financial year) instead. sipDay only matters for Monthly SIP.
  const investMonth = Math.min(12, Math.max(1, Number(req.query.investMonth) || 1));
  const investDay = Math.min(28, Math.max(1, Number(req.query.investDay) || 1));
  const sipDay = Math.min(28, Math.max(1, Number(req.query.sipDay) || investDay));
  const pageSizeNum = Math.min(400, Math.max(1, Number(req.query.pageSize) || 25));
  const page = Math.max(1, Number(req.query.page) || 1);
  const start = (page - 1) * pageSizeNum;
  const requested = candidates.slice(start, start + pageSizeNum);
  const items = await Promise.all(requested.map(async (r) => {
    const byYear = {};
    for (const year of years) {
      try { byYear[year] = await computeCalendarSipLumpsum(r, year, frequency, investMonth, investDay, sipDay); }
      catch (_) { byYear[year] = { sip: null, lumpsum: null }; }
    }
    return { schemeCode: r.schemeCode, schemeName: r.schemeName, amc: r.amc, category: r.schemeCategory, years: byYear, staticData: staticDataForScheme(r.schemeName) };
  }));
  res.json({ items, years, total: candidates.length, page, pageSize: pageSizeNum, frequency, investMonth, investDay, sipDay });
});

// Pre-loads master.json into memory and pre-computes the most commonly
// viewed combination (Return CAGR + Rolling Returns, Monthly SIP) for
// every scheme right after boot, in the background, without blocking the
// server from accepting requests.
//
// IMPORTANT: Node runs JavaScript on a single thread. The actual return
// calculations are synchronous CPU work with no real I/O in them (once
// navHistory is already in memory), so awaiting several of them
// "concurrently" does NOT interleave with incoming HTTP requests — it just
// blocks the whole server until each chunk finishes, which is why the
// first version of this froze page loads during warm-up. Explicitly
// yielding back to the event loop every few schemes (via setImmediate) is
// what actually lets pending HTTP requests get serviced in between.
async function warmUp() {
  const master = await loadMaster();
  if (!master || !master.length) return;
  loadReturnsCacheFromDisk(master);
  loadCalendarCacheFromDisk(master);

  // Only schemes/modes not already restored from disk actually need CPU
  // work here — on a repeat start with unchanged NAV data, this is 0.
  const pending = [];
  for (const record of master) {
    if (!returnsCache.has(returnsCacheKey(record.schemeCode, 'cagr', 'Monthly'))) pending.push([record, 'cagr']);
    if (!returnsCache.has(returnsCacheKey(record.schemeCode, 'rolling', 'Monthly'))) pending.push([record, 'rolling']);
  }
  if (!pending.length) {
    console.log(`[nav-ledger] Returns cache fully restored from disk — all ${master.length} schemes already warm, nothing to compute.`);
    return;
  }
  console.log(`[nav-ledger] Warming returns cache: ${pending.length} of ${master.length * 2} scheme/mode combinations need computing (rest loaded from disk)… the site is usable right away — this just makes it faster sooner.`);
  const started = Date.now();
  const CHECKPOINT_EVERY = 2000;
  let sinceCheckpoint = 0;
  // Yielding after every single computation (not every few) matters here:
  // Rolling Returns for one scheme takes ~90-110ms of pure synchronous CPU
  // time (it averages ~50+ sample windows per period across 11 periods) —
  // even a "every 5 records" yield left the event loop blocked for ~500ms
  // at a stretch, which was enough to noticeably stall page loads. This
  // keeps each blocking stretch down to a single computation.
  for (const [record, mode] of pending) {
    await computeReturns(record, mode, 'Monthly').catch(() => null);
    await new Promise((resolve) => setImmediate(resolve));
    sinceCheckpoint++;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      await persistReturnsCacheToDisk();
      sinceCheckpoint = 0;
    }
  }
  await persistReturnsCacheToDisk();
  console.log(`[nav-ledger] Warm-up done in ${((Date.now() - started) / 1000).toFixed(1)}s — Monthly SIP CAGR/Rolling returns are now instant for every scheme, and saved to disk so the next restart won't have to redo this work.`);
}

// Called once by the parent src/server.js after the shared HTTP server
// starts listening — runs the same warm-up + daily 9:30 PM AMFI refresh
// that this project's own app.listen() used to kick off, just without
// this sub-app owning its own port or process.
function init() {
  warmUp();
  // Daily auto-refresh of live NAVs. AMFI publishes NAVAll.txt on business
  // days, usually done updating by ~9-10pm IST. Runs at 9:30 PM IST every
  // day — offset from the main dashboard's own 9:00 PM full sync so the
  // two independent data pipelines don't compete for CPU/network at once.
  const cron = require('node-cron');
  cron.schedule('30 21 * * *', () => {
    console.log('[nav-ledger] Running scheduled AMFI NAV refresh...');
    build()
      .then(() => warmUp())
      .catch((err) => console.error('[nav-ledger] Scheduled MFAPI refresh failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });
  console.log('[nav-ledger] Daily auto-refresh scheduled for 21:30 (Asia/Kolkata).');
}

module.exports = router;
module.exports.init = init;