const express = require('express');
const router = express.Router();
const path = require('path');
const https = require('https');
const XLSX = require('xlsx');
const navData = require(path.join(__dirname, '../../data/navdata.json'));
const fs = require('fs');
const staticFundDataStore = require('../services/staticFundDataStore');
const { requireAdmin } = require('../middleware/auth');
const { INDUSTRIES, classifyIndustry } = require('../lib/industryClassifier');

const allSchemes = Object.values(navData).flat();
const filterOptions = {
  schemeTypes: [...new Set(allSchemes.map(s => s.schemeType))].filter(Boolean).sort(),
  plans: [...new Set(allSchemes.map(s => s.plan))].filter(Boolean).sort(),
  options: [...new Set(allSchemes.map(s => s.option))].filter(Boolean).sort(),
  categories: [...new Set(allSchemes.map(s => s.category))].filter(Boolean).sort(),
  industries: INDUSTRIES
};

const {
  fetchLiveNAV,
  fetchSchemeHistory,
  parseMfapiDate,
  getAvailableYearPeriods,
  calculateReturns,
  findNavOnOrBefore,
  findNavOnOrAfter,
  calculateCustomReturn,
  calculateCustomRollingReturns,
  calculateAllRollingReturns
} = require('../lib/schemeCalculations');
const returnsCache = require('../services/returnsCache');

router.get('/nav/returns/:code', async (req, res) => {
  const { code } = req.params;
  const { from, to } = req.query;
  const needsCustomRange = Boolean(from && to);

  try {
    // A custom date range always needs the live full-history array (the
    // cache only stores the pre-computed summary), so only short-circuit
    // to cache for the plain "standard years" view.
    if (!needsCustomRange) {
      const cached = returnsCache.get(code);
      if (cached && !returnsCache.isStale(cached)) {
        return res.json({
          code,
          schemeName: cached.schemeName || '',
          currentNav: cached.currentNav,
          currentDate: cached.currentDate,
          returns: cached.returns,
          custom: null,
          customError: null,
          cached: true,
          computedAt: cached.computedAt
        });
      }
    }

    const history = await fetchSchemeHistory(code);
    const result = calculateReturns(history.data);

    let custom = null;
    let customError = null;
    if (needsCustomRange) {
      try {
        custom = calculateCustomReturn(history.data, from, to);
      } catch (err) {
        customError = err.message;
      }
    }

    // Opportunistically cache (also computes + saves rolling returns so a
    // later click on Rolling Returns is instant too).
    returnsCache.save(code, { schemeName: history.meta.scheme_name || '', history, returnsResult: result });

    res.json({
      code,
      schemeName: history.meta.scheme_name || '',
      currentNav: result.latestNav,
      currentDate: result.latestDate,
      returns: result.returns,
      custom,
      customError,
      cached: false
    });
  } catch (error) {
    console.error(`Returns calc error for ${code}:`, error.message);
    // Fall back to any cached copy (even stale) rather than showing nothing —
    // handy when mfapi.in itself is unreachable.
    const stale = returnsCache.get(code);
    if (stale) {
      return res.json({
        code,
        schemeName: stale.schemeName || '',
        currentNav: stale.currentNav,
        currentDate: stale.currentDate,
        returns: stale.returns,
        custom: null,
        customError: needsCustomRange ? 'Live data unavailable right now — showing cached returns only.' : null,
        cached: true,
        stale: true,
        computedAt: stale.computedAt
      });
    }
    res.status(502).json({ error: 'Unable to calculate returns for this scheme' });
  }
});

