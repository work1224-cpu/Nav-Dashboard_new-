const https = require('https');

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Live NAV fetch ──────────────────────────────────────
function fetchLiveNAV(code) {
  return new Promise((resolve) => {
    https.get(`https://api.mfapi.in/mf/${code}/latest`, { headers: REQUEST_HEADERS }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status === 'SUCCESS' && j.data?.[0])
            resolve({ code, nav: j.data[0].nav, date: j.data[0].date, live: true });
          else resolve({ code, nav: null, date: null, live: false });
        } catch { resolve({ code, nav: null, date: null, live: false }); }
      });
    }).on('error', () => resolve({ code, nav: null, date: null, live: false }));
  });
}

// ── Full NAV history fetch (with a couple of quick retries — mfapi.in
//    occasionally hiccups on individual requests, especially under load) ──
function fetchSchemeHistoryOnce(code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.mfapi.in/mf/${code}`, { headers: REQUEST_HEADERS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume(); // drain so the socket can be reused
        return reject(new Error(`mfapi.in returned HTTP ${res.statusCode} for scheme ${code}`));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status === 'SUCCESS' && Array.isArray(j.data) && j.data.length > 0) {
            resolve({ meta: j.meta || {}, data: j.data });
          } else {
            reject(new Error('No history data available for this scheme'));
          }
        } catch (e) {
          reject(new Error(`Unexpected response from mfapi.in (not JSON) — the API may be rate-limiting or unreachable: ${e.message}`));
        }
      });
    }).on('error', (e) => reject(new Error(`Network error reaching mfapi.in: ${e.message}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request to mfapi.in timed out')));
  });
}

async function fetchSchemeHistory(code, timeoutMs = 20000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchSchemeHistoryOnce(code, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1)); // small backoff
    }
  }
  throw lastErr;
}

