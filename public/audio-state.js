// Shared playback state persistence — used by both the full Player and the
// Library mini-player so audio can continue across page navigation.
//
// Browsers tear down <audio> elements on full page load, so we save the
// playback position to localStorage and the receiving page seeks to it.

(function () {
    const KEY = 'claudio:audio';
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

    window.ClaudioAudio = { save, load, clear };
})();
