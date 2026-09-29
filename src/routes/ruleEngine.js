const express = require('express');
const path = require('path');
const router = express.Router();

const navData = require(path.join(__dirname, '../../data/navdata.json'));
const staticFundDataStore = require('../services/staticFundDataStore');
const { fetchSchemeHistory } = require('../lib/schemeCalculations');
const { STANDARD_PERIODS, calculateSchemeRuleEngineData } = require('../lib/sipCalculations');

// Safety cap: computing SIP/Lumpsum + rolling windows for every period is
// real work per scheme (multiple XIRR solves). Keep it fast by refusing to
// crunch more than this many schemes in one request — the UI should ask
// the person to narrow their filters instead.
const MAX_SCHEMES_PER_RUN = 150;

// Small in-memory cache so re-running with tweaked SIP/Lumpsum amounts (but
// the same filtered scheme set) doesn't re-fetch history from mfapi.in
// every time — only the history fetch is cached; the SIP/CAGR math itself
// is cheap enough to redo per request since the amount/frequency changes.
const historyCache = new Map(); // code -> { data, fetchedAt }
const HISTORY_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getHistoryCached(code) {
  const hit = historyCache.get(code);
  if (hit && Date.now() - hit.fetchedAt < HISTORY_CACHE_MS) return hit.data;
  const history = await fetchSchemeHistory(code);
  historyCache.set(code, { data: history.data, fetchedAt: Date.now() });
  return history.data;
}

let allSchemesFlat = null;
function getAllSchemes() {
  if (allSchemesFlat) return allSchemesFlat;
  allSchemesFlat = [];
  Object.entries(navData).forEach(([fundHouse, schemes]) => {
    schemes.forEach(s => allSchemesFlat.push({ ...s, fundHouse }));
  });
  return allSchemesFlat;
}

