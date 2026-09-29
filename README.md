# 📊 AMFI NAV Dashboard

A Node.js dashboard to explore all AMFI Mutual Fund NAVs — with sidebar navigation, search, filters, sorting, and pagination.

---

## 📁 Folder Structure

```
nav-dashboard/
├── data/
│   └── navdata.json          ← Parsed NAV data (all 50 fund houses, 14,169 schemes)
├── src/
│   ├── server.js             ← Express server (entry point)
│   ├── routes/
│   │   └── nav.js            ← API routes (/api/funds, /api/funds/:name, /api/stats)
│   └── public/
│       ├── index.html        ← Single-page dashboard UI
│       ├── css/
│       │   └── style.css     ← All styles
│       └── js/
│           └── app.js        ← Frontend logic (fetch, filter, render)
├── package.json
└── README.md
```

---

## 🚀 Step-by-Step Setup

### Step 1 — Install Node.js
Make sure Node.js (v16 or higher) is installed:
```bash
node -v
```
Download from https://nodejs.org if not installed.

---

### Step 2 — Download / Copy Project Files
Place all files exactly as shown in the folder structure above.

> **Important:** The `data/navdata.json` file must exist before starting the server.  
> It's included in the project — do not delete it.

---

### Step 3 — Install Dependencies
Open terminal in the project root (`nav-dashboard/`) and run:
```bash
npm install
```
This installs:
- `express` — web server
- `nodemon` — auto-restart on file changes (dev only)

---

### Step 4 — Start the Server

**Production / Normal start:**
```bash
npm start
```

**Development (auto-restarts on file save):**
```bash
npm run dev
```

You'll see:
```
🚀 NAV Dashboard running at http://localhost:3000
```

---

### Step 5 — Open in Browser
Visit: **http://localhost:3000**

---

## 🖥️ Features

