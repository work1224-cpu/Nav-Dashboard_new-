const express = require('express');
const router = express.Router();
const usersStore = require('../utils/usersStore');
const staticFundDataStore = require('../services/staticFundDataStore');

// All routes here are already protected by requireAuth + requireAdmin in server.js

// GET /api/admin/users - list all users
router.get('/users', (req, res) => {
  res.json({ users: usersStore.getAllUsers() });
});

// POST /api/admin/users - create a new user
router.post('/users', (req, res) => {
  const { username, password, role } = req.body || {};

  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const user = usersStore.createUser({ username: username.trim(), password, role });
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/password - admin changes any user's password
router.patch('/users/:id/password', (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};

  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const user = usersStore.setUserPassword(id, password);
    res.json({ user });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:id/role - promote/demote a user
router.patch('/users/:id/role', (req, res) => {
  const { id } = req.params;
  const { role } = req.body || {};

  if (role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: 'Role must be "admin" or "user".' });
  }

  // Prevent an admin from demoting themselves and locking themselves out
  if (req.session.user.id === id && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin access.' });
  }

  try {
    const user = usersStore.setUserRole(id, role);
    res.json({ user });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id - remove a user
router.delete('/users/:id', (req, res) => {
  const { id } = req.params;

  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'You cannot delete your own account while logged in.' });
  }

  try {
    usersStore.deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/fund-static-data', (req, res) => {
  res.json({ records: staticFundDataStore.list({ search: req.query.search || '', limit: req.query.limit }) });
});

router.post('/fund-static-data', (req, res) => {
  try { res.status(201).json({ record: staticFundDataStore.save(req.body) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/fund-static-data/:id', (req, res) => {
  try { res.json({ record: staticFundDataStore.save(req.body, Number(req.params.id)) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/fund-static-data/:id', (req, res) => {
  if (!staticFundDataStore.remove(Number(req.params.id))) return res.status(404).json({ error: 'Static fund record not found.' });
  res.json({ ok: true });
});

// ── Excel bulk import — multiple AMCs / schemes in one upload ──────────
// Simple flat format: one row per scheme. See /fund-static-data/template
// below for the exact column layout with worked examples.
const XLSX = require('xlsx');

function addInstructionsSheet(wb, { forExport = false } = {}) {
  const instructionsWs = XLSX.utils.aoa_to_sheet([
    ['HOW TO FILL "Static Fund Data"'],
    [],
    ['- Only fill in the "Static Fund Data" sheet. This sheet is for reference only and is ignored on upload.'],
    ['- One row per scheme. "Scheme Name" is required and must be unique — re-uploading the same exact name UPDATES that record instead of creating a duplicate.'],
    [forExport
      ? '- This file already has one row per existing record — edit values directly, add new rows for new schemes, or delete a row for a scheme you no longer want tracked (deleting the row here does NOT delete it from the database on its own — re-upload this file, then remove that scheme from the Admin table).'
      : '- Delete the two example rows before adding your real data, or just add your rows below them.'],
    ['- Risk Measures / Market Capitalisation (%): comma-separated "Name: Value" pairs, e.g.  Std Dev: 12.4, Sharpe: 0.9'],
    ['- AMFI Sectors (%): comma-separated "Sector (Percentage%)" entries, e.g.  Financial Services (25%), IT (18%)'],
    ['- Exit Load: one or more "Condition — Value" rules separated by semicolons, e.g.  1% within 365 days — 1%; After that — Nil   (use just "Nil" if there is no load)']
  ]);
  instructionsWs['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, instructionsWs, 'Instructions');
}

const COLUMNS = {
  scheme: 'Scheme Name',
  category: 'Category',
  risk: 'Risk Measures',
  market: 'Market Capitalisation (%)',
  sectors: 'AMFI Sectors (%)',
  exitLoad: 'Exit Load'
};

// "Std Dev: 12.4, Sharpe: 0.9" -> { "Std Dev": "12.4", "Sharpe": "0.9" }
function parsePairsCell(raw) {
  const result = {};
  String(raw || '').split(',').forEach(pair => {
    const i = pair.indexOf(':');
    if (i === -1) return;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (name) result[name] = value;
  });
  return result;
}

// "Financial Services (25%), IT (18%)" -> ["Financial Services (25%)", "IT (18%)"]
function parseSectorsCell(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
}

router.post('/fund-static-data/bulk-import', (req, res) => {
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'No file was uploaded.' });

  let rows;
  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    if (!workbook.SheetNames.length) throw new Error('No sheets found');
    const sheetName = workbook.SheetNames.includes('Static Fund Data') ? 'Static Fund Data' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const headerCells = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
    if (!headerCells.some(cell => String(cell).trim() === COLUMNS.scheme)) {
      throw new Error(`This doesn't look like the template — no "${COLUMNS.scheme}" column found in the first sheet.`);
    }
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: err.message.includes('template') ? err.message : 'Could not read this file. Please upload a valid .xlsx file (you can start from the demo template).' });
  }

  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  rows.forEach((row, idx) => {
    const schemeName = String(row[COLUMNS.scheme] || '').trim();
    if (!schemeName) { skipped++; return; }

    const payload = {
      schemeName,
      category: String(row[COLUMNS.category] || '').trim(),
      riskMeasures: parsePairsCell(row[COLUMNS.risk]),
      marketCapitalisation: parsePairsCell(row[COLUMNS.market]),
      amfiSectors: parseSectorsCell(row[COLUMNS.sectors]),
      exitLoad: String(row[COLUMNS.exitLoad] || '').trim(),
      source: 'bulk-upload'
    };

    try {
      // Exact match ONLY to decide insert vs. update — deliberately not
      // using the fuzzy getBySchemeName() lookup here, so two similarly
      // named but different schemes (e.g. Growth vs IDCW) never overwrite
      // each other.
      const existing = staticFundDataStore.findExactBySchemeName(schemeName);
      staticFundDataStore.save(payload, existing?.id);
      if (existing) updated++; else created++;
    } catch (err) {
      errors.push(`Row ${idx + 2} ("${schemeName}"): ${err.message}`);
    }
  });

  res.json({ totalRows: rows.length, created, updated, skipped, errors });
});

// ── Export ALL current records — same file the bulk import above reads,
//    so downloading this, editing it, and re-uploading it just works. ───
// "Name: Value" pairs and "Sector (25%)" list, the reverse of
// parsePairsCell()/parseSectorsCell() above.
function formatPairsCell(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj).filter(([name]) => name).map(([name, value]) => `${name}: ${value}`).join(', ');
}
function formatSectorsCell(list) {
  return Array.isArray(list) ? list.filter(Boolean).join(', ') : '';
}

router.get('/fund-static-data/export', (req, res) => {
  // listAll(), not list() — list() caps at 1000 rows for the Admin table UI;
  // export must include every scheme regardless of how many exist.
  const records = staticFundDataStore.listAll();

  const headerRow = Object.values(COLUMNS);
  const dataRows = records.map(r => [
    r.scheme_name,
    r.category || '',
    formatPairsCell(r.riskMeasures),
    formatPairsCell(r.marketCapitalisation),
    formatSectorsCell(r.amfiSectors),
    r.exitLoad || ''
  ]);

  const wb = XLSX.utils.book_new();
  const dataWs = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  dataWs['!cols'] = [{ wch: 42 }, { wch: 16 }, { wch: 38 }, { wch: 34 }, { wch: 40 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, dataWs, 'Static Fund Data');
  addInstructionsSheet(wb, { forExport: true });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="Static_Fund_Data_Export_${stamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Downloadable demo template for the bulk import above ───────────────
router.get('/fund-static-data/template', (req, res) => {
  const headerRow = Object.values(COLUMNS);
  const exampleRows = [
    [
      'Axis Bluechip Fund - Direct Plan - Growth',
      'Large Cap',
      'Std Dev: 12.4, Sharpe: 0.9, Beta: 0.95',
      'Large Cap: 78%, Mid Cap: 15%, Small Cap: 7%',
      'Financial Services (25%), IT (18%), Healthcare (10%)',
      '1% if redeemed within 365 days — 1%; After 365 days — Nil'
    ],
    [
      'HDFC ELSS Tax Saver - Direct Plan - Growth',
      'ELSS',
      'Std Dev: 14.1',
      'Large Cap: 60%, Mid Cap: 25%, Small Cap: 15%',
      'Banks (20%), IT - Software (12%)',
      'Nil'
    ]
  ];

  const wb = XLSX.utils.book_new();

  // Data sheet — kept PURELY tabular (header + example rows only). Anything
  // typed into the Scheme Name column is treated as a real scheme on
  // upload, so instructions live on their own separate tab below instead
  // of as trailing rows here.
  const dataWs = XLSX.utils.aoa_to_sheet([headerRow, ...exampleRows]);
  dataWs['!cols'] = [{ wch: 42 }, { wch: 16 }, { wch: 38 }, { wch: 34 }, { wch: 40 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, dataWs, 'Static Fund Data');

  addInstructionsSheet(wb);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="Static_Fund_Data_Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;