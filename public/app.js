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
            wsStatus:  'connecting'
        },
        bus: new EventTarget(),
        currentView: null
    };

    // ── Audio: bind events that dispatch to bus ────────────────────────────
    function bindAudio() {
        App.audio = document.getElementById('audio-music');
        App.tts   = document.getElementById('audio-tts');

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

    // ── Apply a new track: set audio src + fire bus events ─────────────────
    function applyTrack(track, djSay) {
        if (!track?.audioUrl) return;
        App.state.track = {
            name:     track.name,
            artist:   track.artist,
            coverUrl: track.coverUrl,
            songId:   track.id || ''
        };
        if (djSay !== undefined) App.state.djSay = djSay;

        App.audio.src = track.audioUrl;
        App.audio.play().catch(() => {});

        ClaudioAudio.save({
            src:         track.audioUrl,
            currentTime: 0,
            isPlaying:   true,
            track:       App.state.track,
            djSay:       djSay ?? App.state.djSay
        });

        App.bus.dispatchEvent(new CustomEvent('state:track', { detail: App.state.track }));
        if (djSay) App.bus.dispatchEvent(new CustomEvent('state:dj', { detail: djSay }));
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
                const { track } = await res.json();
                applyTrack(track);
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
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: '正在为你思考…' }));
                App.ws.send(JSON.stringify({ action: 'play' }));
            }
        },
        next() {
            App.audio.pause();
            App.tts?.pause();
            if (App.ws?.readyState === WebSocket.OPEN) {
                App.bus.dispatchEvent(new CustomEvent('state:status', { detail: '换歌中…' }));
                App.ws.send(JSON.stringify({ action: 'next' }));
            }
        },
        seek(pct) {
            if (!App.audio.duration) return;
            App.audio.currentTime = pct * App.audio.duration;
        },
        applyTrack  // exposed so view modules can apply external picks if needed
    };

    // ── WebSocket: single connection, route messages to bus ────────────────
    function bootWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        App.ws = new WebSocket(`${proto}//${location.host}/stream`);

        App.ws.onopen = () => {
            App.state.wsStatus = 'connected';
            App.bus.dispatchEvent(new CustomEvent('state:status', { detail: '已连接，准备就绪' }));
        };
        App.ws.onclose = () => {
            App.state.wsStatus = 'closed';
            App.bus.dispatchEvent(new CustomEvent('state:status', { detail: '连接断开，请刷新' }));
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
            if (data.type === 'now-playing') handleNowPlaying(data);
        };
    }

    function handleNowPlaying(data) {
        const { track, dj } = data;
        if (!track?.audioUrl) return;

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
                track: App.state.track, djSay: dj?.say || ''
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

        App.state.track = s.track;
        App.state.djSay = s.djSay || '';

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

    // ── Boot ───────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        bindAudio();
        bootWebSocket();
        restoreFromState();
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