| Feature | Description |
|---|---|
| **Sidebar** | Lists all 50 fund houses with scheme count |
| **Sidebar Search** | Type to filter fund house names instantly |
| **Scheme Table** | Shows Code, Name, NAV (₹), Date, API link |
| **Search Filter** | Search by scheme name (e.g. "Growth", "Direct") |
| **Min/Max NAV** | Filter schemes by NAV range |
| **Sort** | Sort by NAV high→low, low→high, or Name A→Z, Z→A |
| **Reset** | Clear all filters instantly |
| **Pagination** | 50 schemes per page, smart page buttons |
| **API Links** | Each scheme has a direct link to `api.mfapi.in` |

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/stats` | Total fund houses & schemes count |
| GET | `/api/funds` | List all fund houses with scheme count |
| GET | `/api/funds/:name` | All schemes for a fund house (with filters) |

### Query Parameters for `/api/funds/:name`

| Param | Type | Description | Example |
|---|---|---|---|
| `search` | string | Filter by scheme name | `search=growth` |
| `minNav` | number | Minimum NAV value | `minNav=100` |
| `maxNav` | number | Maximum NAV value | `maxNav=500` |
| `sortBy` | string | Sort order | `nav_asc`, `nav_desc`, `name_asc`, `name_desc` |
| `page` | number | Page number (default: 1) | `page=2` |
| `limit` | number | Results per page (default: 50) | `limit=100` |

**Example:**
```
GET /api/funds/Aditya%20Birla%20Sun%20Life%20Mutual%20Fund?search=growth&sortBy=nav_desc&page=1&limit=50
```

---

## 🔄 Updating NAV Data

When a new `NAVALL.txt` is available (daily update from AMFI), re-run the parser:

```bash
node scripts/parse.js
```

> Create `scripts/parse.js` — copy the Python parsing logic into Node.js, or run the Python script directly.

Or simply replace `data/navdata.json` with a freshly generated file.

---

## 🛠️ Customization

- **Change port:** Set `PORT=4000 npm start` or edit `server.js`
- **Change page size:** Edit `state.limit = 50` in `app.js`
- **Add new columns:** Edit `renderTable()` in `app.js` and add `<th>` in `index.html`

---

## 📦 Dependencies

```json
{
  "express": "^4.18.2",
  "nodemon": "^3.0.1" (dev only)
}
```

No database needed — all data is served from `navdata.json` in memory.

---

## 🔐 Authentication & Roles (NEW)

The dashboard now requires login. Two roles exist:

| Role  | Can view all schemes | Can edit Launch Date | Can manage users / passwords |
|-------|:---:|:---:|:---:|
| **Admin** | ✅ | ✅ | ✅ |
| **User**  | ✅ | ❌ (view-only) | ❌ |

### Default accounts (change these after first login!)

| Username | Password | Role |
|----------|----------|------|
| `admin`  | `admin123` | Admin |
| `user`   | `user123`  | User |

### How it works
- `/login` — sign-in page for everyone.
- `/` — main dashboard (requires login). The Launch Date column shows a ✎ edit button **only for Admins**; Users see a read-only date.
- `/admin` — Admin Console (Admin-only). Here an Admin can:
  - See every user and their role
  - **Reset the password of any user**
  - Create new Admin or User accounts
  - Promote/demote a user's role
  - Delete a user
- A user badge in the top-right corner of the dashboard shows who's logged in, with quick links to the Admin Console (Admins only) and Logout.
- Sessions are cookie-based (`express-session`) and last 8 hours.
- User records live in `data/users.json`, with passwords stored as bcrypt hashes (never in plain text).

### Setup notes
1. Run `npm install` — this installs the two new dependencies: `bcryptjs` and `express-session`.
2. Before deploying anywhere beyond your own machine, open `.env` and replace `SESSION_SECRET` with a long random string.
3. Log in as `admin`, go to **Admin Console → Reset Password**, and change the default `admin`/`user` passwords.

---

## 🧮 Rule Engine (NAV Ledger) — mounted sub-app

Clicking **"🧮 Rule Engine"** on the Home page opens `/nav-ledger/index.html` in a new tab — a
complete, separate mini-app ("NAV Ledger") for SIP / Lumpsum CAGR and Rolling Returns
screening, mounted inside this same project and server process.

It is **fully independent** of the main dashboard above it:

- **Its own login** — its own `username`/`password` accounts, stored in
  `src/nav-ledger/data/users.json` (bcrypt-hashed), completely separate from this
  project's own `data/users.json`. Logging into the main dashboard does **not**
  log you into the Rule Engine, and vice versa.
- **Its own auth mechanism** — JWT tokens (`localStorage`), not the main
  dashboard's session cookies. Configured via the `NAV_LEDGER_JWT_SECRET`
  variable in `.env` (change this to a long random string before deploying,
  same as `SESSION_SECRET` above).
- **Its own dataset** — `src/nav-ledger/data/master.json` / `meta.json`, built
  from MFAPI + AMFI by its own data builder script, entirely separate from this
  project's `data/navdata.json`.
- **Its own admin panel** — an Admin (inside the Rule Engine's own login, not
  this project's) can create/edit/delete Rule Engine user accounts from the
  "🛡 Admin Users" drawer inside `/nav-ledger/index.html`.

### Default Rule Engine accounts

| Username | Role  |
|----------|-------|
| `admin`  | Admin |
| `user`   | User  |

(Passwords were set when this dataset was built — change them from the Rule
Engine's own Admin Users panel after first login, same as the main dashboard.)

### ⚠️ Memory requirement

`src/nav-ledger/data/master.json` stores full daily NAV history for ~14,000+
schemes and is **several hundred MB**. Loading and parsing it comfortably needs
roughly **3–4 GB of free RAM**. To avoid an out-of-memory crash on smaller
servers, `npm start` / `npm run dev` already launch Node with
`--max-old-space-size=4096`. If you deploy on a host with less than ~4 GB of
RAM available to this process, either upgrade the host or reduce
`YEARS`/history length in `src/nav-ledger/scripts/build-data.js` and rebuild.

### Rebuilding the Rule Engine's dataset

```bash
npm run nav-ledger:build-data
```

This re-fetches the MFAPI catalogue + AMFI metadata and rewrites
`src/nav-ledger/data/master.json` and `meta.json`. It also runs automatically
once a day at **9:30 PM IST** (offset half an hour from the main dashboard's
own 9:00 PM full sync, so the two independent data pipelines never compete for
CPU/network at the same moment).

### Routes this adds

| Route | Purpose |
|---|---|
| `/nav-ledger/index.html` | Rule Engine dashboard (requires its own login) |
| `/nav-ledger/login.html` | Rule Engine sign-in page |
| `/nav-ledger-api/*` | Rule Engine's API (auth, meta, schemes, rule-engine, admin/users) — namespaced separately from this project's own `/api/*` so nothing collides |

