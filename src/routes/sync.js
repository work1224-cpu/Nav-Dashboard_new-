const express = require('express');
const router = express.Router();
const syncService = require('../services/syncService');
const returnsCache = require('../services/returnsCache');

// Kick off (or report status of) a background sync of every scheme's
// Returns + Rolling Returns. Non-blocking — returns immediately.
router.post('/sync/start', async (req, res) => {
  const force = req.body?.force === true;
  const status = await syncService.runSync({ force });
  res.json(status);
});

router.post('/sync/stop', (req, res) => {
  res.json(syncService.stopSync());
});

router.get('/sync/status', (req, res) => {
  res.json(syncService.getStatus());
});

// ── "Old Sync" — read-only cached view, never hits mfapi.in ───────────
// Used so the dashboard keeps working (with the last saved numbers) even
// if the live NAV API is down.
router.get('/nav/cached-returns/:code', (req, res) => {
  const { code } = req.params;
  const cached = returnsCache.get(code);
  if (!cached) {
    return res.status(404).json({ error: 'No cached data for this scheme yet. Run Sync first.' });
  }
  res.json({
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
});

router.get('/nav/cached-rolling-returns/:code', (req, res) => {
  const { code } = req.params;
  const cached = returnsCache.get(code);
  if (!cached) {
    return res.status(404).json({ error: 'No cached data for this scheme yet. Run Sync first.' });
  }
  res.json({
    code,
    schemeName: cached.schemeName || '',
    rolling: cached.rolling,
    cached: true,
    computedAt: cached.computedAt
  });
});

module.exports = router;