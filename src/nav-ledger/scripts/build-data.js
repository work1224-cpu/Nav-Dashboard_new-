// Builds the dashboard dataset from MFAPI's scheme catalogue and histories.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MFAPI_URL = 'https://api.mfapi.in/mf';
const EXTRA_DIR = path.join(__dirname, '..', 'raw_data_extra');

const YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

function isRegularGrowth(schemeName) {
  return parseSchemePlan(schemeName) === 'Regular' && parseSchemeOption(schemeName) === 'Growth';
}

// Classifies a scheme's investor Plan from its name, matching the standard
// AMFI-style buckets: Direct, Regular, Retail, or Other (when the name
// doesn't clearly state a plan).
function parseSchemePlan(schemeName) {
  const name = String(schemeName || '').toLowerCase();
  if (/\bdirect\b/.test(name)) return 'Direct';
  if (/\bregular\b/.test(name)) return 'Regular';
  if (/\bretail\b/.test(name)) return 'Retail';
  return 'Other';
}

// Classifies a scheme's payout Option from its name, matching the standard
// AMFI-style buckets used across mutual fund platforms: the IDCW payout
// frequency when stated (Daily/Weekly/Monthly/Quarterly/Annual/Flexi IDCW),
// a generic IDCW/Dividend when no frequency is stated, Bonus, Growth, or
// Other when nothing matches.

function parseSchemeOption(schemeName) {
  const name = String(schemeName || '').toLowerCase();
  const isPayout = /idcw|dividend/.test(name);
  if (isPayout && /\bflexi\b/.test(name)) return 'Flexi IDCW';
  if (isPayout && /\bdaily\b/.test(name)) return 'Daily IDCW';
  if (isPayout && /\bweekly\b/.test(name)) return 'Weekly IDCW';
  if (isPayout && /\bmonthly\b/.test(name)) return 'Monthly IDCW';
  if (isPayout && /\bquarterly\b/.test(name)) return 'Quarterly IDCW';
  if (isPayout && /\b(annual|yearly)\b/.test(name)) return 'Annual IDCW';
  if (isPayout) return 'IDCW';
  if (/\bbonus\b/.test(name)) return 'Bonus';
  if (/\bgrowth\b/.test(name)) return 'Growth';
  return 'Other';
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function familyName(value) {
  return normalize(value).replace(/\b(reg|regular|growth|plan|option|options|direct|idcw|dividend|payout|reinvestment)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function metadataFromAmfi(text) {
  const byCode = new Map();
  let amc = null;
  let schemeType = null;
  let schemeCategory = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (!value.includes(';')) {
      if (/schemes\s*\(/i.test(value)) {
        const match = value.match(/^(.*?)\s*Schemes\s*\((.*)\)/i);
        schemeType = match ? match[1].trim().replace(/^open$/i, 'Open Ended') : null;
        schemeCategory = match ? match[2].trim() : null;
      } else if (!/^scheme code/i.test(value)) amc = value;
      continue;
    }
    const parts = value.split(';');
    if (parts.length < 6 || !/^\d+$/.test(parts[0].trim())) continue;
    byCode.set(parts[0].trim(), { amc, schemeType, schemeCategory });
  }
  return byCode;
}

function readEnrichment() {
  const metadata = { byCode: new Map(), byName: new Map(), byAgency: new Map() };
  const launchPath = path.join(EXTRA_DIR, 'AS_ON_17-Jul-2026.xlsx');
  if (fs.existsSync(launchPath)) {
    const workbook = XLSX.readFile(launchPath, { cellDates: true });
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
      for (const row of rows.slice(5)) {
        if (row[0] && row[2] instanceof Date) metadata.byName.set(`launch:${familyName(row[0])}`, row[2]);
      }
    }
  }
  const terPath = path.join(EXTRA_DIR, 'TER_of_MF_Schemes.xlsx.xlsx');
  if (fs.existsSync(terPath)) {
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(terPath).Sheets.TER_Revised, { defval: null });
    for (const row of rows) {
      const code = row['NSDL Scheme Code'];
      const name = row['Scheme Name'];
      if (code && name && !metadata.byName.has(`ter:${familyName(name)}`)) {
        metadata.byName.set(`ter:${familyName(name)}`, {
          nsdlCode: String(code), schemeType: row['Scheme Type'], schemeCategory: row['Scheme Category']
        });
      }
    }
  }
  const contactsPath = path.join(EXTRA_DIR, 'CONTACT_NUMBERS-ALL_AGENCY.xlsx');
  if (fs.existsSync(contactsPath)) {
    const workbook = XLSX.readFile(contactsPath);
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
      for (const row of rows.slice(1)) {
        if (!row[0]) continue;
        const pairs = [];
        for (let i = 1; i < row.length; i += 2) if (row[i] != null) pairs.push(row[i + 1] != null ? `${row[i]}: ${row[i + 1]}` : String(row[i]));
        if (pairs.length) metadata.byAgency.set(normalize(row[0]), pairs.join(', '));
      }
    }
  }
  return metadata;
}