// ── Export returns (fixed periods + optional custom range) to Excel ──
router.get('/nav/returns/:code/export', async (req, res) => {
  const { code } = req.params;
  const { from, to } = req.query;
  try {
    const history = await fetchSchemeHistory(code);
    const result = calculateReturns(history.data);
    const schemeName = history.meta.scheme_name || code;
    const scheme = allSchemes.find(s => s.code === code) || {};
    const rolling = calculateAllRollingReturns(history.data);

    let custom = null;
    let customError = null;
    if (from && to) {
      try {
        custom = calculateCustomReturn(history.data, from, to);
      } catch (err) {
        customError = err.message;
      }
    }

    const wsData = [
      ['Scheme Code', code],
      ['Scheme Name', schemeName],
      ['Current NAV (₹)', result.latestNav],
      ['Current Date', result.latestDate],
      [],
      ['Period', 'From Date', 'From NAV (₹)', 'To Date', 'To NAV (₹)', 'Absolute Return (%)', 'CAGR (%)']
    ];

    result.returns.forEach(r => {
      if (r.available) {
        wsData.push([
          r.label, r.fromDate, r.fromNav, result.latestDate, result.latestNav,
          r.simpleReturnPct, r.cagrPct
        ]);
      } else {
        wsData.push([r.label, 'N/A', 'N/A', result.latestDate, result.latestNav, 'N/A', 'N/A']);
      }
    });

    if (custom) {
      wsData.push([]);
      wsData.push(['Custom Date Range Return']);
      wsData.push(['Selected From Date', custom.fromRequested]);
      wsData.push(['Selected To Date', custom.toRequested]);
      wsData.push([
        `${custom.fromRequested} → ${custom.toRequested}`,
        custom.fromDate, custom.fromNav, custom.toDate, custom.toNav,
        custom.simpleReturnPct, custom.cagrPct
      ]);
      wsData.push(['Matched Trading Days', custom.fromDate, '', custom.toDate]);
      wsData.push(['Duration', `${custom.days} days`, `${custom.years} yrs`]);
    } else if (customError) {
      wsData.push([]);
      wsData.push(['Custom Range', customError]);
    }

    // Keep rolling-return values in the first worksheet as well, so they are
    // immediately visible when the exported file opens (not hidden in another tab).
    wsData.push([]);
    wsData.push(['Rolling Returns']);
    wsData.push(['Period', 'Rolling Windows', 'Average CAGR (%)', 'Median (%)', 'Minimum (%)', 'Maximum (%)', '% Time Positive']);
    rolling.forEach(r => {
      wsData.push(r.available
        ? [r.label, r.windowCount, r.avgReturn, r.medianReturn, r.minReturn, r.maxReturn, r.positivePct]
        : [r.label, 0, 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Returns');

    // Export every section shown in the scheme details modal, not only CAGR returns.
    const detailsSheet = XLSX.utils.aoa_to_sheet([
      ['Field', 'Value'],
      ['Scheme Code', code],
      ['Scheme Name', scheme.name || schemeName],
      ['Scheme Type', scheme.schemeType || '—'],
      ['Category', scheme.category || '—'],
      ['Plan', scheme.plan || '—'],
      ['Option', scheme.option || '—'],
      ['Launch Date', scheme.launchDate || '—'],
      ['ISIN Growth / Div Payout', scheme.isin_growth || '—'],
      ['ISIN Div Reinvestment', scheme.isin_div_reinvestment || '—'],
      ['Live NAV (₹)', result.latestNav],
      ['Live Date', result.latestDate],
      ['Snapshot NAV (₹)', scheme.nav || '—'],
      ['Snapshot Date', scheme.date || '—'],
      ['Latest NAV Endpoint', scheme.url || `https://api.mfapi.in/mf/${code}/latest`],
      ['Full History Endpoint', (scheme.url || `https://api.mfapi.in/mf/${code}/latest`).replace('/latest', '')]
    ]);
    detailsSheet['!cols'] = [{ wch: 28 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, detailsSheet, 'Scheme Details');

    const rollingSheet = XLSX.utils.aoa_to_sheet([
      ['Period', 'Rolling Windows', 'Average CAGR (%)', 'Median (%)', 'Minimum (%)', 'Maximum (%)', '% Time Positive'],
      ...rolling.map(r => r.available
        ? [r.label, r.windowCount, r.avgReturn, r.medianReturn, r.minReturn, r.maxReturn, r.positivePct]
        : [r.label, 0, 'N/A', 'N/A', 'N/A', 'N/A', 'N/A'])
    ]);
    rollingSheet['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, rollingSheet, 'Rolling Returns');

    const historySheet = XLSX.utils.aoa_to_sheet([
      ['Date', 'NAV (₹)'],
      ...history.data.map(entry => [entry.date, Number(entry.nav)])
    ]);
    historySheet['!cols'] = [{ wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, historySheet, 'NAV History');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Scheme_Details_${code}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error(`Returns export error for ${code}:`, error.message);
    res.status(502).json({ error: 'Unable to export returns for this scheme' });
  }
});

// ── Rolling Returns ────────────────────────────────────
// (calculation logic lives in src/lib/schemeCalculations.js, shared with
// the background sync service so the numbers are always identical)

router.get('/nav/rolling-returns/:code', async (req, res) => {
  const { code } = req.params;
  const { from, to } = req.query;
  const needsCustomRange = Boolean(from && to);

  try {
    // A custom date range needs the live full-history array (the cache only
    // stores the fixed-period rolling stats), so only short-circuit to
    // cache when no custom range was requested.
    if (!needsCustomRange) {
      const cached = returnsCache.get(code);
      if (cached && !returnsCache.isStale(cached)) {
        return res.json({
          code,
          schemeName: cached.schemeName || '',
          rolling: cached.rolling,
          customRolling: null,
          customRollingError: null,
          cached: true,
          computedAt: cached.computedAt
        });
      }
    }

    const history = await fetchSchemeHistory(code);
    const rolling = calculateAllRollingReturns(history.data);
    const schemeName = history.meta.scheme_name || '';

    let customRolling = null;
    let customRollingError = null;
    if (needsCustomRange) {
      try {
        customRolling = calculateCustomRollingReturns(history.data, from, to);
      } catch (err) {
        customRollingError = err.message;
      }
    }

    // Save opportunistically so the next click (or a future sync) is instant.
    returnsCache.save(code, { schemeName, history, rolling });

    res.json({ code, schemeName, rolling, customRolling, customRollingError, cached: false });
  } catch (error) {
    console.error(`Rolling returns error for ${code}:`, error.message);
    // Last resort: if we have *any* cached copy (even stale), it's still
    // better than nothing — especially useful if mfapi.in is down.
    const stale = returnsCache.get(code);
    if (stale) {
      return res.json({
        code,
        schemeName: stale.schemeName || '',
        rolling: stale.rolling,
        customRolling: null,
        customRollingError: needsCustomRange ? 'Live data unavailable right now — showing cached rolling returns only.' : null,
        cached: true,
        stale: true,
        computedAt: stale.computedAt
      });
    }
    res.status(502).json({ error: 'Unable to calculate rolling returns for this scheme' });
  }
});

router.get('/nav/rolling-returns/:code/export', async (req, res) => {
  const { code } = req.params;
  try {
    const history = await fetchSchemeHistory(code);
    const schemeName = history.meta.scheme_name || code;
    const rolling = calculateAllRollingReturns(history.data);

    const wsData = [
      ['Scheme Code', code],
      ['Scheme Name', schemeName],
      [],
      ['Period', 'Rolling Windows', 'Average (%)', 'Median (%)', 'Minimum (%)', 'Maximum (%)', '% Time Positive']
    ];

    rolling.forEach(r => {
      if (r.available) {
        wsData.push([r.label, r.windowCount, r.avgReturn, r.medianReturn, r.minReturn, r.maxReturn, r.positivePct]);
      } else {
        wsData.push([r.label, 0, 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
      }
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Rolling Returns');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `RollingReturns_${code}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error(`Rolling returns export error for ${code}:`, error.message);
    res.status(502).json({ error: 'Unable to export rolling returns for this scheme' });
  }
});

router.get('/funds', (req, res) => {
  const funds = Object.keys(navData)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(name => ({ name, count: navData[name].length }));

  res.json(funds);
});

router.get('/filter-options', (req, res) => res.json(filterOptions));

// ── Collect schemes across fund houses, optionally scoped to just one
// (used by the Home page's "AMC" filter, which replaced the old sidebar) ──
function collectAllSchemes(fundHouseFilter) {
  let all = [];
  Object.entries(navData).forEach(([fundName, schemes]) => {
    if (fundHouseFilter && fundName !== fundHouseFilter) return;
    all = all.concat(schemes);
  });
  return all;
}

// Same as collectAllSchemes(), but each scheme is a shallow copy carrying
// its fund-house name (for the "AMC" column) and its classified
// "industry" too — needed for the Home page's AMC/Industry filters. A
// copy (not the shared navData objects themselves) so this never risks
// mutating data used elsewhere (exports, launch-date edits).
function collectAllSchemesWithFundHouse(fundHouseFilter) {
  let all = [];
  Object.entries(navData).forEach(([fundName, schemes]) => {
    if (fundHouseFilter && fundName !== fundHouseFilter) return;
    all = all.concat(schemes.map(s => ({
      ...s,
      fundHouse: fundName,
      industry: classifyIndustry(s.name, s.category)
    })));
  });
  return all;
}

function withStaticFundData(scheme) {
  const record = staticFundDataStore.getBySchemeName(scheme.name || scheme.schemeName || '');
  return {
    ...scheme,
    staticData: record ? {
      ...record,
      riskMeasures: record.riskMeasures || {},
      marketCapitalisation: record.marketCapitalisation || {},
      amfiSectors: record.amfiSectors || [],
      exitLoad: record.exitLoad || ''
    } : null
  };
}

function withStaticFundDataList(schemes) {
  return schemes.map(withStaticFundData);
}

router.get('/live-nav', async (req, res) => {
  const { codes } = req.query;
  if (!codes) return res.json([]);
  const list = codes.split(',').map(c => c.trim()).filter(Boolean).slice(0, 50);
  res.json(await Promise.all(list.map(fetchLiveNAV)));
});

// ── Apply filters helper ──────────────────────────────
function applyFilters(schemes, q) {
  let r = [...schemes];
  
  if (q.search && q.search.trim()) {
    const searchTerm = q.search.trim().toLowerCase();
    r = r.filter(s => s.name.toLowerCase().includes(searchTerm));
  }
  
  if (q.code && q.code.trim()) {
    const codeTerm = q.code.trim();
    r = r.filter(s => s.code.includes(codeTerm));
  }
  
  if (q.schemeType) r = r.filter(s => s.schemeType === q.schemeType);
  if (q.plan) r = r.filter(s => s.plan === q.plan);
  if (q.option) r = r.filter(s => s.option === q.option);
  if (q.category) r = r.filter(s => s.category === q.category);
  if (q.industry) r = r.filter(s => s.industry === q.industry);

  const profileFilterKeys = ['stdDevBucket', 'betaBucket', 'sharpeBucket', 'jensenBucket', 'largeCapBucket', 'midCapBucket', 'smallCapBucket', 'cashBucket'];
  if (profileFilterKeys.some(key => q[key])) {
    const numberFromProfile = (value) => {
      const parsed = Number(String(value ?? '').replace(/[%,]/g, '').trim());
      return Number.isFinite(parsed) ? parsed : null;
    };
    const matchesRange = (value, code) => {
      if (!code) return true;
      if (value === null) return false;
      if (code.startsWith('lt')) return value < Number(code.slice(2));
      if (code.startsWith('gte')) return value >= Number(code.slice(3));
      const [min, max] = code.split('-').map(Number);
      return value >= min && (max === 100 ? value <= max : value < max);
    };
    r = r.filter(scheme => {
      // This runs across the full catalogue. Use the indexed exact lookup,
      // never the display-only fuzzy matcher (which scans every profile for
      // every scheme and can block the server for minutes).
      const profile = staticFundDataStore.findExactBySchemeName(scheme.name || scheme.schemeName || '');
      const risk = profile?.riskMeasures || {};
      const market = profile?.marketCapitalisation || {};
      return matchesRange(numberFromProfile(risk['Std.Dev']), q.stdDevBucket)
        && matchesRange(numberFromProfile(risk['Beta (Slope)']), q.betaBucket)
        && matchesRange(numberFromProfile(risk.Sharpe), q.sharpeBucket)
        && matchesRange(numberFromProfile(risk.Jenson), q.jensenBucket)
        && matchesRange(numberFromProfile(market['Large Cap']), q.largeCapBucket)
        && matchesRange(numberFromProfile(market['Mid Cap']), q.midCapBucket)
        && matchesRange(numberFromProfile(market['Small Cap']), q.smallCapBucket)
        && matchesRange(numberFromProfile(market.Cash), q.cashBucket);
    });
  }
  
  if (q.minNav && q.minNav !== '') r = r.filter(s => s.nav >= parseFloat(q.minNav));
  if (q.maxNav && q.maxNav !== '') r = r.filter(s => s.nav <= parseFloat(q.maxNav));
  
  if (q.sortBy === 'nav_asc') r.sort((a, b) => a.nav - b.nav);
  else if (q.sortBy === 'nav_desc') r.sort((a, b) => b.nav - a.nav);
  else if (q.sortBy === 'name_asc') r.sort((a, b) => a.name.localeCompare(b.name));
  else if (q.sortBy === 'name_desc') r.sort((a, b) => b.name.localeCompare(a.name));
  else if (q.sortBy === 'code_asc') r.sort((a, b) => a.code.localeCompare(b.code));
  else if (q.sortBy === 'code_desc') r.sort((a, b) => b.code.localeCompare(a.code));
  
  return r;
}

// ── Update a scheme's launch date (editable field) ────
// Persists directly to data/navdata.json so the edit survives restarts.
// Accepts either "YYYY-MM-DD" (native <input type="date"> value) or the
// project's display format "DD-MMM-YYYY".
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function toDisplayDate(raw) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (iso) {
    const d = new Date(`${raw.trim()}T00:00:00`);
    if (isNaN(d.getTime())) return null;
    return `${String(d.getDate()).padStart(2, '0')}-${MONTH_ABBR[d.getMonth()]}-${d.getFullYear()}`;
  }
  const disp = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (disp && MONTH_ABBR.includes(disp[2][0].toUpperCase() + disp[2].slice(1).toLowerCase())) {
    return `${disp[1].padStart(2, '0')}-${disp[2][0].toUpperCase()}${disp[2].slice(1).toLowerCase()}-${disp[3]}`;
  }
  return null;
}

// Only admins may edit the launch date. Viewing schemes (all other GET routes)
// remains open to any authenticated user.
router.patch('/scheme/:code/launch-date', requireAdmin, (req, res) => {
  const { code } = req.params;
  const { launchDate } = req.body || {};

  if (!launchDate || typeof launchDate !== 'string') {
    return res.status(400).json({ error: 'launchDate is required' });
  }

  const formatted = toDisplayDate(launchDate);
  if (!formatted) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD or DD-MMM-YYYY.' });
  }

  const scheme = allSchemes.find(s => s.code === code);
  if (!scheme) return res.status(404).json({ error: 'Scheme not found' });

  scheme.launchDate = formatted;

  try {
    fs.writeFileSync(
      path.join(__dirname, '../../data/navdata.json'),
      JSON.stringify(navData, null, 2)
    );
  } catch (err) {
    console.error('Failed to persist launch date:', err.message);
    return res.status(500).json({ error: 'Saved in memory but failed to write to disk' });
  }

  res.json({ code, launchDate: formatted });
});

router.get('/funds/:name', (req, res) => {
  const fundName = decodeURIComponent(req.params.name);
  const schemes = navData[fundName];
  if (!schemes) return res.status(404).json({ error: 'Fund house not found' });

  const result = applyFilters(schemes, req.query);
  const total = result.length;
  const page = parseInt(req.query.page || 1);
  const limit = parseInt(req.query.limit || 50);
  const pageSchemes = result.slice((page - 1) * limit, page * limit);

  res.json({
    fundHouse: fundName, total, page, limit,
    totalPages: Math.ceil(total / limit),
    schemes: withStaticFundDataList(pageSchemes)
  });
});

// ── Get all schemes with filters ──────────────────────
// ── Home-page Plan/Option lock for non-admin users ────
// Admins can filter the Home page by any Plan/Option. Regular ("view
// only") users are locked to Plan=Regular, Option=Growth. Enforced here
// server-side — not just by disabling the dropdown on the frontend — so
// it can't be bypassed by calling the API directly with different query
// params.
function lockPlanOptionForNonAdmin(req, query) {
  const isAdminUser = !!(req.session && req.session.user && req.session.user.role === 'admin');
  if (isAdminUser) return query;
  return { ...query, plan: 'Regular', option: 'Growth' };
}

router.get('/all-schemes', (req, res) => {
  const allSchemesData = collectAllSchemesWithFundHouse(req.query.fundHouse);
  
  const result = applyFilters(allSchemesData, lockPlanOptionForNonAdmin(req, req.query));
  const total = result.length;
  const page = parseInt(req.query.page || 1);
  const limit = parseInt(req.query.limit || 50);
  const pageSchemes = result.slice((page - 1) * limit, page * limit);

  // Attach cached Returns (CAGR) + Rolling Returns for just this page's
  // schemes — cheap in-memory lookups against the already-loaded cache,
  // no live mfapi.in calls, so this stays fast even for large pages.
  const schemesWithReturns = pageSchemes.map(s => {
    const cached = returnsCache.get(s.code);
    return {
      ...withStaticFundData(s),
      returns: cached ? cached.returns : null,
      rolling: cached ? cached.rolling : null,
      returnsSynced: !!cached
    };
  });

  res.json({
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    schemes: schemesWithReturns
  });
});

// ── Excel download for specific fund house ──────────────
router.get('/download/:name', (req, res) => {
  const fundName = decodeURIComponent(req.params.name);
  const schemes = navData[fundName];
  if (!schemes) return res.status(404).json({ error: 'Not found' });

  const rows = applyFilters(schemes, req.query);

  const wsData = [
    ['Scheme Code', 'ISIN Growth', 'ISIN Div Reinvestment', 'Scheme Name', 'Plan', 'Option', 'Scheme Type', 'Category', 'Launch Date', 'NAV (₹)', 'Date', 'API URL']
  ];
  rows.forEach(s => wsData.push([
    s.code,
    s.isin_growth || '—',
    s.isin_div_reinvestment || '—',
    s.name,
    s.plan,
    s.option,
    s.schemeType,
    s.category,
    s.launchDate || '—',
    s.nav,
    s.date,
    s.url
  ]));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 60 }, { wch: 10 },
    { wch: 16 }, { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 42 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, fundName.slice(0, 31));

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `${fundName.replace(/[^a-zA-Z0-9]/g, '_')}_NAV.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Download all schemes with filters ────────────────
router.get('/download-all-schemes', (req, res) => {
  let allSchemesData = [];
  Object.values(navData).forEach(fundSchemes => {
    allSchemesData = allSchemesData.concat(fundSchemes);
  });
  
  const rows = applyFilters(allSchemesData, req.query);

  if (rows.length === 0) {
    return res.status(404).json({ error: 'No schemes match your filters' });
  }

  const wsData = [
    ['Scheme Code', 'ISIN Growth', 'ISIN Div Reinvestment', 'Scheme Name', 'Plan', 'Option', 'Scheme Type', 'Category', 'Launch Date', 'NAV (₹)', 'Date', 'API URL']
  ];
  rows.forEach(s => wsData.push([
    s.code,
    s.isin_growth || '—',
    s.isin_div_reinvestment || '—',
    s.name,
    s.plan,
    s.option,
    s.schemeType || '—',
    s.category || '—',
    s.launchDate || '—',
    s.nav,
    s.date,
    s.url
  ]));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 60 }, { wch: 10 },
    { wch: 16 }, { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 42 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'All Schemes');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `All_Schemes_NAV_${timestamp}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Shared helper: build the "full data" workbook (NAV + Returns CAGR +
// Rolling Returns for every synced period) for a given list of scheme
// rows. Used by both the sitewide "Download All Filtered Schemes" export
// and each fund house's "Export All" export.
function buildFullDataWorkbook(rows, sheetName) {
  const enriched = rows.map(s => ({ scheme: s, cached: returnsCache.get(s.code) }));

  // Union of every period label present across these schemes' cached
  // data, ordered chronologically (1M, 3M, 5M, 7M, 10M, 1Y, 2Y…).
  const periodMonths = new Map();
  enriched.forEach(({ cached }) => {
    if (!cached || !cached.returns) return;
    cached.returns.forEach(r => {
      if (!periodMonths.has(r.label)) periodMonths.set(r.label, r.months);
    });
  });
  const periods = [...periodMonths.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([label]) => label);

  const baseHeaders = [
    'Scheme Code', 'ISIN Growth', 'ISIN Div Reinvestment', 'Scheme Name', 'Plan', 'Option',
    'Scheme Type', 'Category', 'Launch Date', 'NAV (₹)', 'Date', 'API URL',
    'Returns Synced', 'Synced As Of'
  ];
  const periodHeaders = [];
  periods.forEach(label => {
    periodHeaders.push(
      `${label} Return (CAGR %)`,
      `${label} Rolling Avg %`,
      `${label} Rolling Min %`,
      `${label} Rolling Max %`,
      `${label} Rolling Median %`,
      `${label} Rolling Positive %`
    );
  });

  const wsData = [[...baseHeaders, ...periodHeaders]];

  enriched.forEach(({ scheme: s, cached }) => {
    const row = [
      s.code,
      s.isin_growth || '—',
      s.isin_div_reinvestment || '—',
      s.name,
      s.plan,
      s.option,
      s.schemeType || '—',
      s.category || '—',
      s.launchDate || '—',
      s.nav,
      s.date,
      s.url,
      cached ? 'Yes' : 'No',
      cached && cached.computedAt ? new Date(cached.computedAt).toLocaleString() : '—'
    ];

    const returnsByLabel = new Map((cached && cached.returns || []).map(r => [r.label, r]));
    const rollingByLabel = new Map((cached && cached.rolling || []).map(r => [r.label, r]));

    periods.forEach(label => {
      const r = returnsByLabel.get(label);
      row.push(r && r.available ? r.cagrPct : '—');

      const roll = rollingByLabel.get(label);
      if (roll && roll.available) {
        row.push(roll.avgReturn, roll.minReturn, roll.maxReturn, roll.medianReturn, roll.positivePct);
      } else {
        row.push('—', '—', '—', '—', '—');
      }
    });

    wsData.push(row);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const colWidths = [
    { wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 60 }, { wch: 10 },
    { wch: 16 }, { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 42 },
    { wch: 15 }, { wch: 20 }
  ];
  periods.forEach(() => {
    colWidths.push({ wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 16 }, { wch: 16 });
  });
  ws['!cols'] = colWidths;
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31)); // Excel sheet-name limit
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Download all filtered schemes WITH full data ──────
// Includes every column from the plain export PLUS, for every return
// period that has been synced (1M/3M/5M/7M/10M/1Y/2Y/…), the CAGR return
// and the full rolling-returns distribution (avg/min/max/median/%positive).
// Pulls purely from returnsCache (populated by a full Sync) — it never hits
// mfapi.in live, so it stays fast even for 14,000+ schemes. Any scheme that
// hasn't been synced yet is still included with its base info; its return
// columns are just left blank and "Returns Synced" says "No".
router.get('/download-all-schemes-full', (req, res) => {
  const allSchemesData = collectAllSchemes(req.query.fundHouse);

  const rows = applyFilters(allSchemesData, lockPlanOptionForNonAdmin(req, req.query));

  if (rows.length === 0) {
    return res.status(404).json({ error: 'No schemes match your filters' });
  }

  const buf = buildFullDataWorkbook(rows, 'All Schemes (Full Data)');
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `All_Schemes_Full_Data_${timestamp}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Download ONE fund house's schemes WITH full data ──
// Same as above (NAV + CAGR Returns + Rolling Returns for every synced
// period) but scoped to a single fund house, honoring whatever filters
// are currently applied on that fund house's page. Reached from the
// "Export All (Excel)" button in the fund-house header.
router.get('/download/:name/full', (req, res) => {
  const fundName = decodeURIComponent(req.params.name);
  const schemes = navData[fundName];
  if (!schemes) return res.status(404).json({ error: 'Fund house not found' });

  const rows = applyFilters(schemes, req.query);
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No schemes match your filters' });
  }

  const buf = buildFullDataWorkbook(rows, fundName);
  const timestamp = new Date().toISOString().slice(0, 10);
  const safeName = fundName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const filename = `${safeName}_Full_Data_${timestamp}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Export single scheme latest NAV ──────────────────
router.get('/export-scheme/:code', async (req, res) => {
  const code = req.params.code;
  
  try {
    const result = await fetchLiveNAV(code);
    
    if (!result.live || !result.nav) {
      return res.status(404).json({ error: 'Failed to fetch live NAV for this scheme' });
    }
    
    const allSchemesData = Object.values(navData).flat();
    const scheme = allSchemesData.find(s => s.code === code);
    
    if (!scheme) {
      return res.status(404).json({ error: 'Scheme not found in local data' });
    }
    
    const wsData = [
      ['Field', 'Value'],
      ['Scheme Code', scheme.code],
      ['Scheme Name', scheme.name],
      ['Plan', scheme.plan],
      ['Option', scheme.option],
      ['Scheme Type', scheme.schemeType || '—'],
      ['Category', scheme.category || '—'],
      ['Launch Date', scheme.launchDate || '—'],
      ['ISIN Growth', scheme.isin_growth || '—'],
      ['ISIN Div Reinvestment', scheme.isin_div_reinvestment || '—'],
      ['Latest NAV (₹)', result.nav],
      ['Latest Date', result.date],
      ['API URL', scheme.url]
    ];
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 25 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Scheme Details');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${scheme.code}_${scheme.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}_NAV.xlsx`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export scheme data' });
  }
});

// ── Zerodha endpoints ──────────────────────────────────

// Proxy for Zerodha API (handles CORS)
router.get('/zerodha/instruments', async (req, res) => {
  try {
    const options = {
      hostname: 'api.kite.trade',
      path: '/mf/instruments',
      method: 'GET'
    };
    
    const request = https.get(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          if (data.includes(',') && data.includes('\n')) {
            res.setHeader('Content-Type', 'text/plain');
            res.send(data);
          } else {
            try {
              const json = JSON.parse(data);
              res.json(json);
            } catch (e) {
              res.setHeader('Content-Type', 'text/plain');
              res.send(data);
            }
          }
        } catch (error) {
          console.error('Zerodha parse error:', error);
          res.status(500).json({ error: 'Failed to parse Zerodha response' });
        }
      });
    });
    
    request.on('error', (error) => {
      console.error('Zerodha API error:', error);
      res.status(500).json({ error: 'Failed to fetch from Zerodha API' });
    });
    
    request.end();
    
  } catch (error) {
    console.error('Zerodha proxy error:', error);
    res.status(500).json({ error: 'Failed to fetch Zerodha data' });
  }
});

// Export all Zerodha data as Excel
router.get('/zerodha/export-all', async (req, res) => {
  try {
    const options = {
      hostname: 'api.kite.trade',
      path: '/mf/instruments',
      method: 'GET'
    };
    
    const request = https.get(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          let parsedData;
          if (data.includes(',') && data.includes('\n')) {
            const lines = data.split('\n').filter(line => line.trim());
            if (lines.length < 2) {
              throw new Error('No data found');
            }
            
            const headers = lines[0].split(',').map(h => h.trim());
            parsedData = [];
            for (let i = 1; i < lines.length; i++) {
              const values = lines[i].split(',');
              const obj = {};
              headers.forEach((header, index) => {
                obj[header] = values[index] ? values[index].trim() : '';
              });
              parsedData.push(obj);
            }
          } else {
            try {
              parsedData = JSON.parse(data);
            } catch (e) {
              throw new Error('Invalid data format');
            }
          }
          
          if (!Array.isArray(parsedData) || parsedData.length === 0) {
            throw new Error('No data available');
          }
          
          const wsData = [
            ['Trading Symbol', 'AMC', 'Scheme Name', 'Purchase Allowed', 'Redemption Allowed',
              'Min Purchase Amount', 'Min Additional Purchase', 'Min Redemption Qty',
              'Dividend Type', 'Scheme Type', 'Plan', 'Settlement Type', 'NAV (₹)', 'NAV Date']
          ];
          
          parsedData.forEach(item => {
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
            { wch: 18 }, { wch: 30 }, { wch: 50 }, { wch: 15 }, { wch: 18 },
            { wch: 20 }, { wch: 22 }, { wch: 18 }, { wch: 15 }, { wch: 15 },
            { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 15 }
          ];
          XLSX.utils.book_append_sheet(wb, ws, 'Zerodha Instruments');
          
          const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
          const timestamp = new Date().toISOString().slice(0, 10);
          const filename = `Zerodha_Instruments_${timestamp}.xlsx`;
          
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.send(buf);
          
        } catch (error) {
          console.error('Export all error:', error);
          res.status(500).json({ error: 'Failed to export data' });
        }
      });
    });
    
    request.on('error', (error) => {
      console.error('Export all fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch data' });
    });
    request.end();
    
  } catch (error) {
    console.error('Export all error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Export individual Zerodha instrument
router.get('/zerodha/export/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    
    const options = {
      hostname: 'api.kite.trade',
      path: '/mf/instruments',
      method: 'GET'
    };
    
    const request = https.get(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          let parsedData;
          if (data.includes(',') && data.includes('\n')) {
            const lines = data.split('\n').filter(line => line.trim());
            if (lines.length < 2) {
              throw new Error('No data found');
            }
            
            const headers = lines[0].split(',').map(h => h.trim());
            let foundItem = null;
            
            for (let i = 1; i < lines.length; i++) {
              const values = lines[i].split(',');
              const obj = {};
              headers.forEach((header, index) => {
                obj[header] = values[index] ? values[index].trim() : '';
              });
              if (obj.tradingsymbol === symbol) {
                foundItem = obj;
                break;
              }
            }
            
            if (!foundItem) {
              return res.status(404).json({ error: 'Instrument not found' });
            }
            
            const wsData = [
              ['Field', 'Value'],
              ['Trading Symbol', foundItem.tradingsymbol || 'N/A'],
              ['AMC', foundItem.amc || 'N/A'],
              ['Scheme Name', foundItem.name || 'N/A'],
              ['Purchase Allowed', foundItem.purchase_allowed === '1' ? 'Yes' : 'No'],
              ['Redemption Allowed', foundItem.redemption_allowed === '1' ? 'Yes' : 'No'],
              ['Minimum Purchase Amount', foundItem.minimum_purchase_amount || 'N/A'],
              ['Minimum Additional Purchase', foundItem.minimum_additional_purchase_amount || 'N/A'],
              ['Minimum Redemption Quantity', foundItem.minimum_redemption_quantity || 'N/A'],
              ['Dividend Type', foundItem.dividend_type || 'N/A'],
              ['Scheme Type', foundItem.scheme_type || 'N/A'],
              ['Plan', foundItem.plan || 'N/A'],
              ['Settlement Type', foundItem.settlement_type || 'N/A'],
              ['NAV (₹)', foundItem.last_price || 'N/A'],
              ['NAV Date', foundItem.last_price_date || 'N/A']
            ];
            
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.aoa_to_sheet(wsData);
            ws['!cols'] = [{ wch: 30 }, { wch: 50 }];
            XLSX.utils.book_append_sheet(wb, ws, 'Instrument');
            
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', `attachment; filename="Zerodha_${symbol}.xlsx"`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buf);
            
          } else {
            try {
              const jsonData = JSON.parse(data);
              const item = jsonData.find(d => (d.tradingsymbol || '') === symbol);
              if (!item) {
                return res.status(404).json({ error: 'Instrument not found' });
              }
              
              const wsData = [
                ['Field', 'Value'],
                ['Trading Symbol', item.tradingsymbol || 'N/A'],
                ['AMC', item.amc || 'N/A'],
                ['Scheme Name', item.name || 'N/A'],
                ['NAV (₹)', item.last_price || 'N/A'],
                ['NAV Date', item.last_price_date || 'N/A'],
                ['Scheme Type', item.scheme_type || 'N/A'],
                ['Plan', item.plan || 'N/A'],
                ['Dividend Type', item.dividend_type || 'N/A']
              ];
              
              const wb = XLSX.utils.book_new();
              const ws = XLSX.utils.aoa_to_sheet(wsData);
              ws['!cols'] = [{ wch: 30 }, { wch: 50 }];
              XLSX.utils.book_append_sheet(wb, ws, 'Instrument');
              
              const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
              res.setHeader('Content-Disposition', `attachment; filename="Zerodha_${symbol}.xlsx"`);
              res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
              res.send(buf);
              
            } catch (e) {
              res.status(500).json({ error: 'Failed to parse response' });
            }
          }
        } catch (error) {
          console.error('Export error:', error);
          res.status(500).json({ error: 'Failed to export instrument data' });
        }
      });
    });
    
    request.on('error', (error) => {
      console.error('Export fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch instrument data' });
    });
    request.end();
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─── VANGUARD ENDPOINTS ──────────────────────────────────

// Helper function to safely parse Vanguard CSV
function parseVanguardCSV(csvData) {
  try {
    // Handle BOM and split lines
    const lines = csvData.replace(/^\uFEFF/, '').split('\n').filter(line => line.trim() && !line.startsWith('*'));
    if (lines.length < 2) return [];
    
    const result = [];
    let headers = [];
    let dataStartIndex = 0;
    
    // Find the header row - look for "Fund name" and "Symbol"
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i];
      if (line.includes('Fund name') && line.includes('Symbol')) {
        headers = line.split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
        dataStartIndex = i + 1;
        break;
      }
    }
    
    // If headers not found, use first row
    if (headers.length === 0) {
      headers = lines[0].split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
      dataStartIndex = 1;
    }
    
    // Parse each row
    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('*') || line.trim() === '' || line.split(',').filter(c => c.trim()).length === 0) {
        continue;
      }
      
      // Parse CSV with quoted fields properly
      const values = [];
      let current = '';
      let inQuotes = false;
      
      for (let char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      
      const obj = {};
      headers.forEach((header, index) => {
        let value = values[index] || '';
        // Remove quotes
        value = value.replace(/^"/, '').replace(/"$/, '');
        
        // Clean header name for consistent keys
        let cleanHeader = header.trim();
        cleanHeader = cleanHeader.replace(/\*/g, '').trim();
        
        // Map common variations
        if (cleanHeader.includes('YTD')) cleanHeader = 'YTD';
        else if (cleanHeader.includes('1 year') || cleanHeader === '1Y') cleanHeader = '1Y';
        else if (cleanHeader.includes('3 year') || cleanHeader === '3Y') cleanHeader = '3Y';
        else if (cleanHeader.includes('5 year') || cleanHeader === '5Y') cleanHeader = '5Y';
        else if (cleanHeader.includes('10 year') || cleanHeader === '10Y') cleanHeader = '10Y';
        else if (cleanHeader.includes('Since inception') || cleanHeader === 'Since Inception') cleanHeader = 'Since Inception';
        else if (cleanHeader.includes('Expense ratio') || cleanHeader === 'Expense Ratio') cleanHeader = 'Expense Ratio';
        else if (cleanHeader.includes('SEC yield') || cleanHeader === 'SEC Yield') cleanHeader = 'SEC Yield';
        else if (cleanHeader === 'Distribution') cleanHeader = 'Distribution';
        else if (cleanHeader === 'Dividend') cleanHeader = 'Dividend';
        else if (cleanHeader === 'Benchmark') cleanHeader = 'Benchmark';
        else if (cleanHeader === 'Fund name') cleanHeader = 'Fund name';
        else if (cleanHeader === 'Symbol') cleanHeader = 'Symbol';
        
        // Clean numeric values
        if (cleanHeader !== 'Fund name' && cleanHeader !== 'Symbol' && 
            cleanHeader !== 'Benchmark' && cleanHeader !== 'Distribution' && 
            cleanHeader !== 'Dividend' && cleanHeader !== 'SEC Yield') {
          value = value.replace(/%/g, '').replace(/[A-Za-z]$/, '').trim();
        }
        
        obj[cleanHeader] = value;
      });
      
      if (obj.Symbol && obj.Symbol !== '' && obj.Symbol !== 'Symbol' &&
          obj['Fund name'] && obj['Fund name'] !== '' && obj['Fund name'] !== 'Fund name') {
        result.push(obj);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error parsing Vanguard CSV:', error);
    return [];
  }
}

// Get Vanguard data from CSV file
router.get('/vanguard/funds', (req, res) => {
  try {
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../Vanguard Mutual funds.csv'),
      path.join(__dirname, 'Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../data/Vanguard_Mutual_Funds.csv')
    ];
    
    let csvFilePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        csvFilePath = p;
        break;
      }
    }
    
    if (!csvFilePath) {
      return res.status(404).json({ 
        error: 'Vanguard data file not found. Please place the CSV file in the data directory or root folder.',
        checkedPaths: possiblePaths
      });
    }
    
    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    const parsedData = parseVanguardCSV(csvData);
    
    if (parsedData.length === 0) {
      return res.status(404).json({ 
        error: 'No valid Vanguard data found in file',
        filePath: csvFilePath
      });
    }
    
    res.json(parsedData);
    
  } catch (error) {
    console.error('Error reading Vanguard data:', error);
    res.status(500).json({ 
      error: 'Failed to load Vanguard data',
      message: error.message 
    });
  }
});

