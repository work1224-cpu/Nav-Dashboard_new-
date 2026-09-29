const fs = require('fs');
const path = require('path');
const {
  calculateReturns,
  calculateAllRollingReturns
} = require('../lib/schemeCalculations');

const CACHE_FILE = path.join(__dirname, '../../data/returns-cache.json');
const DEFAULT_STALE_HOURS = 24;
const CALCULATION_VERSION = 3;

let cache = {
  meta: {
    lastFullSyncStartedAt: null,
    lastFullSyncCompletedAt: null
  },
  schemes: {} // code -> { schemeName, currentNav, currentDate, returns, rolling, computedAt }
};

let dirty = false;
let flushTimer = null;

// ── Load from disk on startup ───────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schemes) {
        cache = parsed;
      }
    }
  } catch (err) {
    console.error('[returnsCache] Failed to load cache from disk, starting fresh:', err.message);
  }
}
loadFromDisk();

// ── Persist to disk ──────────────────────────────────────
// SYNC path (blocking): only used when the process is actually exiting —
// 'exit'/SIGINT/SIGTERM handlers can only rely on synchronous code, so
// this has to block briefly there to guarantee the cache isn't lost.
function flushToDiskSync() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('[returnsCache] Failed to write cache to disk:', err.message);
  }
}

// ASYNC path (non-blocking): used everywhere else, especially during a
// bulk sync. The cache file is tens of MB, so a synchronous write here
// used to freeze the ENTIRE server (every request, every worker) for a
// few hundred ms each time — and with a full sync flushing every 25
// schemes across 14,000+ schemes, that added up to minutes of the whole
// site just hanging. This keeps disk I/O off the event loop; if another
// flush is requested while one is already writing, it's queued to run
// once, right after (never dropped, never piled up).
let writingAsync = false;
let rewriteQueued = false;
function flushToDiskAsync() {
  if (writingAsync) { rewriteQueued = true; return; }
  writingAsync = true;
  const snapshot = JSON.stringify(cache);
  fs.mkdir(path.dirname(CACHE_FILE), { recursive: true }, () => {
    fs.writeFile(CACHE_FILE, snapshot, 'utf8', (err) => {
      writingAsync = false;
      if (err) {
        console.error('[returnsCache] Failed to write cache to disk:', err.message);
      } else {
        dirty = false;
      }
      if (rewriteQueued) { rewriteQueued = false; flushToDiskAsync(); }
    });
  });
}

function scheduleFlush(delayMs = 2000) {
  dirty = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) flushToDiskAsync();
  }, delayMs);
}

// Trigger an immediate (but non-blocking) write — used by the sync job
// after each batch, so progress survives even if the process is killed
// mid-sync, without freezing the server while it writes.
function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushToDiskAsync();
}

// Make sure nothing is lost if the process exits normally — this is the
// one place a blocking write is actually necessary.
process.on('exit', () => { if (dirty) flushToDiskSync(); });
process.on('SIGINT', () => { flushToDiskSync(); process.exit(0); });
process.on('SIGTERM', () => { flushToDiskSync(); process.exit(0); });

// ── Reads ────────────────────────────────────────────────
function get(code) {
  return cache.schemes[code] || null;
}

function isStale(entry, staleHours = DEFAULT_STALE_HOURS) {
  if (!entry || !entry.computedAt || entry.calculationVersion !== CALCULATION_VERSION) return true;
  const ageMs = Date.now() - new Date(entry.computedAt).getTime();
  return ageMs > staleHours * 60 * 60 * 1000;
}

function getSummary(totalSchemesKnown) {
  const codes = Object.keys(cache.schemes);
  let oldest = null, newest = null;
  for (const code of codes) {
    const t = cache.schemes[code].computedAt;
    if (!t) continue;
    if (!oldest || t < oldest) oldest = t;
    if (!newest || t > newest) newest = t;
  }
  return {
    totalCached: codes.length,
    totalSchemes: totalSchemesKnown || codes.length,
    lastFullSyncStartedAt: cache.meta.lastFullSyncStartedAt,
    lastFullSyncCompletedAt: cache.meta.lastFullSyncCompletedAt,
    oldestComputedAt: oldest,
    newestComputedAt: newest
  };
}

// ── Writes ───────────────────────────────────────────────
// Accepts either raw `history` (and computes returns/rolling from it) or
// already-computed `returnsResult` / `rolling`, so callers with different
// amounts of pre-computed data can all funnel through one save path.
function save(code, { schemeName, history, returnsResult, rolling }) {
  let finalReturnsResult = returnsResult;
  let finalRolling = rolling;

  if (history && history.data) {
    if (!finalReturnsResult) finalReturnsResult = calculateReturns(history.data);
    if (!finalRolling) finalRolling = calculateAllRollingReturns(history.data);
  }

  if (!finalReturnsResult && !finalRolling) return null; // nothing usable to save

  const entry = {
    schemeName: schemeName || (get(code) || {}).schemeName || '',
    currentNav: finalReturnsResult ? finalReturnsResult.latestNav : (get(code) || {}).currentNav,
    currentDate: finalReturnsResult ? finalReturnsResult.latestDate : (get(code) || {}).currentDate,
    returns: finalReturnsResult ? finalReturnsResult.returns : (get(code) || {}).returns,
    rolling: finalRolling || (get(code) || {}).rolling,
    calculationVersion: CALCULATION_VERSION,
    computedAt: new Date().toISOString()
  };

  cache.schemes[code] = entry;
  scheduleFlush();
  return entry;
}

function setSyncStarted() {
  cache.meta.lastFullSyncStartedAt = new Date().toISOString();
  scheduleFlush(0);
  flushNow();
}

function setSyncCompleted() {
  cache.meta.lastFullSyncCompletedAt = new Date().toISOString();
  flushNow();
}

module.exports = {
  get,
  save,
  isStale,
  getSummary,
  setSyncStarted,
  setSyncCompleted,
  flushNow,
  DEFAULT_STALE_HOURS
};