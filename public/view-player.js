// view-player.js — Player view module.
// Listens to shared App.bus for state changes; binds buttons to App.actions.

(function () {
    let ctx = null;
    let initialized = false;
    let root, titleEl, artistEl, coverImg, albumArt, lyricsTrack,
        playBtn, playIcon, prevBtn, nextBtn, heart, statusText,
        progressBar, currentTimeEl, totalTimeEl, eqBars, artSide,
        chatForm, chatInput, chatSend;

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

        document.body.classList.add('paused');
        applyLetterStagger(titleEl, titleEl.textContent);

        // Listen to shared state events
        ctx.bus.addEventListener('state:track',    (e) => renderTrack(e.detail));
        ctx.bus.addEventListener('state:dj',       (e) => onDjEvent(e.detail));
        ctx.bus.addEventListener('state:play',     (e) => setPlayingUI(e.detail));
        ctx.bus.addEventListener('state:progress', (e) => updateProgress(e.detail));
        ctx.bus.addEventListener('state:status',   (e) => setStatus(e.detail));

        // Buttons → shared actions
        playBtn.addEventListener('click', () => {
            if (ctx.state.isPlaying) ctx.actions.togglePlayPause();
            else ctx.actions.play();
        });
        nextBtn.addEventListener('click', () => ctx.actions.next());
        prevBtn.addEventListener('click', () => {
            setStatus('暂时无法返回上一首');
        });

        // Seek
        root.querySelector('#progress-bar')?.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            ctx.actions.seek((e.clientX - rect.left) / rect.width);
        });

        // Heart (visual only — wire to /api/feedback later)
        heart?.addEventListener('click', () => {
            heart.classList.toggle('active');
            const svg = heart.querySelector('svg');
            svg.setAttribute('fill', heart.classList.contains('active') ? 'currentColor' : 'none');
            heart.classList.remove('popping');
            void heart.offsetWidth;
            heart.classList.add('popping');
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
            if (ctx.state.djSay) appendChatLine(ctx.state.djSay, 'dj');
            setPlayingUI(ctx.state.isPlaying);
        }

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
            setStatus('Claudio is thinking…');

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
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

    function renderTrack(track) {
        if (!track) return;
        applyLetterStagger(titleEl, track.name || '—');
        artistEl.textContent = track.artist || '';
        if (track.coverUrl) {
            coverImg.onload  = () => albumArt.classList.add('has-cover');
            coverImg.onerror = () => albumArt.classList.remove('has-cover');
            coverImg.src = track.coverUrl;
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