// mfapi.in dates come as "DD-MM-YYYY"
function parseMfapiDate(str) {
  const [d, m, y] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function prepareHistory(historyData) {
  const sortedDesc = historyData
    .map(entry => ({ entry, timestamp: parseMfapiDate(entry.date).getTime() }))
    .sort((a, b) => b.timestamp - a.timestamp);
  const sortedAsc = [...sortedDesc].reverse();
  const monthlyPoints = [];
  const months = new Set();

  for (const item of sortedAsc) {
    const date = new Date(item.timestamp);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (!months.has(key)) {
      months.add(key);
      monthlyPoints.push(item);
    }
  }

  return { sortedDesc, sortedAsc, monthlyPoints };
}

function findPreparedOnOrBefore(sortedDesc, timestamp) {
  let low = 0;
  let high = sortedDesc.length - 1;
  let result = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedDesc[middle].timestamp <= timestamp) {
      result = sortedDesc[middle];
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

function findPreparedOnOrAfter(sortedDesc, timestamp) {
  let low = 0;
  let high = sortedDesc.length - 1;
  let result = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedDesc[middle].timestamp >= timestamp) {
      result = sortedDesc[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

const SHORT_RETURN_MONTHS = [1, 3, 5, 7, 10];

function getAvailablePeriodsFromPrepared(prepared) {
  const latestDate = prepared.sortedDesc[0].timestamp;
  const earliestDate = prepared.sortedDesc[prepared.sortedDesc.length - 1].timestamp;
  const totalSpanYears = (latestDate - earliestDate) / (1000 * 60 * 60 * 24 * 365.25);
  const maxYears = Math.floor(totalSpanYears);
  const periods = SHORT_RETURN_MONTHS
    .filter(months => totalSpanYears >= months / 12)
    .map(months => ({ months, label: `${months}M` }));

  for (let years = 1; years <= maxYears; years++) {
    periods.push({ months: years * 12, years, label: `${years}Y` });
  }
  return periods;
}

// Every whole year the scheme's history actually spans: 1Y, 2Y, 3Y … up to
// however many full years of NAV data exist (kept for API compatibility).
function getAvailableYearPeriods(historyData) {
  const prepared = prepareHistory(historyData);
  return getAvailablePeriodsFromPrepared(prepared)
    .filter(period => period.years)
    .map(period => period.years);
}

// A modest — even slightly bad — data point compounded ("annualized") over
// a SHORT window explodes: a single 1-month NAV glitch that's 6x too high
// (a decimal-place error, a bad mfapi.in data point, etc.) turns into a
// billions-of-percent "return" once raised to the 12th power to annualize
// it. Real return-disclosure convention (SEBI/AMFI) reflects this: periods
// under 1 year are shown as the plain (simple) change over that period,
// NOT compounded/annualized into a yearly rate. Only periods of 1 year or
// longer get the CAGR treatment. Used everywhere a period return or a
// rolling-window return is computed, so a bad data point stays a
// plausible-looking (if wrong) number instead of an absurd one.
function periodReturnPct(startNav, endNav, years) {
  const simplePct = ((endNav - startNav) / startNav) * 100;
  if (!(years >= 1)) return simplePct;
  return (Math.pow(endNav / startNav, 1 / years) - 1) * 100;
}

function calculateReturns(historyData) {
  const prepared = prepareHistory(historyData);
  const latestItem = prepared.sortedDesc[0];
  const latest = latestItem.entry;
  const latestDate = latestItem.timestamp;
  const latestNav = parseFloat(latest.nav);

  const periods = getAvailablePeriodsFromPrepared(prepared);
  const returns = periods.map(period => {
    const targetDate = new Date(latestDate);
    targetDate.setMonth(targetDate.getMonth() - period.months);
    const targetTimestamp = targetDate.getTime();

    // Find the closest available NAV on or before the target date.
    const match = findPreparedOnOrBefore(prepared.sortedDesc, targetTimestamp);

    if (!match) return { ...period, available: false };

    const matchDate = match.timestamp;
    const matchNav = parseFloat(match.entry.nav);
    if (!matchNav) return { ...period, available: false };

    const actualDays = (latestDate - matchDate) / (1000 * 60 * 60 * 24);
    const actualYears = actualDays / 365.25;

    const simpleReturnPct = ((latestNav - matchNav) / matchNav) * 100;
    const cagrPct = actualYears > 0 ? periodReturnPct(matchNav, latestNav, actualYears) : simpleReturnPct;

    return {
      ...period,
      available: true,
      fromDate: match.entry.date,
      fromNav: matchNav,
      simpleReturnPct: Number(simpleReturnPct.toFixed(2)),
      cagrPct: Number(cagrPct.toFixed(2))
    };
  });

  return { latestNav, latestDate: latest.date, returns };
}

// ── Custom date-range return calculation ──────────────
function findNavOnOrBefore(sortedDesc, date) {
  for (const entry of sortedDesc) {
    if (parseMfapiDate(entry.date) <= date) return entry;
  }
  return null;
}

function findNavOnOrAfter(sortedDesc, date) {
  let match = null;
  for (let i = sortedDesc.length - 1; i >= 0; i--) {
    if (parseMfapiDate(sortedDesc[i].date) >= date) { match = sortedDesc[i]; break; }
  }
  return match;
}

function calculateCustomReturn(historyData, fromDateStr, toDateStr) {
  const sorted = [...historyData].sort((a, b) => parseMfapiDate(b.date) - parseMfapiDate(a.date));

  const fromDate = new Date(fromDateStr);
  const toDate = new Date(toDateStr);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    throw new Error('Invalid date format. Use YYYY-MM-DD.');
  }
  if (fromDate >= toDate) {
    throw new Error('From date must be earlier than To date.');
  }

  // Nearest trading day on/after "from" and on/before "to"
  const fromEntry = findNavOnOrAfter(sorted, fromDate);
  const toEntry = findNavOnOrBefore(sorted, toDate);

  if (!fromEntry || !toEntry) {
    throw new Error('No NAV data available for the selected date range.');
  }

  const fromNav = parseFloat(fromEntry.nav);
  const toNav = parseFloat(toEntry.nav);
  const fromD = parseMfapiDate(fromEntry.date);
  const toD = parseMfapiDate(toEntry.date);

  if (toD <= fromD || !fromNav || !toNav) {
    throw new Error('Not enough NAV data points in the selected date range.');
  }

  const days = (toD - fromD) / (1000 * 60 * 60 * 24);
  const years = days / 365.25;

  const simpleReturnPct = ((toNav - fromNav) / fromNav) * 100;
  const cagrPct = years > 0 ? periodReturnPct(fromNav, toNav, years) : simpleReturnPct;

  return {
    fromRequested: fromDateStr,
    toRequested: toDateStr,
    fromDate: fromEntry.date,
    toDate: toEntry.date,
    fromNav,
    toNav,
    days: Math.round(days),
    years: Number(years.toFixed(2)),
    simpleReturnPct: Number(simpleReturnPct.toFixed(2)),
    cagrPct: Number(cagrPct.toFixed(2))
  };
}

// ── Rolling Returns ────────────────────────────────────
// A rolling N-year return repeats the N-year CAGR calculation for every
// month-start in the scheme's history, giving a distribution (avg/min/max/
// median/% positive) instead of a single point-in-time number.

function getMonthlyDatapoints(sortedAsc) {
  const map = new Map();
  for (const entry of sortedAsc) {
    const d = parseMfapiDate(entry.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!map.has(key)) map.set(key, entry);
  }
  return [...map.values()];
}

function calculateRollingReturnsForPeriod(historyData, period) {
  const resolvedPeriod = typeof period === 'number'
    ? { months: period * 12, years: period, label: `${period}Y` }
    : period;
  return calculateRollingReturnsForPrepared(prepareHistory(historyData), resolvedPeriod);
}

function calculateRollingReturnsForPrepared(prepared, period) {
  const { sortedDesc, monthlyPoints } = prepared;

  const windows = [];
  for (const startItem of monthlyPoints) {
    const startEntry = startItem.entry;
    const startDate = new Date(startItem.timestamp);
    const targetEnd = new Date(startDate);
    targetEnd.setMonth(targetEnd.getMonth() + period.months);
    const targetTimestamp = targetEnd.getTime();

    const endItem = findPreparedOnOrAfter(sortedDesc, targetTimestamp);
    if (!endItem) continue; // window runs past the available history

    const startNav = parseFloat(startEntry.nav);
    const endNav = parseFloat(endItem.entry.nav);
    if (!startNav || !endNav) continue;

    const actualDays = (endItem.timestamp - startItem.timestamp) / (1000 * 60 * 60 * 24);
    const actualYears = actualDays / 365.25;
    if (actualYears <= 0) continue;

    const cagr = periodReturnPct(startNav, endNav, actualYears);
    windows.push({ startDate: startEntry.date, endDate: endItem.entry.date, cagr });
  }

  if (windows.length === 0) {
    return { ...period, available: false, windowCount: 0 };
  }

  const values = windows.map(w => w.cagr).sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = values[0];
  const max = values[values.length - 1];
  const median = values.length % 2 === 0
    ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
    : values[(values.length - 1) / 2];
  const positivePct = (values.filter(v => v > 0).length / values.length) * 100;

  return {
    ...period,
    available: true,
    windowCount: windows.length,
    avgReturn: Number(avg.toFixed(2)),
    minReturn: Number(min.toFixed(2)),
    maxReturn: Number(max.toFixed(2)),
    medianReturn: Number(median.toFixed(2)),
    positivePct: Number(positivePct.toFixed(1))
  };
}

function calculateAllRollingReturns(historyData, periods) {
  const prepared = prepareHistory(historyData);
  const resolvedPeriods = periods || getAvailablePeriodsFromPrepared(prepared);
  return resolvedPeriods.map(period => calculateRollingReturnsForPrepared(prepared,
    typeof period === 'number'
      ? { months: period * 12, years: period, label: `${period}Y` }
      : period));
}

// ── Rolling return for a CUSTOM date range ─────────────
// Takes the exact day-span between the user's chosen from/to dates (same
// nearest-trading-day matching as calculateCustomReturn, so the window
// length matches what's shown just above it) and repeats that same-length
// window over every month-start in the scheme's full history — giving the
// same avg/min/max/median/%positive distribution the fixed-period rolling
// cards show, but for whatever custom span the user picked.
function calculateCustomRollingReturns(historyData, fromDateStr, toDateStr) {
  const custom = calculateCustomReturn(historyData, fromDateStr, toDateStr);
  const spanDays = custom.days;
  const spanMs = spanDays * 24 * 60 * 60 * 1000;

  const prepared = prepareHistory(historyData);
  const { sortedDesc, monthlyPoints } = prepared;

  const windows = [];
  for (const startItem of monthlyPoints) {
    const targetTimestamp = startItem.timestamp + spanMs;
    const endItem = findPreparedOnOrAfter(sortedDesc, targetTimestamp);
    if (!endItem) continue; // window runs past the available history

    const startNav = parseFloat(startItem.entry.nav);
    const endNav = parseFloat(endItem.entry.nav);
    if (!startNav || !endNav) continue;

    const actualDays = (endItem.timestamp - startItem.timestamp) / (1000 * 60 * 60 * 24);
    const actualYears = actualDays / 365.25;
    if (actualYears <= 0) continue;

    const cagr = (Math.pow(endNav / startNav, 1 / actualYears) - 1) * 100;
    windows.push({ startDate: startItem.entry.date, endDate: endItem.entry.date, cagr });
  }

  const spanYears = Number((spanDays / 365.25).toFixed(2));

  if (windows.length === 0) {
    return { spanDays, spanYears, available: false, windowCount: 0 };
  }

  const values = windows.map(w => w.cagr).sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = values[0];
  const max = values[values.length - 1];
  const median = values.length % 2 === 0
    ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
    : values[(values.length - 1) / 2];
  const positivePct = (values.filter(v => v > 0).length / values.length) * 100;

  return {
    spanDays,
    spanYears,
    available: true,
    windowCount: windows.length,
    avgReturn: Number(avg.toFixed(2)),
    minReturn: Number(min.toFixed(2)),
    maxReturn: Number(max.toFixed(2)),
    medianReturn: Number(median.toFixed(2)),
    positivePct: Number(positivePct.toFixed(1))
  };
}

module.exports = {
  fetchLiveNAV,
  fetchSchemeHistory,
  parseMfapiDate,
  getAvailableYearPeriods,
  calculateReturns,
  findNavOnOrBefore,
  findNavOnOrAfter,
  calculateCustomReturn,
  getMonthlyDatapoints,
  calculateRollingReturnsForPeriod,
  calculateAllRollingReturns,
  calculateCustomRollingReturns,
  periodReturnPct
};