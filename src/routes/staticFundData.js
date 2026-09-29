const express = require('express');
const store = require('../services/staticFundDataStore');

const router = express.Router();

// Read-only static details for all authenticated dashboard users.
router.get('/fund-static-data', (req, res) => {
  const record = store.getBySchemeName(req.query.schemeName);
  res.json({ record });
});

module.exports = router;
