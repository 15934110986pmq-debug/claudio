// view-player.js — Player view module.
// Listens to shared App.bus for state changes; binds buttons to App.actions.

(function () {
    let ctx = null;
    let initialized = false;
    let root, titleEl, artistEl, coverImg, albumArt, lyricsTrack,
        playBtn, playIcon, prevBtn, nextBtn, heart, statusText,
        progressBar, currentTimeEl, totalTimeEl, eqBars, artSide,
        chatForm, chatInput, chatSend,
        volumeEl, volumeBtn, volumeSlider,
        noveltyEl, noveltySlider,
        reasonEl, reasonTextEl,
        composingEl, composingTextEl;

    const playSVG  = `<path d="M7 4 L20 12 L7 20 Z"/>`;
    const pauseSVG = `<rect x="6" y="5" width="4" height="14" rx="0.5"/><rect x="14" y="5" width="4" height="14" rx="0.5"/>`;

    function init(c) {
        if (initialized) return;
        initialized = true;
        ctx = c;
        root = document.getElementById('view-player');
        if (!root) return;

        playBtn       = root.querySelector('#play-btn');
        playIcon      = root.querySelector('#playIcon');
        prevBtn       = root.querySelector('#prev-btn');
        nextBtn       = root.querySelector('#next-btn');
        heart         = root.querySelector('#heart');
        statusText    = root.querySelector('#status-text');
        progressBar   = root.querySelector('#progress');
        currentTimeEl = root.querySelector('#current-time');
        totalTimeEl   = root.querySelector('#total-time');
        titleEl       = root.querySelector('#track-title');
        artistEl      = root.querySelector('#track-artist');
        lyricsTrack   = root.querySelector('#lyrics-track');
        coverImg      = root.querySelector('#cover-img');
        albumArt      = root.querySelector('#album-art');
        eqBars        = root.querySelectorAll('.eq-bar');
        artSide       = root.querySelector('.art-side');
        chatForm      = root.querySelector('#chat-form');
        chatInput     = root.querySelector('#chat-input');
        chatSend      = root.querySelector('#chat-send');
        volumeEl      = root.querySelector('#volume');
        volumeBtn     = root.querySelector('#volume-btn');
        volumeSlider  = root.querySelector('#volume-slider');
        noveltyEl     = root.querySelector('#novelty');
        noveltySlider = root.querySelector('#novelty-slider');
        reasonEl      = root.querySelector('#track-reason');
        reasonTextEl  = root.querySelector('#track-reason-text');
        composingEl     = root.querySelector('#dj-composing');
        composingTextEl = root.querySelector('#dj-composing-text');

        document.body.classList.add('paused');
        applyLetterStagger(titleEl, titleEl.textContent);

        // Listen to shared state events
        ctx.bus.addEventListener('state:track',    (e) => renderTrack(e.detail));
        ctx.bus.addEventListener('state:dj',       (e) => onDjEvent(e.detail));
        ctx.bus.addEventListener('state:reason',   (e) => renderReason(e.detail));
        ctx.bus.addEventListener('state:play',     (e) => setPlayingUI(e.detail));
        ctx.bus.addEventListener('state:progress', (e) => updateProgress(e.detail));
        ctx.bus.addEventListener('state:status',   (e) => setStatus(e.detail));
        ctx.bus.addEventListener('state:love',     (e) => setHeartUI(e.detail));

        // Streaming composing indicator — SDK path only; CLI path never fires these.
        let composeBuffer = '';
        ctx.bus.addEventListener('state:stream-delta', (e) => {
            composeBuffer += e.detail || '';
            if (composingEl && composingTextEl) {
                composingEl.hidden = false;
                // Only show the first 240 chars of the streamed JSON — most likely
                // the user-facing `say` field arrives early; we don't need to render
                // the rest of the schema. Strip JSON syntactic characters for readability.
                const display = composeBuffer
                    .replace(/^\s*\{/, '')
                    .replace(/"say"\s*:\s*"/, '"')
                    .slice(0, 240);
                composingTextEl.textContent = display;
            }
        });
        ctx.bus.addEventListener('state:stream-end', () => {
            composeBuffer = '';
            if (composingEl) {
                composingEl.hidden = true;
                if (composingTextEl) composingTextEl.textContent = '';
            }
        });

        // Buttons → shared actions
        playBtn.addEventListener('click', () => {
            if (ctx.state.isPlaying) ctx.actions.togglePlayPause();
            else ctx.actions.play();
        });
        nextBtn.addEventListener('click', () => {
            const audio = ctx.audio;
            const track = ctx.state.track;
            const pct = (audio?.duration && audio.duration > 0)
                ? Math.max(0, Math.min(1, audio.currentTime / audio.duration))
                : null;
            if (track?.songId || track?.name) {
                // Fire-and-forget — don't block the skip on the POST
                fetch('/api/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_id:      track.songId,
                        song_name:    track.name,
                        artist:       track.artist,
                        type:         'skip',
                        position_pct: pct
                    })
                }).catch(err => console.error('[feedback skip]', err.message));
            }
            ctx.actions.next();
        });
        prevBtn.addEventListener('click', () => ctx.actions.prev());

        // Seek
        root.querySelector('#progress-bar')?.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            ctx.actions.seek((e.clientX - rect.left) / rect.width);
        });

        // Volume — slider sets <audio>.volume directly (app.js applies it across both
        // music and tts elements). Click the icon to mute/unmute; we remember the
        // last non-zero level so unmute restores to where the user left it.
        let lastVolume = ctx.actions.getVolume();
        if (lastVolume === 0) lastVolume = 1;
        syncVolumeUI(ctx.actions.getVolume());

        volumeSlider?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            if (v > 0) lastVolume = v;
            ctx.actions.setVolume(v);
            syncVolumeUI(v);
        });
        volumeBtn?.addEventListener('click', () => {
            const cur = ctx.actions.getVolume();
            const next = cur > 0 ? 0 : lastVolume;
            ctx.actions.setVolume(next);
            syncVolumeUI(next);
        });
        ctx.bus.addEventListener('state:volume', (e) => syncVolumeUI(e.detail));

        // Novelty slider — persists via getPref/setPref in App.actions
        noveltySlider?.addEventListener('input', (e) => {
            ctx.actions.setNovelty(e.target.value);
            syncNoveltyUI(parseInt(e.target.value, 10));
        });
        syncNoveltyUI(ctx.actions.getNovelty());
        if (noveltySlider) noveltySlider.value = String(ctx.actions.getNovelty());

        // Heart — toggles love/unlove via /api/feedback
        heart?.addEventListener('click', async () => {
            const newState = !heart.classList.contains('active');
            setHeartUI(newState);  // optimistic
            heart.classList.remove('popping');
            void heart.offsetWidth;
            heart.classList.add('popping');
            const track = ctx.state.track;
            if (!track?.songId && !track?.name) return;
            try {
                await fetch('/api/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_id:   track.songId,
                        song_name: track.name,
                        artist:    track.artist,
                        type:      newState ? 'love' : 'unlove'
                    })
                });
                ctx.state.isLoved = newState;
            } catch (err) {
                // Roll back optimistic toggle on failure
                setHeartUI(!newState);
                console.error('[feedback love]', err.message);
            }
        });

        // EQ animation
        let eqT = 0;
        setInterval(() => {
            if (!ctx.state.isPlaying) return;
            if (!root.classList.contains('is-active')) return;
            eqT += 0.18;
            eqBars.forEach((b, i) => {
                const phase = i * 0.7;
                const wave = (Math.sin(eqT + phase) + Math.sin(eqT * 1.7 + phase) * 0.5) * 0.5 + 0.5;
                b.style.height = (25 + wave * 75) + '%';
            });
        }, 80);

        // Album-art mouse parallax
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduceMotion && artSide && albumArt) {
            artSide.addEventListener('mousemove', (e) => {
                const rect = albumArt.getBoundingClientRect();
                const x = (e.clientX - rect.left - rect.width / 2) / rect.width;
                const y = (e.clientY - rect.top - rect.height / 2) / rect.height;
                albumArt.style.transform = `perspective(800px) rotateY(${(x * 8).toFixed(2)}deg) rotateX(${(-y * 8).toFixed(2)}deg) translateZ(20px)`;
            });
            artSide.addEventListener('mouseleave', () => albumArt.style.transform = '');
        }

        // Floating particles (decorative)
        if (!reduceMotion) {
            for (let i = 0; i < 18; i++) {
                const p = document.createElement('div');
                p.className = 'particle';
                p.style.left = Math.random() * 100 + 'vw';
                p.style.animationDelay = Math.random() * 12 + 's';
                p.style.animationDuration = (10 + Math.random() * 8) + 's';
                root.appendChild(p);
            }
        }

        // If track already exists (restored from localStorage), render it now
        if (ctx.state.track) {
            renderTrack(ctx.state.track);
            if (ctx.state.djSay)    appendChatLine(ctx.state.djSay, 'dj');
            if (ctx.state.djReason) renderReason(ctx.state.djReason);
            setPlayingUI(ctx.state.isPlaying);
        }

        // Wire the ••• menu in player nav — Sign in opens the shared auth modal
        // that view-stack.js has already bound (close button, submit handler).
        bindMoreMenu();

        // Locale toggle from ••• menu (works for both player and stack menus)
        document.body.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action="lang"]');
            if (item) {
                const next = window.ClaudioI18n?.locale === 'en' ? 'zh' : 'en';
                window.ClaudioI18n?.setLocale(next);
            }
        });

        // Chat form — POST /api/chat with the user's message; DJ reply arrives
        // either in the HTTP response (fast) or via WS state:dj (slower, full chain).
        chatForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (!text) return;

            chatInput.value = '';
            chatInput.disabled = true;
            chatSend.disabled = true;
            chatSend.classList.add('is-loading');

            appendChatLine(text, 'user');
            setStatus(window.ClaudioI18n?.t('player.status.thinking') || 'Thinking…');

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text, novelty: ctx.state.novelty })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                // Show DJ reply immediately from the HTTP response (~7s).
                // The WS state:dj that follows ~20-30s later will be deduped.
                if (data.say) appendChatLine(data.say, 'dj');
            } catch (err) {
                appendChatLine('— ' + err.message, 'error');
                setStatus('⚠ ' + err.message);
            } finally {
                chatInput.disabled = false;
                chatSend.disabled = false;
                chatSend.classList.remove('is-loading');
                chatInput.focus();
            }
        });
    }

    function show() { /* called by app.js when view becomes active */ }

    // ••• dropdown menu in player nav. The auth modal's submit/close handlers
    // are already bound globally by view-stack.js (single shared modal), so
    // here we just toggle the dropdown and unhide the modal on Sign in.
    function bindMoreMenu() {
        const moreBtn      = root.querySelector('#player-more-btn');
        const moreDropdown = root.querySelector('#player-more-dropdown');
        const authModal    = document.getElementById('auth-modal');
        const authEmail    = document.getElementById('auth-email');
        if (!moreBtn || !moreDropdown) return;

        const setOpen = (open) => {
            moreDropdown.hidden = !open;
            moreBtn.setAttribute('aria-expanded', String(open));
        };

        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(moreDropdown.hidden);
        });

        // Click outside the menu closes it
        document.addEventListener('click', (e) => {
            if (moreDropdown.hidden) return;
            if (e.target.closest('#player-more-dropdown')) return;
            if (e.target.closest('#player-more-btn')) return;
            setOpen(false);
        });

        // Auth-aware menu items: Sign in shows when anon, Sign out shows when authed.
        async function updateAuthMenuState() {
            try {
                const res = await fetch('/api/auth/me');
                const data = await res.json();
                const isAuthed = !!data.user;
                document.querySelectorAll('.more-item[data-action="login"]').forEach(el => { el.hidden = isAuthed; });
                document.querySelectorAll('.more-item[data-action="signout"]').forEach(el => { el.hidden = !isAuthed; });
            } catch { /* ignore */ }
        }
        updateAuthMenuState();

        // Menu item actions
        moreDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action]:not(:disabled)');
            if (item) {
                setOpen(false);
                if (item.dataset.action === 'login' && authModal) {
                    authModal.hidden = false;
                    setTimeout(() => authEmail?.focus(), 50);
                }
                if (item.dataset.action === 'signout') {
                    (async () => {
                        try {
                            await fetch('/api/auth/signout', { method: 'POST' });
                        } catch { /* ignore */ }
                        location.reload();
                    })();
                }
                return;
            }
            // <a> menu items (Stack view) — let SPA router handle, just close menu
            if (e.target.closest('a.more-item')) setOpen(false);
        });

        // Esc closes menu (modal Esc is handled by view-stack.js's global listener)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !moreDropdown.hidden) setOpen(false);
        });
    }

    function renderTrack(track) {
        if (!track) return;
        applyLetterStagger(titleEl, track.name || '—');
        artistEl.textContent = track.artist || '';
        if (track.coverUrl) {
            coverImg.onload  = () => albumArt.classList.add('has-cover');
            coverImg.onerror = () => albumArt.classList.remove('has-cover');
            coverImg.src = track.coverUrl;
        }
        // Hide stale reason until the new one arrives (state:reason fires
        // separately and will re-render). Prevents the old explanation from
        // sitting under a new cover for the few hundred ms in between.
        if (reasonEl && !ctx.state.djReason) {
            reasonEl.hidden = true;
            reasonEl.classList.remove('is-visible');
        }
    }

    // Append a line to the conversation log. role: 'dj' | 'user' | 'error'.
    function appendChatLine(text, role = 'dj') {
        if (!lyricsTrack || !text) return;
        const oldCurrent = lyricsTrack.querySelector('.lyric-line.current');
        if (oldCurrent) oldCurrent.classList.remove('current');

        const line = document.createElement('div');
        line.className = `lyric-line lyric-line--${role} current`;
        line.dataset.role = role;
        // DJ utterances are styled like spoken quotes; user/error are plain text.
        line.textContent = role === 'dj' ? `"${text}"` : text;
        lyricsTrack.appendChild(line);

        while (lyricsTrack.children.length > 10) lyricsTrack.removeChild(lyricsTrack.firstChild);
        const lines = lyricsTrack.querySelectorAll('.lyric-line');
        const lineHeight = 41;
        const slot = Math.min(2, lines.length - 1);
        const offset = Math.max(0, (lines.length - 1 - slot) * lineHeight);
        lyricsTrack.style.transform = `translateY(-${offset}px)`;
    }

    // Handle DJ event from the shared bus. If the same text was just shown
    // (e.g., user submitted a chat and we already displayed the HTTP reply),
    // skip — otherwise the WS broadcast would duplicate it.
    function onDjEvent(text) {
        if (!text) return;
        const last = lyricsTrack?.querySelector('.lyric-line:last-child');
        if (last && last.dataset.role === 'dj' && last.textContent === `"${text}"`) return;
        appendChatLine(text, 'dj');
    }

    function updateProgress({ pct, currentTime, duration }) {
        progressBar.style.width = (pct * 100) + '%';
        currentTimeEl.textContent = fmt(currentTime);
        totalTimeEl.textContent = fmt(duration);
    }

    function setPlayingUI(state) {
        document.body.classList.toggle('paused', !state);
        if (!playIcon) return;
        playIcon.style.transform = 'scale(0.6)';
        setTimeout(() => {
            playIcon.innerHTML = state ? pauseSVG : playSVG;
            playIcon.style.transform = 'scale(1)';
        }, 150);
    }

    function setStatus(msg) {
        if (statusText) statusText.textContent = msg;
    }

    function setHeartUI(active) {
        if (!heart) return;
        heart.classList.toggle('active', !!active);
        const svg = heart.querySelector('svg');
        if (svg) svg.setAttribute('fill', active ? 'currentColor' : 'none');
    }

    // Render the LLM's "why this song" explanation. Hidden when empty; soft
    // fade-in on change so it doesn't compete with the track title's animation.
    function renderReason(text) {
        if (!reasonEl || !reasonTextEl) return;
        const trimmed = (text || '').trim();
        if (!trimmed) {
            reasonEl.hidden = true;
            reasonEl.classList.remove('is-visible');
            reasonTextEl.textContent = '';
            return;
        }
        reasonTextEl.textContent = trimmed;
        reasonEl.hidden = false;
        // Restart the fade-in: removing + re-adding via a frame triggers
        // the CSS transition cleanly even when the same text is reapplied.
        reasonEl.classList.remove('is-visible');
        void reasonEl.offsetWidth;
        reasonEl.classList.add('is-visible');
    }

    function syncNoveltyUI(n) {
        if (!noveltyEl) return;
        noveltyEl.style.setProperty('--nov', `${n}%`);
        noveltyEl.dataset.level = n < 31 ? 'safe' : n > 70 ? 'adventurous' : 'balanced';
    }

    function syncVolumeUI(v) {
        if (!volumeEl) return;
        if (volumeSlider && parseFloat(volumeSlider.value) !== v) {
            volumeSlider.value = String(v);
        }
        if (volumeSlider) {
            volumeSlider.style.setProperty('--vol', `${(v * 100).toFixed(1)}%`);
        }
        const level = v === 0 ? 'mute' : v < 0.33 ? 'low' : v < 0.7 ? 'mid' : 'high';
        volumeEl.dataset.level = level;
    }

    function fmt(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }

    function applyLetterStagger(el, text) {
        if (!el) return;
        const safe = String(text || '—');
        el.innerHTML = '';
        const chunks = safe.split(/(\s+)/);
        let letterIndex = 0;
        for (const chunk of chunks) {
            if (!chunk) continue;
            if (/^\s+$/.test(chunk)) {
                el.appendChild(document.createTextNode(' '));
                continue;
            }
            const wordSpan = document.createElement('span');
            wordSpan.className = 'title-word';
            for (const ch of chunk) {
                const letter = document.createElement('span');
                letter.className = 'title-letter';
                letter.textContent = ch;
                letter.style.animationDelay = `${(0.05 + letterIndex * 0.035).toFixed(3)}s`;
                wordSpan.appendChild(letter);
                letterIndex++;
            }
            el.appendChild(wordSpan);
        }
    }

    window.ViewPlayer = { init, show };
})();
