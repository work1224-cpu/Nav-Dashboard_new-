const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const usersStore = require('../utils/usersStore');

// ── Brute-force protection (in-memory, no extra dependency) ─────────────
// Two independent counters, both over a fixed 15-minute window that starts
// at the first failed attempt:
//   • per IP + username : 5 failures  → that IP can't keep guessing one account
//   • per IP (any user) : 30 failures → that IP can't spray many accounts
// Keying the account counter on IP too means a stranger can't lock the real
// admin out just by failing logins from somewhere else.
// NOTE: behind a reverse proxy set TRUST_PROXY=1 in .env, otherwise every
// visitor shares the proxy's IP and hits these limits together.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 30;
const attempts = new Map(); // key -> { count, resetAt }

function getEntry(key) {
  const entry = attempts.get(key);
  if (!entry) return null;
  if (entry.resetAt <= Date.now()) {
    attempts.delete(key);
    return null;
  }
  return entry;
}

// Returns seconds left on the lock, or 0 if not locked.
function lockedSeconds(key, max) {
  const entry = getEntry(key);
  return entry && entry.count >= max ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
}

function recordFailure(key) {
  const entry = getEntry(key);
  if (entry) entry.count++;
  else attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
}

// Drop expired entries so the map can't grow forever. unref() so this timer
// never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
}, 10 * 60 * 1000).unref();

// Compared against when the username doesn't exist, so a wrong username and a
// wrong password take the same time — otherwise response time reveals which
// usernames are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: 'Username or password is too long.' });
  }

  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ipKey = `ip:${ip}`;
  const accountKey = `acct:${ip}:${username.trim().toLowerCase()}`;

  const wait = Math.max(
    lockedSeconds(ipKey, MAX_FAILS_PER_IP),
    lockedSeconds(accountKey, MAX_FAILS_PER_ACCOUNT)
  );
  if (wait > 0) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({
      error: `Too many failed login attempts. Please try again in ${Math.ceil(wait / 60)} minute(s).`
    });
  }

  const user = usersStore.findByUsername(username);
  const passwordOk = usersStore.verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);

  if (!user || !passwordOk) {
    recordFailure(ipKey);
    recordFailure(accountKey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  attempts.delete(accountKey);

  // Issue a brand-new session id on login (session-fixation protection): any
  // session id that existed before authentication is thrown away.
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('[auth] Session regenerate failed:', regenErr.message);
      return res.status(500).json({ error: 'Could not start a session. Please try again.' });
    }
    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[auth] Session save failed:', saveErr.message);
        return res.status(500).json({ error: 'Could not start a session. Please try again.' });
      }
      res.json({ user: req.session.user });
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('nav.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({ user: req.session.user });
});

module.exports = router;