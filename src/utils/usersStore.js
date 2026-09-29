const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// ── SQLite-backed user store ────────────────────────────────────────────
// Replaces the old flat data/users.json file (which had no locking,
// no atomic writes, and rewrote the ENTIRE file on every single change).
// Follows the same better-sqlite3 pattern already used in
// src/services/staticFundDataStore.js.

const DB_PATH = path.join(__dirname, '../../data/users.sqlite');
const LEGACY_USERS_FILE = path.join(__dirname, '../../data/users.json');

const db = new Database(DB_PATH);
// journal_mode DELETE (the SQLite default) keeps everything in the single
// users.sqlite file. WAL mode was used before, but it keeps recent writes
// in separate users.sqlite-wal / users.sqlite-shm side files — if only
// users.sqlite gets zipped/copied to another device (very easy to miss,
// since those are hidden-looking extra files), the accounts created or
// password changes made after the last checkpoint are silently lost on
// the new device. A small local app like this doesn't need WAL's
// concurrency benefit, so DELETE mode trades that for one portable file.
db.pragma('journal_mode = DELETE');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// One-time migration: if the table is empty and the old users.json still
// exists, import every account from it (id, username, hash, role,
// createdAt preserved) so nobody's login breaks on upgrade.
(function migrateLegacyUsersFile() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (existing > 0) return;

  // Prefer users.json (not-yet-migrated), but fall back to users.json.bak —
  // the name migration leaves behind on a device where it already ran once.
  // Without this fallback, moving a project after migration already
  // happened (users.sqlite missing from the copy, only users.json.bak
  // present) re-imports nothing and silently starts with zero accounts,
  // which looks exactly like "my password stopped working".
  const source = fs.existsSync(LEGACY_USERS_FILE) ? LEGACY_USERS_FILE
    : fs.existsSync(`${LEGACY_USERS_FILE}.bak`) ? `${LEGACY_USERS_FILE}.bak`
    : null;
  if (!source) return;

  try {
    const legacyUsers = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!Array.isArray(legacyUsers) || legacyUsers.length === 0) return;

    const insert = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (@id, @username, @passwordHash, @role, @createdAt)
    `);
    const insertAll = db.transaction((rows) => {
      for (const u of rows) {
        insert.run({
          id: u.id,
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role === 'admin' ? 'admin' : 'user',
          createdAt: u.createdAt || new Date().toISOString()
        });
      }
    });
    insertAll(legacyUsers);

    // Keep/rename to .bak instead of deleting, just in case. No-op if the
    // source was already the .bak file.
    if (source === LEGACY_USERS_FILE) fs.renameSync(LEGACY_USERS_FILE, `${LEGACY_USERS_FILE}.bak`);
    console.log(`[usersStore] Migrated ${legacyUsers.length} user(s) from ${source.split('/').pop()} into users.sqlite`);
  } catch (err) {
    console.error(`[usersStore] Legacy users file migration failed (${source}):`, err.message);
  }
})();

// Last-resort safety net: if the table is STILL empty after the migration
// above (e.g. this is a fresh copy of the project and users.sqlite,
// users.json AND users.json.bak were all left behind when it was zipped —
// dotfile-ish/hidden-looking files are easy to miss), seed the same
// default admin + user account the README documents, instead of silently
// booting with zero logins. Printed loudly so it's obvious this happened.
(function seedDefaultAccountsIfEmpty() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (existing > 0) return;

  const seedInsert = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at)
    VALUES (@id, @username, @passwordHash, @role, @createdAt)
  `);
  const now = new Date().toISOString();
  const defaults = [
    { id: 'u-001', username: 'admin', password: 'admin123', role: 'admin' },
    { id: 'u-002', username: 'user', password: 'user123', role: 'user' }
  ];
  const insertAll = db.transaction((rows) => {
    for (const u of rows) {
      seedInsert.run({
        id: u.id, username: u.username,
        passwordHash: bcrypt.hashSync(u.password, 10),
        role: u.role, createdAt: now
      });
    }
  });
  insertAll(defaults);

  console.warn('\n⚠️  [usersStore] No user accounts found — this looks like a fresh copy of the');
  console.warn('   project (users.sqlite / users.json were not carried over). Created the');
  console.warn('   default accounts so login works right away:');
  console.warn('     admin / admin123   (role: admin)');
  console.warn('     user  / user123    (role: user)');
  console.warn('   Change these passwords from the Admin Console once you log in.\n');
})();

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at
  };
}

function nextId() {
  const rows = db.prepare('SELECT id FROM users').all();
  let max = 0;
  for (const { id } of rows) {
    const n = parseInt(String(id).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `u-${String(max + 1).padStart(3, '0')}`;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// Kept for backwards compatibility with anything that expects the old
// "load everything into an array" shape.
function loadUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(rowToUser);
}

function saveUsers() {
  // No-op under SQLite: every mutation below already writes straight to
  // the database. Kept only so old callers don't break if they call it.
}

function findByUsername(username) {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || ''));
  return rowToUser(row);
}

function findById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return rowToUser(row);
}

function getAllUsers() {
  return loadUsers().map(publicUser);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function createUser({ username, password, role }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing) {
    throw new Error('Username already exists');
  }

  const newUser = {
    id: nextId(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(newUser.id, newUser.username, newUser.passwordHash, newUser.role, newUser.createdAt);

  return publicUser(newUser);
}

function setUserPassword(id, newPassword) {
  const passwordHash = bcrypt.hashSync(newPassword, 10);
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  if (!result.changes) throw new Error('User not found');
  return publicUser(findById(id));
}

function setUserRole(id, role) {
  const normalizedRole = role === 'admin' ? 'admin' : 'user';
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(normalizedRole, id);
  if (!result.changes) throw new Error('User not found');
  return publicUser(findById(id));
}

function deleteUser(id) {
  const user = findById(id);
  if (!user) throw new Error('User not found');

  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) throw new Error('Cannot delete the last remaining admin');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

module.exports = {
  db,
  loadUsers,
  saveUsers,
  publicUser,
  findByUsername,
  findById,
  getAllUsers,
  verifyPassword,
  createUser,
  setUserPassword,
  setUserRole,
  deleteUser
};