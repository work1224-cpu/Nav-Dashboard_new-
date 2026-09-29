// Session-based auth guards.
// - For /api/* and /nav-ledger-api/* requests: respond with JSON 401/403
//   (frontend handles redirect). The Rule Engine (NAV Ledger) shares this
//   exact same login/session — it has no auth of its own — so its API
//   prefix is treated the same as this project's own /api/*.
// - For page requests: redirect to /login or / as appropriate.

function isApiRequest(req) {
  return req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/nav-ledger-api/');
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();

  if (isApiRequest(req)) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }

  if (isApiRequest(req)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return res.redirect('/');
}

module.exports = { requireAuth, requireAdmin };