function dateText(date) {
  if (!(date instanceof Date)) return null;
  return `${String(date.getDate()).padStart(2, '0')}-${date.toLocaleString('en-US', { month: 'short' })}-${date.getFullYear()}`;
}

function valueOnMarch31(data, year) {
  const target = `31-03-${year}`;
  const exact = data.find((row) => row.date === target);
  if (exact) return Number(exact.nav);
  const prior = data.find((row) => {
    const [day, month, rowYear] = String(row.date).split('-').map(Number);
    return rowYear === year && month === 3 && day < 31;
  });
  return prior ? Number(prior.nav) : null;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Reads master.json's top-level array without ever holding the whole file
// as one JS string (it can exceed 600MB, past V8's max string length) —
// same streaming-parse technique the live server uses, needed here too so
// an incremental sync can load the PREVIOUS build to decide what's already
// current, without crashing on a large file.
function readJsonArrayFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const records = [];
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let pending = '', record = '', depth = 0, inString = false, escaped = false;
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += buffer.toString('utf8', 0, bytesRead);
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const char = pending[i];
        if (depth === 0) { if (char === '{') { depth = 1; record = '{'; start = i + 1; } continue; }
        record += char;
        if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; }
        else if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') { depth--; if (depth === 0) { records.push(JSON.parse(record)); record = ''; start = i + 1; } }
      }
      pending = depth > 0 ? '' : pending.slice(start);
    }
  } finally { fs.closeSync(fd); }
  return records;
}

// A scheme's data is "fresh" if its last known NAV is within STALE_DAYS of
// today — 3 days comfortably covers weekends/holidays where AMFI doesn't
// publish a new NAV, without letting a scheme silently go stale for weeks.
const STALE_DAYS = 3;
function isFresh(record, now) {
  if (!record || !record.latestNavDate) return false;
  const [day, month, year] = String(record.latestNavDate).split('-').map(Number);
  if (!day || !month || !year) return false;
  const navDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(navDate.getTime())) return false;
  return (now - navDate) / 86400000 <= STALE_DAYS;
}

// Loads whatever the previous build produced (if any) so a re-sync can
// SKIP re-downloading a scheme's entire history from MFAPI when we already
// have it fresh — this is what makes repeat syncs fast: the very first
// build still has to fetch everything, but every sync after that only
// fetches the schemes that are actually new or stale (usually a small
// fraction of the ~38,000 total), instead of re-fetching all of them from
// scratch every single time.
function loadExistingMaster() {
  const masterPath = path.join(DATA_DIR, 'master.json');
  if (!fs.existsSync(masterPath)) return new Map();
  console.log('Loading previous master.json to enable an incremental sync...');
  const started = Date.now();
  let records;
  try {
    records = readJsonArrayFile(masterPath);
  } catch (error) {
    console.warn(`Could not read previous master.json (${error.message}) — doing a full sync instead.`);
    return new Map();
  }
  const map = new Map(records.map((r) => [String(r.schemeCode), r]));
  console.log(`Loaded ${map.size} previous records in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  return map;
}

async function fetchHistoryOnce(scheme) {
  const response = await axios.get(`${MFAPI_URL}/${scheme.schemeCode}`, { timeout: 30000 });
  const data = Array.isArray(response.data?.data) ? response.data.data : [];
  if (!data.length) throw new Error('No history data returned');
  const navByYear = {};
  for (const year of YEARS) {
    const nav = valueOnMarch31(data, year);
    if (nav != null && Number.isFinite(nav) && nav > 0) navByYear[year] = nav;
  }
  const latest = data[0];
  // Keep daily NAV points for the engine's 1D–12Y calculations. MFAPI gives
  // newest first; save a compact, chronological series covering ~12 years.
  // Stored as [date, nav] pairs rather than {d, n} objects — for tens of
  // thousands of schemes this roughly halves master.json's size and the
  // memory needed to serialize it, which is what was crashing the build.
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 13);
  const navHistory = data.map((row) => {
    const [day, month, year] = String(row.date).split('-').map(Number);
    return [`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, Number(row.nav)];
  }).filter((row) => row[1] > 0 && new Date(`${row[0]}T00:00:00Z`) >= cutoff).reverse();
  return { navByYear, navHistory, latestNav: latest ? Number(latest.nav) : null, latestNavDate: latest?.date || null };
}

