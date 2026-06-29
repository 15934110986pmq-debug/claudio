// app.js — SPA shell. Owns shared audio + WebSocket + state + router.
// Each view's UI logic lives in view-{name}.js and subscribes to App.bus.

(function () {
    const ROUTES = {
        '/':            'player',
        '/index.html':  'player',
        '/library':     'library',
        '/library.html':'library',
        '/stack':       'stack',
        '/stack.html':  'stack'
    };
    const VIEW_TITLES = {
        player:  'Claudio',
        library: 'Claudio — Library',
        stack:   'Claudio — Stack'
    };

    const App = {
        audio: null,    // music element (shared)
        tts:   null,    // DJ TTS element (shared)
        ws:    null,
        state: {
            track:     null,   // {name, artist, coverUrl, songId}
            isPlaying: false,
            djSay:     '',
            djReason:  '',     // user-facing "why this song" line
            wsStatus:  'connecting',
            novelty:   50
        },
        bus: new EventTarget(),
        currentView: null
    };

    // ── Audio: bind events that dispatch to bus ────────────────────────────
    function bindAudio() {
        App.audio = document.getElementById('audio-music');
        App.tts   = document.getElementById('audio-tts');

        // Restore preferred volume (persisted, no TTL) — applies to both the
        // music element and the DJ TTS so they share a single perceived level.
        const savedVolume = ClaudioAudio.getPref('volume', 1);
        applyVolume(savedVolume, false);

        // Restore novelty preference (persisted, no TTL)
        App.state.novelty = ClaudioAudio.getPref('novelty', 50);

        let lastSave = 0;
        App.audio.addEventListener('timeupdate', () => {
            if (!App.audio.duration) return;
            App.bus.dispatchEvent(new CustomEvent('state:progress', {
                detail: {
                    currentTime: App.audio.currentTime,
                    duration:    App.audio.duration,
                    pct:         App.audio.currentTime / App.audio.duration
                }
            }));
            const now = Date.now();
            if (now - lastSave > 1500) {
                lastSave = now;
                ClaudioAudio.save({ currentTime: App.audio.currentTime });
            }
        });
        App.audio.addEventListener('play',  () => setPlaying(true));
        App.audio.addEventListener('pause', () => setPlaying(false));
        App.audio.addEventListener('ended', () => App.actions.next());

        window.addEventListener('pagehide', () => {
            ClaudioAudio.save({
                currentTime: App.audio.currentTime,
                isPlaying:   !App.audio.paused
            });
        });
    }

    function setPlaying(isPlaying) {
        App.state.isPlaying = isPlaying;
        App.bus.dispatchEvent(new CustomEvent('state:play', { detail: isPlaying }));
        ClaudioAudio.save({ isPlaying });
    }

    function applyVolume(v, persist = true) {
        const next = Math.max(0, Math.min(1, Number(v) || 0));
        if (App.audio) App.audio.volume = next;
        if (App.tts)   App.tts.volume   = next;
        App.state.volume = next;
        if (persist) ClaudioAudio.setPref('volume', next);
        App.bus.dispatchEvent(new CustomEvent('state:volume', { detail: next }));
    }

    // ── Apply a new track: set audio src + fire bus events ─────────────────
    function applyTrack(track, djSay, djReason) {
        if (!track?.audioUrl) return;
        App.state.track = {
            name:     track.name,
            artist:   track.artist,
            coverUrl: track.coverUrl,
            songId:   track.id || ''
        };
        if (djSay    !== undefined) App.state.djSay    = djSay;
        if (djReason !== undefined) App.state.djReason = djReason;

        App.audio.src = track.audioUrl;
        App.audio.play().catch(() => {});

        ClaudioAudio.save({
            src:         track.audioUrl,
            currentTime: 0,
            isPlaying:   true,
            track:       App.state.track,
            djSay:       djSay    ?? App.state.djSay,
            djReason:    djReason ?? App.state.djReason
        });

        App.bus.dispatchEvent(new CustomEvent('state:track', { detail: App.state.track }));
        if (djSay)    App.bus.dispatchEvent(new CustomEvent('state:dj',     { detail: djSay }));
        if (djReason !== undefined) {
            App.bus.dispatchEvent(new CustomEvent('state:reason', { detail: djReason }));
        }
    }

    // ── Actions exposed to view modules ────────────────────────────────────
    App.actions = {
        async playByName(song_name, artist, song_id) {
            try {
                const res = await fetch('/api/play', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_name, artist, song_id })
                });
                if (!res.ok) {
                    const e = await res.json().catch(() => ({}));
                    throw new Error(e.error || `HTTP ${res.status}`);
                }
                const { track, isLoved } = await res.json();
                applyTrack(track);
                App.state.isLoved = !!isLoved;
                App.bus.dispatchEvent(new CustomEvent('state:love', { detail: App.state.isLoved }));
                return track;
            } catch (err) {
                console.error('[App] playByName:', err.message);
                throw err;
            }
        },
        togglePlayPause() {
            if (App.audio.paused) App.audio.play().catch(() => {});
            else App.audio.pause();
        },
        play() {
            if (App.audio.src) {
                App.audio.play().catch(() => {});
            } else if (App.ws?.readyState === WebSocket.OPEN) {
                const msg = window.ClaudioI18n?.t('player.status.thinking') || '正在为你思考…';
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: msg }));
                App.ws.send(JSON.stringify({ action: 'play', novelty: App.state.novelty }));
            }
        },
        next() {
            App.audio.pause();
            App.tts?.pause();
            if (App.ws?.readyState === WebSocket.OPEN) {
                const msg = window.ClaudioI18n?.t('player.status.switching') || '换歌中…';
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: msg }));
                App.ws.send(JSON.stringify({ action: 'next', novelty: App.state.novelty }));
            }
        },
        prev() {
            App.audio.pause();
            App.tts?.pause();
            if (App.ws?.readyState === WebSocket.OPEN) {
                const msg = window.ClaudioI18n?.t('player.status.prev') || '回到上一首…';
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: msg }));
                App.ws.send(JSON.stringify({ action: 'prev' }));
            }
        },
        seek(pct) {
            if (!App.audio.duration) return;
            App.audio.currentTime = pct * App.audio.duration;
        },
        getVolume() { return App.state.volume ?? App.audio?.volume ?? 1; },
        setVolume(v) { applyVolume(v); },
        getNovelty() { return App.state.novelty ?? 50; },
        setNovelty(v) {
            const n = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
            App.state.novelty = n;
            ClaudioAudio.setPref('novelty', n);
            App.bus.dispatchEvent(new CustomEvent('state:novelty', { detail: n }));
        },
        applyTrack  // exposed so view modules can apply external picks if needed
    };

    // ── WebSocket: single connection, route messages to bus ────────────────
    function bootWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        App.ws = new WebSocket(`${proto}//${location.host}/stream`);

        App.ws.onopen = () => {
            App.state.wsStatus = 'connected';
            const msg = window.ClaudioI18n?.t('player.status.connected') || '已连接，准备就绪';
            App.bus.dispatchEvent(new CustomEvent('state:status', { detail: msg }));
        };
        App.ws.onclose = () => {
            App.state.wsStatus = 'closed';
            const msg = window.ClaudioI18n?.t('player.status.disconnected') || '连接断开，请刷新';
            App.bus.dispatchEvent(new CustomEvent('state:status', { detail: msg }));
        };
        App.ws.onmessage = (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch { return; }

            if (data.type === 'status') {
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: data.message }));
                return;
            }
            if (data.type === 'error') {
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: '⚠ ' + data.message }));
                return;
            }
            if (data.type === 'dj-stream-delta') {
                App.bus.dispatchEvent(new CustomEvent('state:stream-delta', { detail: data.text }));
                return;
            }
            if (data.type === 'dj-stream-end') {
                App.bus.dispatchEvent(new CustomEvent('state:stream-end'));
                return;
            }
            if (data.type === 'now-playing') handleNowPlaying(data);
        };
    }

    function handleNowPlaying(data) {
        const { track, dj, isLoved } = data;
        if (!track?.audioUrl) return;

        // Always reset reason when a new track arrives; views listen on
        // state:reason so the explanation stays in sync with the cover.
        App.state.djReason = dj?.reason || '';
        App.bus.dispatchEvent(new CustomEvent('state:reason', { detail: App.state.djReason }));

        // Sync persisted love state — server is the source of truth, so the
        // heart icon reflects the actual feedback log, not stale local state.
        App.state.isLoved = !!isLoved;
        App.bus.dispatchEvent(new CustomEvent('state:love', { detail: App.state.isLoved }));

        // TTS first (if any), then start music. Both elements are shared,
        // so the DJ voice plays uniformly regardless of which view is active.
        if (dj?.ttsUrl) {
            App.tts.src = dj.ttsUrl;
            App.tts.play().catch(() => {});
            // Apply track immediately so UI updates while TTS plays;
            // pause the music until TTS finishes.
            App.state.track = {
                name: track.name, artist: track.artist,
                coverUrl: track.coverUrl, songId: track.id || ''
            };
            App.state.djSay = dj?.say || '';
            App.bus.dispatchEvent(new CustomEvent('state:track', { detail: App.state.track }));
            if (dj?.say) App.bus.dispatchEvent(new CustomEvent('state:dj', { detail: dj.say }));

            App.audio.src = track.audioUrl;
            App.audio.pause();
            App.tts.onended = () => {
                App.audio.play().catch(() => {});
            };
            ClaudioAudio.save({
                src: track.audioUrl, currentTime: 0, isPlaying: true,
                track: App.state.track, djSay: dj?.say || '',
                djReason: App.state.djReason
            });
        } else {
            applyTrack(track, dj?.say);
        }

        // Tell library/stack to refresh their listings
        App.bus.dispatchEvent(new CustomEvent('library:refresh'));
    }

    // ── Restore from localStorage on page load ─────────────────────────────
    function restoreFromState() {
        const s = ClaudioAudio.load();
        if (!s || !s.src || !s.track) return;

        App.state.track    = s.track;
        App.state.djSay    = s.djSay    || '';
        App.state.djReason = s.djReason || '';

        App.audio.src = s.src;
        App.audio.addEventListener('loadedmetadata', () => {
            if (typeof s.currentTime === 'number' && s.currentTime > 0) {
                try { App.audio.currentTime = s.currentTime; } catch {}
            }
        }, { once: true });

        if (s.isPlaying) App.audio.play().catch(() => {});

        // Notify views once they init
        setTimeout(() => {
            App.bus.dispatchEvent(new CustomEvent('state:track', { detail: App.state.track }));
            if (App.state.djSay) {
                App.bus.dispatchEvent(new CustomEvent('state:dj', { detail: App.state.djSay }));
            }
            if (App.state.djReason) {
                App.bus.dispatchEvent(new CustomEvent('state:reason', { detail: App.state.djReason }));
            }
        }, 0);
    }

    // ── Router ─────────────────────────────────────────────────────────────
    function routeFromPath(path) {
        return ROUTES[path] || 'player';
    }

    function navigateTo(view, push = true) {
        if (!view || view === App.currentView) {
            if (push) updateUrl(view);
            return;
        }

        const apply = () => {
            App.currentView = view;
            // Toggle .is-active on view containers
            document.querySelectorAll('.view').forEach(el => el.classList.remove('is-active'));
            const activeEl = document.getElementById(`view-${view}`);
            if (activeEl) activeEl.classList.add('is-active');

            // Swap which view stylesheet is enabled — body bg + view's :root vars
            ['player', 'library', 'stack'].forEach(v => {
                const link = document.getElementById(`css-${v}`);
                if (link) link.disabled = (v !== view);
            });

            document.title = VIEW_TITLES[view] || 'Claudio';

            // Notify the view module
            const handler = window[`View${cap(view)}`];
            handler?.show?.();

            App.bus.dispatchEvent(new CustomEvent('view:change', { detail: view }));
        };

        if (document.startViewTransition) {
            document.startViewTransition(apply);
        } else {
            apply();
        }

        if (push) updateUrl(view);
    }

    function updateUrl(view) {
        // Pick the canonical URL for this view
        const path = view === 'library' ? '/library'
                   : view === 'stack'   ? '/stack'
                   : '/';
        if (location.pathname !== path) {
            history.pushState({ view }, '', path);
        }
    }

    function initRouter() {
        window.addEventListener('popstate', () => {
            navigateTo(routeFromPath(location.pathname), false);
        });

        // Intercept same-origin link clicks that match a SPA route
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (!link) return;
            if (link.target === '_blank' || link.hasAttribute('download')) return;
            if (link.hasAttribute('data-external')) return;

            const href = link.getAttribute('href');
            if (!href) return;
            if (!href.startsWith('/') || href.startsWith('//')) return;

            const view = ROUTES[href];
            if (view !== undefined) {
                e.preventDefault();
                navigateTo(view, true);
            }
        });
    }

    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    // ── Media Session — populate device lock-screen Now Playing UI and wire
    // hardware media keys to our actions. No-op silently if the browser doesn't
    // support it (older WebKit / Firefox < 82 etc).
    function setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const updateMetadata = (track) => {
            if (!track) return;
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title:   track.name   || 'Claudio',
                    artist:  track.artist || 'Claudio AI DJ',
                    album:   'Claudio',
                    artwork: track.coverUrl ? [
                        { src: track.coverUrl, sizes: '256x256', type: 'image/jpeg' },
                        { src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' }
                    ] : []
                });
            } catch (e) {
                // Some browsers throw on bad artwork — clear metadata and retry without it
                try { navigator.mediaSession.metadata = new MediaMetadata({
                    title:  track.name   || 'Claudio',
                    artist: track.artist || 'Claudio AI DJ',
                    album:  'Claudio'
                }); } catch {}
            }
        };

        // Initial metadata if a track is already loaded (e.g. after page restore)
        if (App.state.track) updateMetadata(App.state.track);

        App.bus.addEventListener('state:track', (e) => updateMetadata(e.detail));

        // Hardware media keys + lock-screen buttons → App.actions
        const safe = (fn) => { try { fn?.(); } catch (e) { console.warn('[MediaSession]', e.message); } };
        navigator.mediaSession.setActionHandler('play',           () => safe(() => App.actions.play()));
        navigator.mediaSession.setActionHandler('pause',          () => safe(() => App.actions.togglePlayPause()));
        navigator.mediaSession.setActionHandler('nexttrack',      () => safe(() => App.actions.next()));
        navigator.mediaSession.setActionHandler('previoustrack',  () => safe(() => App.actions.prev?.()));
        // No seekto / seekforward / seekbackward — Claudio doesn't support that.
        // Browser will fall back to gray-out icons gracefully.

        // Keep playback state in sync (some platforms use this to choose icons)
        App.bus.addEventListener('state:play', (e) => {
            navigator.mediaSession.playbackState = e.detail ? 'playing' : 'paused';
        });

        // Position state (optional but helps iOS show the scrubber on lock screen)
        App.bus.addEventListener('state:progress', (e) => {
            try {
                if (navigator.mediaSession.setPositionState && e.detail.duration) {
                    navigator.mediaSession.setPositionState({
                        duration: e.detail.duration,
                        playbackRate: 1,
                        position: e.detail.currentTime
                    });
                }
            } catch { /* throws on some browsers when duration is 0 */ }
        });
    }

    // ── Boot ───────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        bindAudio();
        bootWebSocket();
        restoreFromState();
        setupMediaSession();
        initRouter();

        const ctx = {
            audio:   App.audio,
            tts:     App.tts,
            ws:      App.ws,
            state:   App.state,
            bus:     App.bus,
            actions: App.actions
        };

        // Init each view module (they query DOM, subscribe to bus, but don't render now)
        window.ViewPlayer?.init?.(ctx);
        window.ViewLibrary?.init?.(ctx);
        window.ViewStack?.init?.(ctx);

        // Show the view that matches the current URL
        navigateTo(routeFromPath(location.pathname), false);
    });

    window.ClaudioApp = App;
})();
