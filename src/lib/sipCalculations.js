// ── Return CAGR Rule Engine — SIP & Lumpsum calculations ──────────────
// Everything here works off a scheme's raw mfapi-style NAV history
// ([{date:'DD-MM-YYYY', nav:'123.45'}, …]) and needs no pre-existing
// cache — it's computed on demand for whatever schemes the Rule Engine
// page has filtered down to.

const { parseMfapiDate } = require('./schemeCalculations');

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;

// The fixed "guide column" periods shown across the Rule Engine table.
// Periods under 1 year show a plain (non-annualized) return; 1yr+ periods
// are annualized (CAGR) — matching how trailing-return tables normally work.
const STANDARD_PERIODS = [
  { key: '1d',  label: '1 Day',   ms: 1 * DAY_MS },
  { key: '7d',  label: '7 Day',   ms: 7 * DAY_MS },
  { key: '1m',  label: '1 Month', ms: 30.4368 * DAY_MS },
  { key: '3m',  label: '3 Month', ms: 3 * 30.4368 * DAY_MS },
  { key: '6m',  label: '6 Month', ms: 6 * 30.4368 * DAY_MS },
  { key: '1y',  label: '1 Yr',    ms: 1 * YEAR_MS,  years: 1 },
  { key: '2y',  label: '2 Yr',    ms: 2 * YEAR_MS,  years: 2 },
  { key: '3y',  label: '3 Yr',    ms: 3 * YEAR_MS,  years: 3 },
  { key: '5y',  label: '5 Yr',    ms: 5 * YEAR_MS,  years: 5 },
  { key: '10y', label: '10 Yr',   ms: 10 * YEAR_MS, years: 10 },
  { key: '12y', label: '12 Yr',   ms: 12 * YEAR_MS, years: 12 }
];

// ── History prep + fast lookups ────────────────────────
function prepareSip(historyData) {
  const sortedAsc = historyData
    .map(e => ({ date: e.date, nav: parseFloat(e.nav), ts: parseMfapiDate(e.date).getTime() }))
    .filter(e => Number.isFinite(e.nav) && e.nav > 0 && Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
  return sortedAsc;
}

function findOnOrAfter(sortedAsc, ts) {
  let lo = 0, hi = sortedAsc.length - 1, res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid].ts >= ts) { res = sortedAsc[mid]; hi = mid - 1; }
    else lo = mid + 1;
  }
  return res;
}

function findOnOrBefore(sortedAsc, ts) {
  let lo = 0, hi = sortedAsc.length - 1, res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid].ts <= ts) { res = sortedAsc[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// First trading day of every calendar month — used as rolling-window
// start points, same idea as the scheme-detail page's rolling returns.
function monthlyStartPoints(sortedAsc) {
  const points = [];
  const seen = new Set();
  for (const item of sortedAsc) {
    const d = new Date(item.ts);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!seen.has(key)) { seen.add(key); points.push(item); }
  }
  return points;
}

function summarizeWindows(values) {
  if (values.length === 0) return { available: false, windowCount: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2];
  const positivePct = (sorted.filter(v => v > 0).length / sorted.length) * 100;
  return {
    available: true,
    windowCount: sorted.length,
    avgReturn: Number(avg.toFixed(2)),
    minReturn: Number(min.toFixed(2)),
    maxReturn: Number(max.toFixed(2)),
    medianReturn: Number(median.toFixed(2)),
    positivePct: Number(positivePct.toFixed(1))
  };
}

// ── XIRR (Newton-Raphson) ──────────────────────────────
// cashflows: [{ amount, ts }], negative = money going out (SIP purchase),
// positive = money coming back (current value on the valuation date).
function xirr(cashflows, guess = 0.15) {
  if (cashflows.length < 2) return null;
  const t0 = cashflows[0].ts;
  const yearsOf = cf => (cf.ts - t0) / YEAR_MS;

  const npv = rate => cashflows.reduce((sum, cf) => sum + cf.amount / Math.pow(1 + rate, yearsOf(cf)), 0);
  const dnpv = rate => cashflows.reduce((sum, cf) => {
    const t = yearsOf(cf);
    return t === 0 ? sum : sum - (t * cf.amount) / Math.pow(1 + rate, t + 1);
  }, 0);

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-9) break;
    let next = rate - f / df;
    if (!Number.isFinite(next)) break;
    if (next <= -0.999999) next = -0.999999; // can't go below -100%
    if (Math.abs(next - rate) < 1e-7) { rate = next; break; }
    rate = next;
  }
  if (!Number.isFinite(rate)) return null;
  return rate * 100;
}

// ── Lumpsum: CAGR (or plain return for sub-1yr) ────────
function calcLumpsumForPeriod(sortedAsc, latest, period) {
  if (sortedAsc.length === 0) return { ...basePeriodInfo(period), available: false };

  const targetTs = latest.ts - period.ms;
  const start = findOnOrBefore(sortedAsc, targetTs) || findOnOrAfter(sortedAsc, targetTs);
  if (!start || start.ts >= latest.ts) return { ...basePeriodInfo(period), available: false };

  const years = (latest.ts - start.ts) / YEAR_MS;
  if (years <= 0) return { ...basePeriodInfo(period), available: false };

  const valuePct = period.years
    ? (Math.pow(latest.nav / start.nav, 1 / years) - 1) * 100
    : ((latest.nav / start.nav) - 1) * 100;

  return { ...basePeriodInfo(period), available: true, valuePct: clampPct(valuePct) };
}

