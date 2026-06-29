// Shared playback state persistence — used by both the full Player and the
// Library mini-player so audio can continue across page navigation.
//
// Browsers tear down <audio> elements on full page load, so we save the
// playback position to localStorage and the receiving page seeks to it.
//
// `save`/`load` are for ephemeral playback state (1h TTL — older means the
// session is too stale to restore meaningfully). `getPref`/`setPref` are for
// user preferences (volume etc.) that should never expire.

(function () {
    const KEY = 'claudio:audio';
    const PREFS_KEY = 'claudio:prefs';
    const MAX_AGE_MS = 60 * 60_000;  // 1h — older than this is too stale to restore

    function save(patch) {
        try {
            const prev = load() || {};
            const next = { ...prev, ...patch, updatedAt: Date.now() };
            localStorage.setItem(KEY, JSON.stringify(next));
        } catch { /* quota or disabled — ignore */ }
    }

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (!s || !s.updatedAt) return null;
            if (Date.now() - s.updatedAt > MAX_AGE_MS) return null;
            return s;
        } catch {
            return null;
        }
    }

    function clear() {
        try { localStorage.removeItem(KEY); } catch {}
    }

    function loadPrefs() {
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    function getPref(key, fallback) {
        const p = loadPrefs();
        return (key in p) ? p[key] : fallback;
    }

    function setPref(key, value) {
        try {
            const next = { ...loadPrefs(), [key]: value };
            localStorage.setItem(PREFS_KEY, JSON.stringify(next));
        } catch { /* ignore */ }
    }

    window.ClaudioAudio = { save, load, clear, getPref, setPref };
})();