// Get a specific Vanguard fund by symbol
router.get('/vanguard/fund/:symbol', (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv')
    ];
    
    let csvFilePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        csvFilePath = p;
        break;
      }
    }
    
    if (!csvFilePath) {
      return res.status(404).json({ error: 'Vanguard data file not found' });
    }
    
    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    const parsedData = parseVanguardCSV(csvData);
    
    const fund = parsedData.find(f => f.Symbol && f.Symbol.toUpperCase() === symbol);
    
    if (!fund) {
      return res.status(404).json({ error: `Fund with symbol ${symbol} not found` });
    }
    
    res.json(fund);
    
  } catch (error) {
    console.error('Error fetching Vanguard fund:', error);
    res.status(500).json({ 
      error: 'Failed to fetch fund data',
      message: error.message 
    });
  }
});

// Search Vanguard funds by name or symbol
router.get('/vanguard/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv')
    ];
    
    let csvFilePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        csvFilePath = p;
        break;
      }
    }
    
    if (!csvFilePath) {
      return res.status(404).json({ error: 'Vanguard data file not found' });
    }
    
    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    const parsedData = parseVanguardCSV(csvData);
    
    const searchTerm = q.toLowerCase();
    const results = parsedData.filter(fund => {
      const name = (fund['Fund name'] || '').toLowerCase();
      const symbol = (fund.Symbol || '').toLowerCase();
      return name.includes(searchTerm) || symbol.includes(searchTerm);
    });
    
    res.json(results);
    
  } catch (error) {
    console.error('Error searching Vanguard funds:', error);
    res.status(500).json({ 
      error: 'Failed to search funds',
      message: error.message 
    });
  }
});

