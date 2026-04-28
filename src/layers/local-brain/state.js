const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = path.join(__dirname, '../../../data/claudio.db');
fs.ensureDirSync(path.dirname(DB_PATH));

class StateMemory {
    constructor() {
        this.db = new sqlite3.Database(DB_PATH);
        this._ready = this._init();
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
                    artist TEXT
                )`);
                this.db.run(`CREATE TABLE IF NOT EXISTS plan (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT UNIQUE,
                    content TEXT
                )`, resolve);
            });
        });
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

    async saveMessage(role, content) {
        await this._ready;
        await this._run('INSERT INTO messages (role, content) VALUES (?, ?)', [role, content]);
    }

    async savePlay(song) {
        await this._ready;
        await this._run(
            'INSERT INTO plays (song_id, song_name, artist) VALUES (?, ?, ?)',
            [song.id || '', song.name, song.artist]
        );
    }

    async getRecentPlays(limit = 10) {
        await this._ready;
        return this._all(
            'SELECT song_name, artist, timestamp FROM plays ORDER BY timestamp DESC LIMIT ?',
            [limit]
        );
    }

    async getRecentMessages(limit = 6) {
        await this._ready;
        return this._all(
            'SELECT role, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?',
            [limit]
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
}

module.exports = new StateMemory();
