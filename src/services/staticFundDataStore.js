const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '../../data/fund-static-data.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS fund_static_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheme_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT,
    risk_measures TEXT NOT NULL DEFAULT '{}',
    market_capitalisation TEXT NOT NULL DEFAULT '{}',
    amfi_sectors TEXT NOT NULL DEFAULT '[]',
    exit_load TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_fund_static_data_scheme ON fund_static_data(scheme_name);
`);

const parse = row => ({
  ...row,
  riskMeasures: JSON.parse(row.risk_measures || '{}'),
  marketCapitalisation: JSON.parse(row.market_capitalisation || '{}'),
  amfiSectors: JSON.parse(row.amfi_sectors || '[]'),
  exitLoad: row.exit_load || ''
});

function normalizeSchemeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchBestStaticRecord(schemeName) {
  if (!schemeName) return null;
  const target = normalizeSchemeName(schemeName);
  if (!target) return null;

  const rows = db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name').all();
  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    const candidate = normalizeSchemeName(row.scheme_name);
    if (!candidate) continue;

    if (candidate === target) return parse(row);

    const candidateWords = new Set(candidate.split(' ').filter(Boolean));
    const targetWords = new Set(target.split(' ').filter(Boolean));
    const overlap = [...targetWords].filter(word => candidateWords.has(word)).length;
    const contains = candidate.includes(target) || target.includes(candidate);

    let score = 0;
    if (contains) score = 1000 + overlap;
    else if (overlap > 0) score = 200 + overlap;
    else if (candidate.includes(target.split(' ')[0]) || target.includes(candidate.split(' ')[0])) score = 25;

    if (score > bestScore) {
      bestScore = score;
      best = parse(row);
    }
  }

  return bestScore > 0 ? best : null;
}

// Every record, uncapped — used by the Excel export (list() below is
// capped at 1000 rows for the Admin table UI; export must return ALL
// schemes regardless of count).
function listAll() {
  return db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name').all().map(parse);
}

function list({ search = '', limit = 500 } = {}) {
  const query = search.trim();
  const max = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const rows = query
    ? db.prepare('SELECT * FROM fund_static_data WHERE scheme_name LIKE ? OR category LIKE ? ORDER BY scheme_name LIMIT ?').all(`%${query}%`, `%${query}%`, max)
    : db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name LIMIT ?').all(max);
  return rows.map(parse);
}

function findExactBySchemeName(schemeName) {
  // Strict, case-insensitive exact match only — no fuzzy/partial fallback.
  // Used anywhere an insert-vs-update DECISION is being made (bulk Excel
  // import, the CLI import script) so that two genuinely different
  // schemes with similar names (e.g. the same fund's Growth vs IDCW
  // option) never get merged into one record. The fuzzy matcher in
  // getBySchemeName() below is only safe for read-only runtime lookups.
  if (!schemeName) return null;
  const row = db.prepare('SELECT * FROM fund_static_data WHERE scheme_name = ? COLLATE NOCASE').get(String(schemeName).trim());
  return row ? parse(row) : null;
}

function getBySchemeName(schemeName) {
  if (!schemeName) return null;
  const trimmed = String(schemeName).trim();
  let row = db.prepare('SELECT * FROM fund_static_data WHERE scheme_name = ? COLLATE NOCASE').get(trimmed);
  if (!row) row = db.prepare('SELECT * FROM fund_static_data WHERE scheme_name LIKE ? ORDER BY LENGTH(scheme_name) LIMIT 1').get(`%${trimmed}%`);
  if (!row) row = matchBestStaticRecord(trimmed);
  return row ? parse(row) : null;
}

function sanitizeSectors(list) {
  // Backward compatible with the old shape (plain array of sector-name
  // strings, e.g. from importFundStaticData.js) AND the new shape sent by
  // the Admin CRUD form: array of { sector, percentage } objects.
  if (!Array.isArray(list)) return [];
  const toDisplayString = (item) => {
    if (typeof item === 'string') return item.trim();
    const sector = String(item?.sector || item?.name || '').trim();
    if (!sector) return '';
    let pct = String(item?.percentage ?? item?.value ?? '').trim();
    if (pct && !/%\s*$/.test(pct)) pct += '%';
    return pct ? `${sector} (${pct})` : sector;
  };
  return list.map(toDisplayString).filter(Boolean).slice(0, 10);
}

function sanitizeExitLoad(value) {
  // Backward compatible with the old shape (a single free-text string)
  // AND the new shape sent by the Admin CRUD form: array of
  // { condition, value } row objects, which get joined into one string
  // so the exit_load column and every downstream consumer stay unchanged.
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const rows = value.map(item => {
      const condition = String(item?.condition || item?.name || '').trim();
      const val = String(item?.value ?? '').trim();
      if (!condition && !val) return '';
      if (!condition) return val;
      return val ? `${condition} — ${val}` : condition;
    }).filter(Boolean);
    return rows.join('; ');
  }
  return '';
}

function validate(payload) {
  const schemeName = String(payload.schemeName || '').trim();
  if (!schemeName) throw new Error('Scheme name is required.');
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemeName,
    category: String(payload.category || '').trim(),
    riskMeasures: object(payload.riskMeasures),
    marketCapitalisation: object(payload.marketCapitalisation),
    amfiSectors: sanitizeSectors(payload.amfiSectors),
    exitLoad: sanitizeExitLoad(payload.exitLoad),
    source: String(payload.source || 'admin').slice(0, 50)
  };
}

function save(payload, id = null) {
  const value = validate(payload);
  try {
    if (id) {
      const result = db.prepare(`UPDATE fund_static_data SET scheme_name=?, category=?, risk_measures=?, market_capitalisation=?, amfi_sectors=?, exit_load=?, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(value.schemeName, value.category, JSON.stringify(value.riskMeasures), JSON.stringify(value.marketCapitalisation), JSON.stringify(value.amfiSectors), value.exitLoad, value.source, id);
      if (!result.changes) throw new Error('Static fund record not found.');
      return parse(db.prepare('SELECT * FROM fund_static_data WHERE id=?').get(id));
    }
    const result = db.prepare(`INSERT INTO fund_static_data (scheme_name, category, risk_measures, market_capitalisation, amfi_sectors, exit_load, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(value.schemeName, value.category, JSON.stringify(value.riskMeasures), JSON.stringify(value.marketCapitalisation), JSON.stringify(value.amfiSectors), value.exitLoad, value.source);
    return parse(db.prepare('SELECT * FROM fund_static_data WHERE id=?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message)) {
      throw new Error(`A record for "${value.schemeName}" already exists.`);
    }
    throw err;
  }
}

function remove(id) {
  return db.prepare('DELETE FROM fund_static_data WHERE id=?').run(id).changes > 0;
}

module.exports = { db, list, listAll, getBySchemeName, findExactBySchemeName, normalizeSchemeName, save, remove };