// "12.4", "12.4%", "--" -> number or null (see comment above passesStaticFilters)
function parseNumericValue(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[%,]/g, '').trim();
  if (cleaned === '' || cleaned === '--' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Risk Measures (Std.Dev / Beta / Sharpe / Jensen) use preset-range
// dropdown filters; Market Capitalisation (%) fields use fixed
// 0-25 / 25-50 / 50-75 / 75-100 percentage-band filters. A scheme with
// no static data, or missing the specific field being actively
// filtered, does not match.
function passesStaticFilters(schemeName, q) {
  const rangeKeys = ['stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket'];
  const bucketKeys = ['largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'];
  const hasAny = [...rangeKeys, ...bucketKeys].some(k => q[k] !== undefined && q[k] !== null && String(q[k]).trim() !== '');
  if (!hasAny) return true;

  // Exact match ONLY — never the fuzzy getBySchemeName() lookup. Fuzzy
  // matching here would make unrelated schemes (with no static data of
  // their own) inherit another scheme's Risk Measures / Market Cap by
  // "closest name" guesswork, which is wrong for a hard filter.
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

function applyRuleFilters(schemes, q) {
  let r = schemes;

  if (q.search && q.search.trim()) {
    const term = q.search.trim().toLowerCase();
    r = r.filter(s => s.name.toLowerCase().includes(term));
  }
  if (q.amc) r = r.filter(s => s.fundHouse === q.amc);
  if (q.category) r = r.filter(s => s.category === q.category);
  if (q.schemeType) r = r.filter(s => s.schemeType === q.schemeType);
  if (q.option) r = r.filter(s => s.option === q.option);
  if (q.hideNoLaunchDate === 'true') r = r.filter(s => !!s.launchDate);
  r = r.filter(s => passesStaticFilters(s.name, q));

  return r;
}

// ── Core: filter + compute (returns ALL matching rows, unpaginated) ──
async function computeRuleEngineRows(filters, sipCfg, lumpsumCfg, view) {
  const sipAmount = Number(sipCfg.amount) || 5000;
  const sipFrequency = ['Monthly', 'Weekly', 'Quarterly'].includes(sipCfg.frequency) ? sipCfg.frequency : 'Monthly';
  const sipMinReturn = sipCfg.minReturn !== undefined && sipCfg.minReturn !== '' && sipCfg.minReturn !== null ? Number(sipCfg.minReturn) : null;
  const sipEvalPeriod = sipCfg.evalPeriod && sipCfg.evalPeriod !== 'All Periods' ? sipCfg.evalPeriod : null;

  const lumpsumAmount = Number(lumpsumCfg.amount) || 50000;
  const lumpsumMinReturn = lumpsumCfg.minReturn !== undefined && lumpsumCfg.minReturn !== '' && lumpsumCfg.minReturn !== null ? Number(lumpsumCfg.minReturn) : null;
  const lumpsumEvalPeriod = lumpsumCfg.evalPeriod && lumpsumCfg.evalPeriod !== 'All Periods' ? lumpsumCfg.evalPeriod : null;

  const matched = applyRuleFilters(getAllSchemes(), filters);

  if (matched.length > MAX_SCHEMES_PER_RUN) {
    const err = new Error(`${matched.length} schemes match your filters — please narrow it down to ${MAX_SCHEMES_PER_RUN} or fewer (try selecting an AMC or Category) so the SIP/CAGR engine can run in real time.`);
    err.status = 413;
    err.matchedCount = matched.length;
    throw err;
  }
  if (matched.length === 0) return [];

  const settled = await Promise.allSettled(matched.map(async s => {
    const history = await getHistoryCached(s.code);
    const calc = calculateSchemeRuleEngineData(history, { sipAmount, sipFrequency, lumpsumAmount });
    return { scheme: s, calc };
  }));

  let rows = settled
    .filter(r => r.status === 'fulfilled' && r.value.calc.available)
    .map(r => r.value);

  const periodByKey = k => STANDARD_PERIODS.find(p => p.key === k || p.label === k);

  function passesMinReturn(row) {
    if (sipMinReturn !== null) {
      const list = sipEvalPeriod ? [periodByKey(sipEvalPeriod)].filter(Boolean) : STANDARD_PERIODS;
      const series = view === 'rolling' ? row.calc.sipRolling : row.calc.sip;
      const ok = list.every(p => {
        const entry = series.find(e => e.key === p.key);
        const val = entry && entry.available ? (view === 'rolling' ? entry.avgReturn : entry.valuePct) : null;
        return val !== null && val >= sipMinReturn;
      });
      if (!ok) return false;
    }
    if (lumpsumMinReturn !== null) {
      const list = lumpsumEvalPeriod ? [periodByKey(lumpsumEvalPeriod)].filter(Boolean) : STANDARD_PERIODS;
      const series = view === 'rolling' ? row.calc.lumpsumRolling : row.calc.lumpsum;
      const ok = list.every(p => {
        const entry = series.find(e => e.key === p.key);
        const val = entry && entry.available ? (view === 'rolling' ? entry.avgReturn : entry.valuePct) : null;
        return val !== null && val >= lumpsumMinReturn;
      });
      if (!ok) return false;
    }
    return true;
  }

  rows = rows.filter(passesMinReturn);

  rows.sort((a, b) => {
    const av = a.calc.lumpsum.find(p => p.key === '1y');
    const bv = b.calc.lumpsum.find(p => p.key === '1y');
    const aVal = av && av.available ? av.valuePct : -Infinity;
    const bVal = bv && bv.available ? bv.valuePct : -Infinity;
    return bVal - aVal;
  });

  return rows.map((r, idx) => {
    const staticData = staticFundDataStore.getBySchemeName(r.scheme.name);
    return {
      rank: idx + 1,
      code: r.scheme.code,
      name: r.scheme.name,
      amc: r.scheme.fundHouse,
      category: r.scheme.category,
      schemeType: r.scheme.schemeType,
      option: r.scheme.option,
      latestNav: r.calc.latestNav,
      latestDate: r.calc.latestDate,
      sip: r.calc.sip,
      lumpsum: r.calc.lumpsum,
      sipRolling: r.calc.sipRolling,
      lumpsumRolling: r.calc.lumpsumRolling,
      staticData: staticData ? {
        ...staticData,
        riskMeasures: staticData.riskMeasures || {},
        marketCapitalisation: staticData.marketCapitalisation || {},
        amfiSectors: staticData.amfiSectors || [],
        exitLoad: staticData.exitLoad || ''
      } : null
    };
  });
}

// ── Filter dropdown options (AMC / Category / Type / Option) ──
router.get('/rule-engine/filter-options', (req, res) => {
  const all = getAllSchemes();
  const uniq = key => [...new Set(all.map(s => s[key]).filter(Boolean))].sort();

  res.json({
    amc: Object.keys(navData).sort(),
    category: uniq('category'),
    schemeType: uniq('schemeType'),
    option: uniq('option'),
    periods: STANDARD_PERIODS.map(p => ({ key: p.key, label: p.label }))
  });
});

// ── Run the rule engine ────────────────────────────────
// POST because the SIP/Lumpsum config + column selection can get long
// (and this may grow to include per-period min-return rules).
router.post('/rule-engine/run', async (req, res) => {
  const body = req.body || {};
  const filters = body.filters || {};
  const sip = body.sip || {};
  const lumpsum = body.lumpsum || {};
  const view = body.view === 'rolling' ? 'rolling' : 'cagr'; // 'cagr' | 'rolling'
  const page = Math.max(1, parseInt(body.page) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(body.limit) || 25));

  try {
    const rows = await computeRuleEngineRows(filters, sip, lumpsum, view);

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const pageRows = rows.slice((page - 1) * limit, page * limit)
      .map((r, idx) => ({ ...r, rank: (page - 1) * limit + idx + 1 }));

    res.json({
      total,
      schemesFound: total,
      filtersApplied: countActiveFilters(filters),
      sipAmount: Number(sip.amount) || 5000,
      sipFrequency: sip.frequency || 'Monthly',
      lumpsumAmount: Number(lumpsum.amount) || 50000,
      view,
      page,
      limit,
      totalPages,
      periods: STANDARD_PERIODS.map(p => ({ key: p.key, label: p.label })),
      rows: pageRows,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    if (err.status === 413) {
      return res.status(413).json({ error: err.message, matchedCount: err.matchedCount, limit: MAX_SCHEMES_PER_RUN });
    }
    console.error('Rule engine run error:', err);
    res.status(500).json({ error: 'Failed to run the rule engine. Please try again.' });
  }
});

// ── Export the FULL (unpaginated) result to Excel ─────
router.post('/rule-engine/export', async (req, res) => {
  const body = req.body || {};
  const filters = body.filters || {};
  const sip = body.sip || {};
  const lumpsum = body.lumpsum || {};
  const view = body.view === 'rolling' ? 'rolling' : 'cagr';
  const guideCols = Array.isArray(body.guideCols) ? body.guideCols : STANDARD_PERIODS.map(p => p.key);

  try {
    const rows = await computeRuleEngineRows(filters, sip, lumpsum, view);
    if (rows.length === 0) return res.status(404).json({ error: 'No schemes match your filters/rules.' });

    const XLSX = require('xlsx');
    const periods = STANDARD_PERIODS.filter(p => guideCols.includes(p.key));

    const headers = ['Rank', 'Scheme Code', 'Scheme Name', 'AMC', 'Category'];
    periods.forEach(p => headers.push(`SIP ${p.label} (${view === 'rolling' ? 'Rolling Avg' : 'XIRR'} %)`));
    periods.forEach(p => headers.push(`Lumpsum ${p.label} (${view === 'rolling' ? 'Rolling Avg' : 'CAGR'} %)`));

    const wsData = [headers];
    rows.forEach(r => {
      const row = [r.rank, r.code, r.name, r.amc, r.category];
      periods.forEach(p => {
        const series = view === 'rolling' ? r.sipRolling : r.sip;
        const e = series.find(x => x.key === p.key);
        row.push(e && e.available ? (view === 'rolling' ? e.avgReturn : e.valuePct) : '—');
      });
      periods.forEach(p => {
        const series = view === 'rolling' ? r.lumpsumRolling : r.lumpsum;
        const e = series.find(x => x.key === p.key);
        row.push(e && e.available ? (view === 'rolling' ? e.avgReturn : e.valuePct) : '—');
      });
      wsData.push(row);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, 'Rule Engine Results');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="Rule_Engine_Results_${timestamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    if (err.status === 413) return res.status(413).json({ error: err.message });
    console.error('Rule engine export error:', err);
    res.status(500).json({ error: 'Failed to export. Please try again.' });
  }
});

function countActiveFilters(filters) {
  return ['search', 'amc', 'category', 'schemeType', 'option',
    'stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket',
    'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'
  ].filter(k => filters[k] && String(filters[k]).trim() !== '').length
    + (filters.hideNoLaunchDate === 'true' ? 1 : 0);
}

module.exports = router;