function calcLumpsumRollingForPeriod(sortedAsc, period) {
  const values = [];
  for (const sp of monthlyStartPoints(sortedAsc)) {
    const end = findOnOrAfter(sortedAsc, sp.ts + period.ms);
    if (!end) continue;
    const years = (end.ts - sp.ts) / YEAR_MS;
    if (years <= 0) continue;
    const v = period.years
      ? (Math.pow(end.nav / sp.nav, 1 / years) - 1) * 100
      : ((end.nav / sp.nav) - 1) * 100;
    values.push(v);
  }
  return { ...basePeriodInfo(period), ...summarizeWindows(values) };
}

// ── SIP: simulate installments over a window, then XIRR ─
const FREQ_STEP_MONTHS = { Monthly: 1, Weekly: null, Quarterly: 3 };

function nextInstallmentDate(d, frequency) {
  const next = new Date(d.getTime());
  if (frequency === 'Weekly') next.setDate(next.getDate() + 7);
  else if (frequency === 'Quarterly') next.setMonth(next.getMonth() + 3);
  else next.setMonth(next.getMonth() + 1); // Monthly default
  return next;
}

function simulateSIPWindow(sortedAsc, startTs, endPoint, sipAmount, frequency) {
  if (!endPoint || startTs >= endPoint.ts) return null;

  const installmentDates = [];
  let cur = new Date(startTs);
  while (cur.getTime() <= endPoint.ts) {
    installmentDates.push(cur);
    cur = nextInstallmentDate(cur, frequency);
  }
  if (installmentDates.length === 0) installmentDates.push(new Date(startTs));

  let totalUnits = 0;
  const cashflows = [];
  for (const d of installmentDates) {
    const point = findOnOrAfter(sortedAsc, d.getTime()) || findOnOrBefore(sortedAsc, d.getTime());
    if (!point || point.ts > endPoint.ts) continue;
    const units = sipAmount / point.nav;
    totalUnits += units;
    cashflows.push({ amount: -sipAmount, ts: point.ts });
  }
  if (cashflows.length === 0 || totalUnits <= 0) return null;

  const currentValue = totalUnits * endPoint.nav;
  cashflows.push({ amount: currentValue, ts: endPoint.ts });
  cashflows.sort((a, b) => a.ts - b.ts);

  if (cashflows.length < 2) return null;

  const rate = xirr(cashflows);
  if (rate === null) return null;

  return {
    valuePct: clampPct(rate),
    installments: cashflows.length - 1,
    totalInvested: Number((sipAmount * (cashflows.length - 1)).toFixed(2)),
    currentValue: Number(currentValue.toFixed(2))
  };
}

function calcSIPForPeriod(sortedAsc, latest, period, sipAmount, frequency) {
  if (sortedAsc.length === 0 || sortedAsc[0].ts > latest.ts - period.ms) {
    return { ...basePeriodInfo(period), available: false };
  }
  const startTs = latest.ts - period.ms;
  const result = simulateSIPWindow(sortedAsc, startTs, latest, sipAmount, frequency);
  if (!result) return { ...basePeriodInfo(period), available: false };
  return { ...basePeriodInfo(period), available: true, ...result };
}

function calcSIPRollingForPeriod(sortedAsc, period, sipAmount, frequency) {
  const values = [];
  for (const sp of monthlyStartPoints(sortedAsc)) {
    const endPoint = findOnOrAfter(sortedAsc, sp.ts + period.ms);
    if (!endPoint) continue;
    const result = simulateSIPWindow(sortedAsc, sp.ts, endPoint, sipAmount, frequency);
    if (result) values.push(result.valuePct);
  }
  return { ...basePeriodInfo(period), ...summarizeWindows(values) };
}

// ── Public: compute everything for one scheme ──────────
function calculateSchemeRuleEngineData(historyData, opts) {
  const { sipAmount = 5000, sipFrequency = 'Monthly', lumpsumAmount = 50000 } = opts || {};
  const sortedAsc = prepareSip(historyData);
  if (sortedAsc.length === 0) {
    return { available: false, lumpsum: [], sip: [], lumpsumRolling: [], sipRolling: [] };
  }
  const latest = sortedAsc[sortedAsc.length - 1];

  const lumpsum = STANDARD_PERIODS.map(p => calcLumpsumForPeriod(sortedAsc, latest, p));
  const sip = STANDARD_PERIODS.map(p => calcSIPForPeriod(sortedAsc, latest, p, sipAmount, sipFrequency));
  const lumpsumRolling = STANDARD_PERIODS.map(p => calcLumpsumRollingForPeriod(sortedAsc, p));
  const sipRolling = STANDARD_PERIODS.map(p => calcSIPRollingForPeriod(sortedAsc, p, sipAmount, sipFrequency));

  return {
    available: true,
    latestNav: latest.nav,
    latestDate: latest.date,
    lumpsum, sip, lumpsumRolling, sipRolling
  };
}

function basePeriodInfo(period) {
  return { key: period.key, label: period.label };
}

function clampPct(v) {
  if (!Number.isFinite(v)) return 0;
  return Number(Math.max(-99.99, Math.min(9999.99, v)).toFixed(2));
}

module.exports = {
  STANDARD_PERIODS,
  calculateSchemeRuleEngineData,
  xirr
};