// Export individual Vanguard fund as Excel
router.get('/vanguard/export/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv')
    ];
    
    let csvFilePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        csvFilePath = p;
        break;
      }
    }
    
    if (!csvFilePath) {
      return res.status(404).json({ error: 'Vanguard data file not found' });
    }
    
    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    const parsedData = parseVanguardCSV(csvData);
    
    const fund = parsedData.find(f => f.Symbol && f.Symbol.toUpperCase() === symbol);
    
    if (!fund) {
      return res.status(404).json({ error: `Fund with symbol ${symbol} not found` });
    }
    
    const wsData = [
      ['Field', 'Value'],
      ['Symbol', fund.Symbol || 'N/A'],
      ['Fund Name', fund['Fund name'] || 'N/A'],
      ['YTD %', fund.YTD || 'N/A'],
      ['1 Year %', fund['1Y'] || 'N/A'],
      ['3 Year %', fund['3Y'] || 'N/A'],
      ['5 Year %', fund['5Y'] || 'N/A'],
      ['10 Year %', fund['10Y'] || 'N/A'],
      ['Since Inception %', fund['Since Inception'] || 'N/A'],
      ['Expense Ratio %', fund['Expense Ratio'] || 'N/A'],
      ['SEC Yield', fund['SEC Yield'] || 'N/A'],
      ['Distribution', fund.Distribution || 'N/A'],
      ['Dividend', fund.Dividend || 'N/A'],
      ['Benchmark', fund.Benchmark || 'N/A']
    ];
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 25 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Fund Details');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Vanguard_${fund.Symbol}_${new Date().toISOString().slice(0,10)}.xlsx`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    
  } catch (error) {
    console.error('Export Vanguard fund error:', error);
    res.status(500).json({ error: 'Failed to export fund data' });
  }
});