// mfapi.in occasionally hiccups on an individual request (timeout, empty
// body, brief rate-limit) even though the scheme itself is fine — retrying
// a couple of times recovers most of those instead of silently dropping
// the scheme from the dataset.
async function fetchHistory(scheme, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchHistoryOnce(scheme);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function build() {
  const catalogueResponse = await axios.get(`${MFAPI_URL}/`, { timeout: 30000 });
  const catalogue = Array.isArray(catalogueResponse.data) ? catalogueResponse.data : [];
  let amfiByCode = new Map();
  try {
    const amfiResponse = await axios.get('https://portal.amfiindia.com/spages/NAVAll.txt', { timeout: 30000 });
    amfiByCode = metadataFromAmfi(amfiResponse.data);
  } catch (error) {
    console.warn(`AMFI metadata unavailable: ${error.message}`);
  }
  // Keep the complete MFAPI catalogue. AMFI metadata enriches records when
  // available, but it must not decide which schemes are imported: NAVAll.txt
  // omits historical, closed, and otherwise non-quoting schemes that still
  // exist in MFAPI and are required for a complete AMC/scheme view.
  const schemes = catalogue;
  const enrichment = readEnrichment();
  const existingByCode = loadExistingMaster();
  const now = new Date();
  console.log(`MFAPI catalogue: ${catalogue.length} schemes selected (all AMCs, plans & options).`);

  function buildRecord(scheme, { navByYear, navHistory, latestNav, latestNavDate }) {
    const yearsWithData = YEARS.filter((y) => navByYear[y] != null);
    const firstYear = yearsWithData[0] || null;
    const lastYear = yearsWithData[yearsWithData.length - 1] || null;

    let cagr = null;
    let absoluteGrowthPct = null;
    if (firstYear && lastYear && firstYear !== lastYear) {
      const startNav = navByYear[firstYear];
      const endNav = navByYear[lastYear];
      const numYears = lastYear - firstYear;
      if (startNav > 0) {
        absoluteGrowthPct = ((endNav - startNav) / startNav) * 100;
        cagr = (Math.pow(endNav / startNav, 1 / numYears) - 1) * 100;
      }
    }

    const yoy = {};
    const cagrByYear = {};
    const rollingReturnsByYear = {};
    for (let i = 1; i < YEARS.length; i++) {
      const y0 = YEARS[i - 1];
      const y1 = YEARS[i];
      const v0 = navByYear[y0];
      const v1 = navByYear[y1];
      if (v0 != null && v1 != null && v0 > 0) {
        yoy[y1] = ((v1 - v0) / v0) * 100;
        rollingReturnsByYear[y1] = yoy[y1];
      }
      const baseNav = navByYear[firstYear];
      const yearNav = navByYear[y1];
      if (baseNav > 0 && yearNav > 0 && firstYear < y1) {
        cagrByYear[y1] = (Math.pow(yearNav / baseNav, 1 / (y1 - firstYear)) - 1) * 100;
      }
    }

    return {
      amc: amfiByCode.get(String(scheme.schemeCode))?.amc || null,
      group: null,
      schemeName: scheme.schemeName,
      navByYear,
      navHistory,
      firstYear,
      lastYear,
      cagr,
      absoluteGrowthPct,
      yoy,
      cagrByYear,
      rollingReturnsByYear,
      latestNav,
      latestNavDate,
      schemeCode: String(scheme.schemeCode),
      nsdlCode: (() => {
        const key = familyName(scheme.schemeName);
        const exact = enrichment.byName.get(`ter:${key}`);
        if (exact) return exact.nsdlCode;
        const hit = [...enrichment.byName.entries()].find(([name]) => name.startsWith('ter:') && (key.includes(name.slice(4)) || name.slice(4).includes(key)));
        return hit ? hit[1].nsdlCode : null;
      })(),
      dateOfLaunch: dateText(enrichment.byName.get(`launch:${familyName(scheme.schemeName)}`)),
      fundManagerDetails: (() => {
        const agency = [...enrichment.byAgency.entries()].find(([name]) => {
          const amc = amfiByCode.get(String(scheme.schemeCode))?.amc;
          return amc && (name.includes(normalize(amc)) || normalize(amc).includes(name));
        });
        return agency ? agency[1] : null;
      })(),
      schemeType: amfiByCode.get(String(scheme.schemeCode))?.schemeType || null,
      schemeCategory: amfiByCode.get(String(scheme.schemeCode))?.schemeCategory || null,
      schemePlan: parseSchemePlan(scheme.schemeName),
      schemeOption: parseSchemeOption(scheme.schemeName)
    };
  }

  // Stream records to a temporary JSON array so the complete catalogue does
  // not remain in memory and JSON.stringify never receives the whole file.
  const masterPath = path.join(DATA_DIR, 'master.json');
  const tempMasterPath = `${masterPath}.tmp`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const masterFd = fs.openSync(tempMasterPath, 'w');
  fs.writeSync(masterFd, '[');
  let firstRecord = true;
  let savedCount = 0;
  const amcs = new Set();

  function appendRecord(record) {
    if (!firstRecord) fs.writeSync(masterFd, ',');
    fs.writeSync(masterFd, JSON.stringify(record));
    firstRecord = false;
    savedCount++;
    if (record.amc) amcs.add(record.amc);
  }

  function checkpoint({ final }) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const amcList = [...amcs].sort();
    const meta = {
      years: YEARS,
      totalSchemes: savedCount,
      amcCount: amcList.length,
      amcList,
      schemeTypes: [],
      schemeCategories: [],
      latestFetchAt: new Date().toISOString(),
      latestMatchedCount: savedCount,
      dataSource: MFAPI_URL,
      builtAt: new Date().toISOString(),
      buildComplete: final
    };
    fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  const CONCURRENCY = 12;
  const FLUSH_EVERY = 1000; // checkpoint to disk every N completed schemes
  let completed = 0;
  let failed = 0;
  let reused = 0;
  let sinceCheckpoint = 0;
  for (let start = 0; start < schemes.length; start += CONCURRENCY) {
    const batch = schemes.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map(async (scheme) => {
      const existing = existingByCode.get(String(scheme.schemeCode));
      // Already fresh — reuse the previous build's record untouched instead
      // of re-downloading its entire history from MFAPI for no benefit.
      if (isFresh(existing, now)) { reused++; return existing; }
      try {
        return buildRecord(scheme, await fetchHistory(scheme));
      } catch (error) {
        failed++;
        if (existing) {
          // The fetch failed (network blip, MFAPI hiccup) but we still have
          // an older copy — keep that rather than dropping the scheme from
          // the dataset entirely over a transient error.
          console.warn(`Using previous data for ${scheme.schemeCode} (${scheme.schemeName}) — refetch failed: ${error.message}`);
          return existing;
        }
        console.warn(`Skipping ${scheme.schemeCode} (${scheme.schemeName}): ${error.message}`);
        return null;
      }
    }));
    const added = results.filter(Boolean);
    added.forEach(appendRecord);
    sinceCheckpoint += added.length;
    completed += batch.length;
    if (completed % 240 === 0 || completed === schemes.length) console.log(`Fetched ${completed} / ${schemes.length} histories (${reused} reused, ${failed} failed, ${savedCount} saved so far).`);
    if (sinceCheckpoint >= FLUSH_EVERY) {
      checkpoint({ final: false });
      console.log(`Checkpoint saved: ${savedCount} records written to master.json so far.`);
      sinceCheckpoint = 0;
    }
  }

  fs.writeSync(masterFd, ']');
  fs.closeSync(masterFd);
  fs.renameSync(tempMasterPath, masterPath);
  checkpoint({ final: true });
  console.log(`Done. ${savedCount} scheme records from MFAPI (${reused} reused from previous sync, ${failed} skipped after retries).`);
}

if (require.main === module) {
  build().catch((error) => {
    console.error(`MFAPI build failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { build, isRegularGrowth, valueOnMarch31, parseSchemePlan, parseSchemeOption };