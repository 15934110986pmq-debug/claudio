const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = path.join(__dirname, '../../../data/claudio.db');
fs.ensureDirSync(path.dirname(DB_PATH));

const DEFAULT_USER_ID = 1;

class StateMemory {
    constructor() {
        this.db = new sqlite3.Database(DB_PATH);
        this._ready = this._init().then(() => this._seedDefault());
    }

    _init() {
        return new Promise((resolve) => {
            this.db.serialize(() => {
                this.db.run(`CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    role TEXT,
                    content TEXT
                )`);
                this.db.run(`CREATE TABLE IF NOT EXISTS plays (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    song_id TEXT,
                    song_name TEXT,
                    artist TEXT,
                    cover_url TEXT
                )`);
                // Migrate older dbs that pre-date cover_url. SQLite throws
                // "duplicate column name" if it already exists — we ignore.
                this.db.run(`ALTER TABLE plays ADD COLUMN cover_url TEXT`, () => {});
                this.db.run(`CREATE TABLE IF NOT EXISTS plan (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT UNIQUE,
                    content TEXT
                )`);
                // Feedback events — append-only log. Latest event per (song_id, kind)
                // wins for read queries; explicit unlove rows let us toggle without
                // deleting history. position_pct (0–1) captures how far into the song
                // a skip happened, so we can later weight early skips as stronger
                // negative signal than late skips.
                this.db.run(`CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    song_id TEXT,
                    song_name TEXT,
                    artist TEXT,
                    type TEXT,
                    position_pct REAL
                )`);
                this.db.run(
                    `CREATE INDEX IF NOT EXISTS idx_feedback_song_type ON feedback(song_id, type, timestamp DESC)`
                );
                this.db.run(`CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    email         TEXT UNIQUE NOT NULL,
                    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                    onboarded_at  DATETIME
                )`);
                this.db.run(`CREATE TABLE IF NOT EXISTS magic_links (
                    token       TEXT PRIMARY KEY,
                    email       TEXT NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at  DATETIME NOT NULL,
                    used_at     DATETIME
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at)`);
                this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
                    token       TEXT PRIMARY KEY,
                    user_id     INTEGER NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at  DATETIME NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
                // Per-user isolation: add user_id columns to the three owned tables.
                // "duplicate column name" is silently swallowed like cover_url above.
                this.db.run(`ALTER TABLE plays    ADD COLUMN user_id INTEGER`, () => {});
                this.db.run(`ALTER TABLE messages ADD COLUMN user_id INTEGER`, () => {});
                this.db.run(`ALTER TABLE feedback ADD COLUMN user_id INTEGER`, () => {});
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plays_user    ON plays(user_id, timestamp DESC)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, timestamp DESC)`);
                this.db.run(
                    `CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, timestamp DESC)`
                );
                this.db.run(`CREATE TABLE IF NOT EXISTS user_taste (
                    user_id        INTEGER PRIMARY KEY,
                    artists_love   TEXT,
                    artists_avoid  TEXT,
                    time_prefs     TEXT,
                    mood_seeds     TEXT,
                    weather_city   TEXT,
                    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);
                this.db.run(`CREATE TABLE IF NOT EXISTS llm_quota (
                    user_id    INTEGER NOT NULL,
                    day        TEXT NOT NULL,
                    count      INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, day)
                )`);
                // Migrate: add persona column to user_taste (idempotent — silent on duplicate)
                this.db.run(`ALTER TABLE user_taste ADD COLUMN persona TEXT`, () => {});
                // Migrate: add auto_evolve opt-in flag (idempotent — silent on duplicate)
                this.db.run(`ALTER TABLE user_taste ADD COLUMN auto_evolve INTEGER DEFAULT 0`, () => {});
                // Migrate: shareable taste profile — slug + visibility flag
                this.db.run(`ALTER TABLE user_taste ADD COLUMN share_slug TEXT`, () => {});
                this.db.run(`ALTER TABLE user_taste ADD COLUMN share_public INTEGER DEFAULT 0`, () => {});
                this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_taste_slug ON user_taste(share_slug) WHERE share_slug IS NOT NULL`);
                // Snapshot history — written before every saveUserTaste call so rollback is always possible.
                this.db.run(`CREATE TABLE IF NOT EXISTS user_taste_history (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL,
                    snapshot     TEXT NOT NULL,
                    source       TEXT NOT NULL,
                    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);
                this.db.run(
                    `CREATE INDEX IF NOT EXISTS idx_taste_history_user ON user_taste_history(user_id, created_at DESC)`
                );
                // User-authored custom DJ personas
                this.db.run(`CREATE TABLE IF NOT EXISTS user_custom_personas (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id     INTEGER NOT NULL,
                    name        TEXT NOT NULL,
                    prompt_md   TEXT NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_custom_personas_user ON user_custom_personas(user_id)`);
                this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_personas_user_name ON user_custom_personas(user_id, name)`);
                // WebPush subscriptions — one row per browser endpoint, per user.
                this.db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint    TEXT PRIMARY KEY,
                    user_id     INTEGER NOT NULL,
                    p256dh      TEXT NOT NULL,
                    auth        TEXT NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`);
                this.db.run('SELECT 1', resolve);
            });
        });
    }

    async _seedDefault() {
        // Idempotent: INSERT OR IGNORE creates the default user only on first boot.
        await this._run(
            `INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`,
            [DEFAULT_USER_ID, 'default@local']
        );
        // Backfill: any pre-existing row with NULL user_id belongs to the default
        // user. Safe to run every boot — only touches NULLs.
        await this._run(`UPDATE plays    SET user_id = ? WHERE user_id IS NULL`, [DEFAULT_USER_ID]);
        await this._run(`UPDATE messages SET user_id = ? WHERE user_id IS NULL`, [DEFAULT_USER_ID]);
        await this._run(`UPDATE feedback SET user_id = ? WHERE user_id IS NULL`, [DEFAULT_USER_ID]);
    }

    _run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err); else resolve(this);
            });
        });
    }

    _all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    async saveMessage(role, content, userId = DEFAULT_USER_ID) {
        await this._ready;
        await this._run(
            'INSERT INTO messages (role, content, user_id) VALUES (?, ?, ?)',
            [role, content, userId]
        );
    }

    async savePlay(song, userId = DEFAULT_USER_ID) {
        await this._ready;
        await this._run(
            'INSERT INTO plays (song_id, song_name, artist, cover_url, user_id) VALUES (?, ?, ?, ?, ?)',
            [song.id || '', song.name, song.artist, song.coverUrl || '', userId]
        );
    }

    async getRecentPlays(limit = 10, userId = DEFAULT_USER_ID) {
        await this._ready;
        return this._all(
            'SELECT song_id, song_name, artist, cover_url, timestamp FROM plays WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?',
            [userId, limit]
        );
    }

    async getAllPlays(limit = 500, userId = DEFAULT_USER_ID) {
        await this._ready;
        return this._all(
            'SELECT song_id, song_name, artist, cover_url, timestamp FROM plays WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?',
            [userId, limit]
        );
    }

    async getRecentMessages(limit = 6, userId = DEFAULT_USER_ID) {
        await this._ready;
        return this._all(
            'SELECT role, content, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?',
            [userId, limit]
        );
    }

    async savePlan(date, content) {
        await this._ready;
        await this._run(
            'INSERT INTO plan (date, content) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET content=excluded.content',
            [date, content]
        );
    }

    async getPlan(date) {
        await this._ready;
        const rows = await this._all('SELECT content FROM plan WHERE date = ?', [date]);
        return rows[0]?.content || null;
    }

    // ── Feedback ─────────────────────────────────────────────────────────
    // type: 'love' | 'unlove' | 'skip' | 'down'
    async saveFeedback({ song_id, song_name, artist, type, position_pct = null, user_id = DEFAULT_USER_ID }) {
        await this._ready;
        if (!type) throw new Error('feedback type required');
        await this._run(
            `INSERT INTO feedback (song_id, song_name, artist, type, position_pct, user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [song_id || '', song_name || '', artist || '', type, position_pct, user_id]
        );
    }

    // True iff the latest love/unlove event for this song is a love. Skip and
    // down don't affect love state — they're separate signals to the brain.
    async isSongLoved(song_id, userId = DEFAULT_USER_ID) {
        await this._ready;
        if (!song_id) return false;
        const rows = await this._all(
            `SELECT type FROM feedback
             WHERE song_id = ? AND user_id = ? AND type IN ('love','unlove')
             ORDER BY timestamp DESC LIMIT 1`,
            [song_id, userId]
        );
        return rows[0]?.type === 'love';
    }

    // Recent artists for anti-bubble exclusion. Returns distinct artist names
    // played within the last N days, lowercased + trimmed for fuzzy matching.
    async getRecentArtists(days = 30, limit = 200, userId = DEFAULT_USER_ID) {
        await this._ready;
        const rows = await this._all(
            `SELECT DISTINCT TRIM(LOWER(artist)) AS a
             FROM plays
             WHERE artist != '' AND user_id = ? AND timestamp > datetime('now', ?)
             ORDER BY timestamp DESC
             LIMIT ?`,
            [userId, `-${days} days`, limit]
        );
        return rows.map(r => r.a).filter(Boolean);
    }

    // Recent loves — for context.js to bias future picks toward similar vibes.
    async getRecentLoves(limit = 20, userId = DEFAULT_USER_ID) {
        await this._ready;
        return this._all(
            `SELECT song_id, song_name, artist, timestamp FROM feedback
             WHERE type = 'love' AND user_id = ?
             ORDER BY timestamp DESC LIMIT ?`,
            [userId, limit]
        );
    }

    // Recent skips/downs — for context.js to avoid repeating mistakes.
    async getRecentDislikes(limit = 30, userId = DEFAULT_USER_ID) {
        await this._ready;
        return this._all(
            `SELECT song_id, song_name, artist, type, position_pct, timestamp
             FROM feedback
             WHERE type IN ('skip','down') AND user_id = ?
             ORDER BY timestamp DESC LIMIT ?`,
            [userId, limit]
        );
    }

    // Look up the Nth most recent play for a user (0 = most recent).
    // Used by the prev-button walker to step backward through play history.
    async getPlayAtOffset(userId, offset = 1) {
        await this._ready;
        const rows = await this._all(
            `SELECT song_id, song_name, artist, cover_url, timestamp
             FROM plays
             WHERE user_id = ?
             ORDER BY timestamp DESC
             LIMIT 1 OFFSET ?`,
            [userId ?? DEFAULT_USER_ID, offset]
        );
        return rows[0] || null;
    }
    // ── Auth ────────────────────────────────────────────────────────────
    async getOrCreateUser(email) {
        await this._ready;
        const normalized = String(email).trim().toLowerCase();
        if (!normalized) throw new Error('email required');
        await this._run('INSERT OR IGNORE INTO users (email) VALUES (?)', [normalized]);
        const rows = await this._all('SELECT id, email, created_at, onboarded_at FROM users WHERE email = ?', [normalized]);
        return rows[0];
    }

    async createMagicLink(email, ttlMinutes = 15) {
        await this._ready;
        const token = require('crypto').randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
        await this._run(
            'INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)',
            [token, String(email).trim().toLowerCase(), expiresAt]
        );
        return { token, expiresAt };
    }

    async consumeMagicLink(token) {
        await this._ready;
        const rows = await this._all(
            `SELECT token, email, expires_at, used_at FROM magic_links WHERE token = ?`,
            [token]
        );
        const link = rows[0];
        if (!link) return { ok: false, reason: 'not_found' };
        if (link.used_at) return { ok: false, reason: 'already_used' };
        if (new Date(link.expires_at) < new Date()) return { ok: false, reason: 'expired' };
        await this._run('UPDATE magic_links SET used_at = CURRENT_TIMESTAMP WHERE token = ?', [token]);
        return { ok: true, email: link.email };
    }

    async createSession(userId, ttlDays = 30) {
        await this._ready;
        const token = require('crypto').randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60_000).toISOString();
        await this._run(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
            [token, userId, expiresAt]
        );
        return { token, expiresAt };
    }

    async getUserBySession(token) {
        await this._ready;
        if (!token) return null;
        const rows = await this._all(
            `SELECT u.id, u.email, u.onboarded_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token = ? AND s.expires_at > datetime('now')`,
            [token]
        );
        return rows[0] || null;
    }

    async deleteSession(token) {
        await this._ready;
        await this._run('DELETE FROM sessions WHERE token = ?', [token]);
    }

    async cleanupExpiredAuth() {
        await this._ready;
        await this._run("DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 day')");
        await this._run("DELETE FROM sessions    WHERE expires_at < datetime('now')");
    }

    // ── User taste (onboarding wizard) ──────────────────────────────────────
    async saveUserTaste(userId, taste) {
        await this._ready;

        // Extract the caller-supplied source tag (not persisted in the taste row itself).
        const source = taste.__source || 'manual';

        // Snapshot the PREVIOUS state so users can always revert.
        const prior = await this.getUserTaste(userId);
        if (prior) {
            await this._run(
                `INSERT INTO user_taste_history (user_id, snapshot, source) VALUES (?, ?, ?)`,
                [userId, JSON.stringify(prior), source]
            );
        }

        const row = {
            artists_love:  JSON.stringify(taste.artistsLove  || []),
            artists_avoid: JSON.stringify(taste.artistsAvoid || []),
            time_prefs:    JSON.stringify(taste.timePrefs    || {}),
            mood_seeds:    JSON.stringify(taste.moodSeeds    || []),
            weather_city:  taste.weatherCity || null,
            persona:       taste.persona     || null
        };
        await this._run(
            `INSERT INTO user_taste (user_id, artists_love, artists_avoid, time_prefs, mood_seeds, weather_city, persona, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
               artists_love  = excluded.artists_love,
               artists_avoid = excluded.artists_avoid,
               time_prefs    = excluded.time_prefs,
               mood_seeds    = excluded.mood_seeds,
               weather_city  = excluded.weather_city,
               persona       = excluded.persona,
               updated_at    = CURRENT_TIMESTAMP`,
            [userId, row.artists_love, row.artists_avoid, row.time_prefs, row.mood_seeds, row.weather_city, row.persona]
        );
        // Mark as onboarded — idempotent if already set.
        await this._run(
            `UPDATE users SET onboarded_at = COALESCE(onboarded_at, CURRENT_TIMESTAMP) WHERE id = ?`,
            [userId]
        );
    }

    async getUserTaste(userId) {
        await this._ready;
        if (!userId) return null;
        const rows = await this._all(
            `SELECT artists_love, artists_avoid, time_prefs, mood_seeds, weather_city, persona, updated_at
             FROM user_taste WHERE user_id = ?`,
            [userId]
        );
        if (!rows[0]) return null;
        const r = rows[0];
        return {
            artistsLove:  JSON.parse(r.artists_love  || '[]'),
            artistsAvoid: JSON.parse(r.artists_avoid || '[]'),
            timePrefs:    JSON.parse(r.time_prefs    || '{}'),
            moodSeeds:    JSON.parse(r.mood_seeds    || '[]'),
            weatherCity:  r.weather_city,
            persona:      r.persona || null,
            updatedAt:    r.updated_at
        };
    }

    async getTasteHistory(userId, limit = 20) {
        await this._ready;
        return this._all(
            `SELECT id, snapshot, source, created_at
             FROM user_taste_history
             WHERE user_id = ?
             ORDER BY created_at DESC LIMIT ?`,
            [userId, limit]
        );
    }

    async getTasteHistoryById(userId, historyId) {
        await this._ready;
        const rows = await this._all(
            `SELECT snapshot FROM user_taste_history WHERE id = ? AND user_id = ?`,
            [historyId, userId]
        );
        return rows[0]?.snapshot || null;
    }

    async setAutoEvolve(userId, enabled) {
        await this._ready;
        // Ensure a user_taste row exists first (auto_evolve column belongs to it).
        const existing = await this.getUserTaste(userId);
        if (!existing) {
            await this.saveUserTaste(userId, { __source: 'manual' });
        }
        await this._run(
            'UPDATE user_taste SET auto_evolve = ? WHERE user_id = ?',
            [enabled ? 1 : 0, userId]
        );
    }

    // Users eligible for weekly taste auto-evolution: onboarded + opted in + min recent feedback.
    async getEvolverCandidates(daysBack = 7, minEvents = 5) {
        await this._ready;
        return this._all(
            `SELECT u.id, u.email
             FROM users u
             JOIN user_taste t ON t.user_id = u.id
             WHERE u.onboarded_at IS NOT NULL
               AND t.auto_evolve = 1
               AND (SELECT COUNT(*) FROM feedback f
                    WHERE f.user_id = u.id
                      AND f.timestamp > datetime('now', ?)) >= ?`,
            [`-${daysBack} days`, minEvents]
        );
    }

    // ── Shareable taste profile ──────────────────────────────────────────────

    async setSharePublic(userId, isPublic) {
        await this._ready;
        let existing = await this.getUserTaste(userId);
        if (!existing) {
            await this.saveUserTaste(userId, { __source: 'manual' });
            existing = await this.getUserTaste(userId) || {};
        }
        const rows = await this._all('SELECT share_slug FROM user_taste WHERE user_id = ?', [userId]);
        let slug = rows[0]?.share_slug;
        if (isPublic && !slug) {
            for (let i = 0; i < 3; i++) {
                const candidate = require('crypto').randomBytes(8).toString('base64url');
                const conflict = await this._all('SELECT 1 FROM user_taste WHERE share_slug = ?', [candidate]);
                if (!conflict.length) { slug = candidate; break; }
            }
            if (!slug) throw new Error('could not generate unique slug');
        }
        await this._run(
            'UPDATE user_taste SET share_slug = ?, share_public = ? WHERE user_id = ?',
            [slug, isPublic ? 1 : 0, userId]
        );
        return { slug, public: !!isPublic };
    }

    async getShareState(userId) {
        await this._ready;
        const rows = await this._all(
            'SELECT share_slug, share_public FROM user_taste WHERE user_id = ?',
            [userId]
        );
        if (!rows[0]) return { slug: null, public: false };
        return { slug: rows[0].share_slug || null, public: !!rows[0].share_public };
    }

    async getTasteBySlug(slug) {
        await this._ready;
        if (!slug) return null;
        const rows = await this._all(
            `SELECT t.artists_love, t.mood_seeds, t.time_prefs, t.updated_at
             FROM user_taste t
             WHERE t.share_slug = ? AND t.share_public = 1`,
            [slug]
        );
        if (!rows[0]) return null;
        const r = rows[0];
        return {
            artistsLove: JSON.parse(r.artists_love || '[]'),
            moodSeeds:   JSON.parse(r.mood_seeds   || '[]'),
            timePrefs:   JSON.parse(r.time_prefs   || '{}'),
            updatedAt:   r.updated_at
            // Deliberately NOT exposing: artistsAvoid, weatherCity, persona, auto_evolve, share_slug
        };
    }

    // ── LLM Quota (daily per-user call limits) ──────────────────────────────
    async incrementQuota(userId) {
        await this._ready;
        const day = new Date().toISOString().slice(0, 10);
        await this._run(
            `INSERT INTO llm_quota (user_id, day, count) VALUES (?, ?, 1)
             ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
            [userId, day]
        );
        const rows = await this._all(
            'SELECT count FROM llm_quota WHERE user_id = ? AND day = ?',
            [userId, day]
        );
        return rows[0]?.count || 0;
    }

    async getQuotaToday(userId) {
        await this._ready;
        const day = new Date().toISOString().slice(0, 10);
        const rows = await this._all(
            'SELECT count FROM llm_quota WHERE user_id = ? AND day = ?',
            [userId, day]
        );
        return rows[0]?.count || 0;
    }
    // ── Custom personas ──────────────────────────────────────────────────────
    async listCustomPersonas(userId) {
        await this._ready;
        if (!userId) return [];
        return this._all(
            `SELECT id, name, updated_at FROM user_custom_personas WHERE user_id = ? ORDER BY updated_at DESC`,
            [userId]
        );
    }

    async getCustomPersona(userId, id) {
        await this._ready;
        const rows = await this._all(
            `SELECT id, name, prompt_md, updated_at FROM user_custom_personas WHERE id = ? AND user_id = ?`,
            [id, userId]
        );
        return rows[0] || null;
    }

    async upsertCustomPersona(userId, { id, name, promptMd }) {
        await this._ready;
        if (!userId) throw new Error('userId required');
        if (!name || !promptMd) throw new Error('name + promptMd required');
        if (name.length > 60)         throw new Error('name too long (max 60)');
        if (promptMd.length > 20_000) throw new Error('prompt too long (max 20K)');
        if (id) {
            const existing = await this.getCustomPersona(userId, id);
            if (!existing) throw new Error('not found');
            await this._run(
                `UPDATE user_custom_personas SET name = ?, prompt_md = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
                [name, promptMd, id, userId]
            );
            return id;
        } else {
            const result = await this._run(
                `INSERT INTO user_custom_personas (user_id, name, prompt_md) VALUES (?, ?, ?)`,
                [userId, name, promptMd]
            );
            return result.lastID;
        }
    }

    async deleteCustomPersona(userId, id) {
        await this._ready;
        await this._run(`DELETE FROM user_custom_personas WHERE id = ? AND user_id = ?`, [id, userId]);
    }

    // ── WebPush subscriptions ─────────────────────────────────────────────────

    async savePushSubscription(userId, sub) {
        await this._ready;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
            throw new Error('invalid subscription');
        }
        await this._run(
            `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
            [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth]
        );
    }

    async deletePushSubscription(endpoint) {
        await this._ready;
        await this._run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    }

    async listPushSubscriptions(userId) {
        await this._ready;
        const where = userId ? 'WHERE user_id = ?' : '';
        const params = userId ? [userId] : [];
        return this._all(
            `SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions ${where}`,
            params
        );
    }
}

const instance = new StateMemory();
instance.DEFAULT_USER_ID = DEFAULT_USER_ID;
module.exports = instance;