// Export all Vanguard funds as Excel
router.get('/vanguard/export-all', (req, res) => {
  try {
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv')
    ];
    
    let csvFilePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        csvFilePath = p;
        break;
      }
    }
    
    if (!csvFilePath) {
      return res.status(404).json({ error: 'Vanguard data file not found' });
    }
    
    const csvData = fs.readFileSync(csvFilePath, 'utf8');
    const parsedData = parseVanguardCSV(csvData);
    
    if (parsedData.length === 0) {
      return res.status(404).json({ error: 'No Vanguard data available' });
    }
    
    const wsData = [
      ['Symbol', 'Fund Name', 'YTD %', '1Y %', '3Y %', '5Y %', '10Y %', 
       'Since Inception %', 'Expense Ratio', 'SEC Yield', 'Distribution', 
       'Dividend', 'Benchmark']
    ];
    
    parsedData.forEach(fund => {
      wsData.push([
        fund.Symbol || 'N/A',
        fund['Fund name'] || 'N/A',
        fund.YTD || 'N/A',
        fund['1Y'] || 'N/A',
        fund['3Y'] || 'N/A',
        fund['5Y'] || 'N/A',
        fund['10Y'] || 'N/A',
        fund['Since Inception'] || 'N/A',
        fund['Expense Ratio'] || 'N/A',
        fund['SEC Yield'] || 'N/A',
        fund.Distribution || 'N/A',
        fund.Dividend || 'N/A',
        fund.Benchmark || 'N/A'
      ]);
    });
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 12 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
      { wch: 15 }, { wch: 12 }, { wch: 40 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Vanguard Funds');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `Vanguard_Funds_${timestamp}.xlsx`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
    
  } catch (error) {
    console.error('Export Vanguard error:', error);
    res.status(500).json({ 
      error: 'Failed to export Vanguard data',
      message: error.message 
    });
  }
});

