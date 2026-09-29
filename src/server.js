// Load .env FIRST. Previously this ran after the services were required, so
// any setting a service reads at import time (e.g. SYNC_CONCURRENCY,
// SYNC_STAGGER_MS in syncService.js) silently ignored the .env file.
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const navRoutes = require('./routes/nav');
const marketDataRoutes = require('./routes/market-data');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const syncRoutes = require('./routes/sync');
const ruleEngineRoutes = require('./routes/ruleEngine');
const staticFundDataRoutes = require('./routes/staticFundData');
const navLedgerRouter = require('./nav-ledger/router');
const sessionStore = require('./utils/sessionStore');
const syncService = require('./services/syncService');
const { requireAuth, requireAdmin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Session secret check ───────────────────────────────
// A short/guessable secret lets an attacker forge login cookies.
const DEFAULT_DEV_SECRET = 'nav-dashboard-dev-secret-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const secretIsWeak = SESSION_SECRET.length < 32 || SESSION_SECRET === DEFAULT_DEV_SECRET;
if (secretIsWeak) {
  const msg = 'SESSION_SECRET is missing or weak (use 32+ random characters). Generate one with:\n' +
    '   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
  if (process.env.NODE_ENV === 'production') {
    console.error(`❌ ${msg}\n   Refusing to start in production with a weak secret.`);
    process.exit(1);
  }
  console.warn(`⚠️  ${msg}`);
}

// Behind a reverse proxy / load balancer (nginx, Cloudflare, Render, …) set
// TRUST_PROXY=1 in .env so req.ip and req.secure reflect the real visitor.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? 1 : /^\d+$/.test(v) ? Number(v) : v);
}
app.disable('x-powered-by');

// ── Security headers ───────────────────────────────────
// (A strict Content-Security-Policy is intentionally NOT set: the pages use
// inline onclick handlers and inline scripts, which a CSP would block.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // dashboard embeds its own pages in iframes
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// ── Sessions ───────────────────────────────────────────
app.use(session({
  name: 'nav.sid',
  store: sessionStore,
  secret: SESSION_SECRET || DEFAULT_DEV_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',  // cookie isn't sent on cross-site POSTs → blocks most CSRF
    secure: 'auto',   // Secure flag automatically when the request came in over HTTPS
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// ── Body parsing ───────────────────────────────────────
// Only the admin Excel bulk-import (Excel file sent as base64 JSON) needs a
// big body, and only for a logged-in admin — auth runs BEFORE the body is
// read, so an anonymous visitor can't make the server buffer 50 MB.
// Every other route gets a small limit.
app.use(
  '/api/admin/fund-static-data/bulk-import',
  requireAuth,
  requireAdmin,
  express.json({ limit: '50mb' })
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// The Rule Engine (NAV Ledger) dashboard — gated by the SAME login as the
// rest of the site. Registered BEFORE the static middleware below, since
// static would otherwise find and serve public/nav-ledger/index.html
// directly (bypassing this auth check) before this route ever ran. Same
// treatment for the two Calendar Year dashboards added alongside it.
app.get(['/nav-ledger', '/nav-ledger/', '/nav-ledger/index.html'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nav-ledger', 'index.html'));
});
app.get('/nav-ledger/calendar-returns.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nav-ledger', 'calendar-returns.html'));
});
app.get('/nav-ledger/calendar-sip-lumpsum.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nav-ledger', 'calendar-sip-lumpsum.html'));
});

// Serve static assets (css/js/images). `index: false` stops express from
// auto-serving public/index.html for "/" so we can gate it behind auth below.
// This also covers public/nav-ledger/* (its own app.js, style.css) — the
// dashboard's HTML itself is gated separately above.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Auth API (public) ─────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Admin-only API (user management, password resets) ─
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

// ── Main API routes (any logged-in user: Admin or User) ─
// Live market routes are registered first so they replace the legacy CSV-backed routes.
app.use('/api', requireAuth, marketDataRoutes);
app.use('/api', requireAuth, navRoutes);
app.use('/api', requireAuth, syncRoutes);
app.use('/api', requireAuth, ruleEngineRoutes);
app.use('/api', requireAuth, staticFundDataRoutes);

// ── NAV Ledger ("Rule Engine") — its dashboard is mounted here, but it
// shares THIS project's login/session/admin panel entirely. No separate
// auth of its own anymore — requireAuth below is the exact same session
// check used for the rest of the site. Must be registered before the
// catch-all SPA route below, or every request here would just get served
// this project's own index.html instead.
app.use('/nav-ledger-api', requireAuth, navLedgerRouter);

// ── Pages ──────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/rule-engine', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rule-engine.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the main HTML for all other routes (SPA) — still requires login
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ──────────────────────────────────────
// Without this, Express answers errors (oversized body, malformed JSON, a
// thrown exception) with an HTML page that includes a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[server] Unhandled error:', err);

  let message = 'Internal server error.';
  if (err.type === 'entity.too.large') message = 'Request body is too large.';
  else if (err.type === 'entity.parse.failed') message = 'Invalid JSON in request body.';
  else if (status < 500) message = 'Bad request.';

  const wantsJson = req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/nav-ledger-api/');
  if (wantsJson) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

app.listen(PORT, () => {
  console.log(`\n🚀 NAV Dashboard running at http://localhost:${PORT}\n`);
  console.log(`🔐 Login page: http://localhost:${PORT}/login`);
  console.log(`🧮 Rule Engine (same login): http://localhost:${PORT}/nav-ledger\n`);

  // Auto-sync: once per server start, fill in any missing/stale Returns +
  // Rolling Returns in the background so scheme modals open instantly.
  // This only (re)computes schemes that are missing or >24h old — after
  // the first full run this is fast. Use the "Sync" button in the UI to
  // force a full refresh on demand.
  const AUTO_SYNC_DELAY_MS = Number(process.env.AUTO_SYNC_DELAY_MS || 1000);
  setTimeout(() => {
    console.log('🔄 Starting background Returns/Rolling-Returns sync (incremental)…');
    syncService.runSync({ force: false })
      .then(status => {
        console.log(`   Sync queued: ${status.total} scheme(s) to process (${status.skipped} already fresh).`);
      })
      .catch(err => {
        console.error('   Background sync failed to start:', err.message);
      });
  }, AUTO_SYNC_DELAY_MS);

  // Full re-sync of EVERY scheme, automatically, once a day at 9:00 PM
  // (server local time), for as long as this process keeps running.
  // Override the time via env vars if needed, e.g. AUTO_SYNC_DAILY_HOUR=22.
  const DAILY_SYNC_HOUR = Number(process.env.AUTO_SYNC_DAILY_HOUR ?? 21);
  const DAILY_SYNC_MINUTE = Number(process.env.AUTO_SYNC_DAILY_MINUTE ?? 0);
  syncService.scheduleDailyFullSync({ hour: DAILY_SYNC_HOUR, minute: DAILY_SYNC_MINUTE });

  // NAV Ledger's own warm-up (pre-computes CAGR + Rolling Returns for every
  // scheme in its dataset) and its own daily 9:30 PM AMFI refresh — fully
  // independent of this project's sync above.
  navLedgerRouter.init();
});