const fs = require('fs');
const path = require('path');
const session = require('express-session');

const SESSIONS_FILE = path.join(__dirname, '../../data/sessions.json');

class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = this.load();
  }

  load() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (err) {
      console.error('[sessionStore] Failed to load sessions:', err.message);
    }
    return {};
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
      const tempFile = `${SESSIONS_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(this.sessions), 'utf8');
      fs.renameSync(tempFile, SESSIONS_FILE);
    } catch (err) {
      console.error('[sessionStore] Failed to persist sessions:', err.message);
    }
  }

  get(sid, callback) {
    const record = this.sessions[sid];
    if (!record) return callback(null, null);

    const expiresAt = record.cookie && record.cookie.expires
      ? new Date(record.cookie.expires).getTime()
      : null;
    if (expiresAt && expiresAt <= Date.now()) {
      delete this.sessions[sid];
      this.persist();
      return callback(null, null);
    }

    callback(null, record);
  }

  set(sid, sessionData, callback) {
    this.sessions[sid] = sessionData;
    this.persist();
    if (callback) callback(null);
  }

  touch(sid, sessionData, callback) {
    if (this.sessions[sid]) {
      this.sessions[sid].cookie = sessionData.cookie;
      this.persist();
    }
    if (callback) callback(null);
  }

  destroy(sid, callback) {
    delete this.sessions[sid];
    this.persist();
    if (callback) callback(null);
  }
}

module.exports = new FileSessionStore();