// Check if Vanguard data exists
router.get('/vanguard/status', (req, res) => {
  try {
    const possiblePaths = [
      path.join(__dirname, '../../Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard Mutual funds.csv'),
      path.join(__dirname, '../../data/Vanguard_Mutual_Funds.csv'),
      path.join(__dirname, '../data/Vanguard Mutual funds.csv')
    ];
    
    let exists = false;
    let foundPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        exists = true;
        foundPath = p;
        break;
      }
    }
    
    let count = 0;
    if (exists) {
      try {
        const csvData = fs.readFileSync(foundPath, 'utf8');
        const parsedData = parseVanguardCSV(csvData);
        count = parsedData.length;
      } catch (e) {
        console.error('Error reading Vanguard file for status:', e);
      }
    }
    
    res.json({ 
      exists, 
      filePath: foundPath,
      count: count,
      message: exists ? `Vanguard data available (${count} funds)` : 'Vanguard data file not found. Please upload the CSV file to the data directory.'
    });
    
  } catch (error) {
    console.error('Error checking Vanguard status:', error);
    res.json({ 
      exists: false, 
      message: 'Error checking Vanguard data',
      error: error.message
    });
  }
});

// ── Statistics endpoint ──────────────────────────────────
router.get('/stats', (req, res) => res.json({
  totalFunds: Object.keys(navData).length,
  totalSchemes: allSchemes.length
}));

module.exports = router;
