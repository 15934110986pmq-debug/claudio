const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class StateMemory {
    constructor() {
        this.db = new sqlite3.Database(path.join(__dirname, '../../../data/claudio.db'));
        this.init();
    }

    init() {
        this.db.serialize(() => {
            this.db.run(`CREATE TABLE IF NOT EXISTS history (
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
        });
    }

    async saveMessage(role, content) {
        return new Promise((resolve, reject) => {
            this.db.run('INSERT INTO history (role, content) VALUES (?, ?)', [role, content], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async savePlay(song) {
        return new Promise((resolve, reject) => {
            this.db.run('INSERT INTO plays (song_id, song_name, artist) VALUES (?, ?, ?)', 
                [song.id, song.name, song.artist], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = new StateMemory();
