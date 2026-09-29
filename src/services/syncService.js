const path = require('path');
const navData = require(path.join(__dirname, '../../data/navdata.json'));
const { fetchSchemeHistory, calculateReturns, calculateAllRollingReturns } = require('../lib/schemeCalculations');
const returnsCache = require('./returnsCache');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Bumped from the original 2/250ms — those were extremely conservative and
// made a full 14,000+ scheme sync take well over an hour. mfapi.in is a
// widely-used community API with no published hard rate limit; 8 parallel
// requests with a light 60ms stagger is still gentle (nowhere near
// hammering it) but finishes several times faster. Tune via env vars if
// mfapi.in ever starts rate-limiting at this level (watch state.failed).
const DEFAULT_CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || 8);
const REQUEST_STAGGER_MS = Number(process.env.SYNC_STAGGER_MS || 60);      // small delay before each request starts
const FLUSH_EVERY = 200; // periodic disk write during sync (now non-blocking — see returnsCache.js)

const state = {
  running: false,
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  startedAt: null,
  finishedAt: null,
  currentBatch: [],   // codes currently in-flight, for a "live" progress feel
  stopRequested: false,
  lastError: null,
  nextAutoSyncAt: null // ISO timestamp of the next scheduled daily full sync
};

// ── Scheme list (all AMCs, deduped by code) ─────────────
function getAllSchemes() {
  const all = Object.values(navData).flat();
  const map = new Map();
  for (const s of all) {
    if (s.code && !map.has(s.code)) map.set(s.code, { code: s.code, name: s.name });
  }
  return [...map.values()];
}

function getTotalSchemeCount() {
  return getAllSchemes().length;
}

async function processScheme(code, name) {
  try {
    // Bulk sync uses a shorter timeout and fewer retries than an
    // interactive single-scheme lookup: with 14,000+ schemes to get
    // through, a handful of slow/dead ones (delisted funds, mfapi.in
    // hiccups) can otherwise tie up a worker slot for up to a minute each
    // (20s timeout × up to 3 attempts) and dominate total sync time. 8s
    // timeout / 1 retry caps the worst case per scheme at ~16s while still
    // giving genuinely slow-but-working schemes a fair second try.
    const history = await fetchSchemeHistory(code, 8000, 1);
    const returnsResult = calculateReturns(history.data);
    const rolling = calculateAllRollingReturns(history.data);
    returnsCache.save(code, {
      schemeName: name || history.meta.scheme_name || '',
      returnsResult,
      rolling
    });
    state.completed++;
  } catch (err) {
    state.failed++;
    state.lastError = `${code}: ${err.message}`;
  }
}

// Simple fixed-concurrency worker pool.
async function runPool(items, worker, concurrency) {
  let idx = 0;
  let sinceFlush = 0;

  async function runNext() {
    while (idx < items.length && !state.stopRequested) {
      const item = items[idx++];
      await sleep(REQUEST_STAGGER_MS);
      if (state.stopRequested) break;
      state.currentBatch.push(item.code);
      await worker(item);
      state.currentBatch = state.currentBatch.filter(c => c !== item.code);

      sinceFlush++;
      if (sinceFlush >= FLUSH_EVERY) {
        returnsCache.flushNow();
        sinceFlush = 0;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(runNext());
  await Promise.all(workers);
}

// ── Public API ───────────────────────────────────────────
// force=false: only (re)computes schemes missing from cache or older than
//              staleHours — fast after the first run.
// force=true:  recomputes every scheme regardless of freshness.
async function runSync({ force = false, staleHours = returnsCache.DEFAULT_STALE_HOURS, concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (state.running) return getStatus(); // already going — don't double-start

  const schemes = getAllSchemes();
  const targets = force
    ? schemes
    : schemes.filter(s => {
        const cached = returnsCache.get(s.code);
        return !cached || returnsCache.isStale(cached, staleHours);
      });

  state.running = true;
  state.total = targets.length;
  state.completed = 0;
  state.failed = 0;
  state.skipped = schemes.length - targets.length;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.currentBatch = [];
  state.stopRequested = false;
  state.lastError = null;

  returnsCache.setSyncStarted();

  // Run in the background — caller doesn't await this.
  runPool(targets, (item) => processScheme(item.code, item.name), concurrency)
    .then(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      returnsCache.setSyncCompleted();
    })
    .catch((err) => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.lastError = err.message;
      returnsCache.flushNow();
    });

  return getStatus();
}

function stopSync() {
  if (state.running) state.stopRequested = true;
  return getStatus();
}

function getStatus() {
  const summary = returnsCache.getSummary(getTotalSchemeCount());
  return {
    running: state.running,
    total: state.total,
    completed: state.completed,
    failed: state.failed,
    skipped: state.skipped,
    percent: state.total > 0 ? Math.round(((state.completed + state.failed) / state.total) * 100) : 100,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lastError: state.lastError,
    nextAutoSyncAt: state.nextAutoSyncAt,
    cache: summary
  };
}

// ── Daily full auto-sync scheduler ──────────────────────
// Runs a FULL (force=true) sync of every single scheme once a day at the
// given server-local time, for as long as the process stays running — no
// external cron dependency needed. If a full sync happens to still be
// running when the next 9pm rolls around, runSync() itself already no-ops
// on a duplicate start, so this is safe to leave running indefinitely.
function scheduleDailyFullSync({ hour = 21, minute = 0, concurrency = DEFAULT_CONCURRENCY } = {}) {
  function msUntilNext() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return { delay: next - now, at: next };
  }

  function runAndReschedule() {
    console.log(`🌙 [Daily Auto-Sync] Kicking off a full re-sync of every scheme (${new Date().toLocaleString()})…`);
    runSync({ force: true, concurrency })
      .then(status => {
        console.log(`🌙 [Daily Auto-Sync] Queued ${status.total} scheme(s) for a full refresh.`);
      })
      .catch(err => {
        console.error('🌙 [Daily Auto-Sync] Failed to start:', err.message);
      });

    // Recomputed from the clock each time so it can't drift over days/weeks
    // and self-corrects across DST or system clock changes.
    const { delay, at } = msUntilNext();
    state.nextAutoSyncAt = at.toISOString();
    setTimeout(runAndReschedule, delay);
  }

  const { delay, at } = msUntilNext();
  state.nextAutoSyncAt = at.toISOString();
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  console.log(`🕘 Daily Auto-Sync scheduled for ${hh}:${mm} (server local time) — next run at ${at.toLocaleString()}.`);
  setTimeout(runAndReschedule, delay);
}

module.exports = { runSync, stopSync, getStatus, getTotalSchemeCount, scheduleDailyFullSync };