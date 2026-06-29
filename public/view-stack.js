// view-stack.js — Stack view module.
// Manages the 3D card stack, FLIP cover-fly to in-page player overlay,
// now-chip, ••• menu, and auth modal. Audio + WS live in shared ctx.

(function () {
    let ctx = null;
    let initialized = false;
    let root, stackEl, stack3d, pageMeta;
    let nowChip, nowChipCover, nowChipTitle, nowChipArtist, nowChipPlay;
    let playerEl, coverSlot, playerTitle, playerArtist, playerAlbum, playerLyrics,
        playerCurrent, playerTotal, playerFill, playerBar,
        playerPlay, playerPlayIcon, playerPrev, playerNext, playerClose, eqBars;

    const ACCENT_PALETTE = [
        '#a3e635', '#67e8f9', '#fb7185', '#c084fc',
        '#facc15', '#f87171', '#fb923c', '#fde047', '#d4a574'
    ];

    const playSVG  = `<path d="M7 4 L20 12 L7 20 Z"/>`;
    const pauseSVG = `<rect x="6" y="5" width="4" height="14" rx="0.5"/><rect x="14" y="5" width="4" height="14" rx="0.5"/>`;

    const SIGNATURE_FALLBACK = [
        { song_name: 'Aruarian Dance',                artist: 'Nujabes' },
        { song_name: 'Almost Blue',                   artist: 'Chet Baker' },
        { song_name: 'なんでもないや',                  artist: 'RADWIMPS' },
        { song_name: 'On the Nature of Daylight',     artist: 'Max Richter' },
        { song_name: 'Merry Christmas Mr. Lawrence',  artist: '坂本龍一' },
        { song_name: 'Hoppípolla',                    artist: 'Sigur Rós' },
        { song_name: 'Sparkle',                       artist: '山下達郎' },
        { song_name: 'Peace Piece',                   artist: 'Bill Evans' },
        { song_name: '白日',                           artist: 'King Gnu' },
        { song_name: 'Near Light',                    artist: 'Ólafur Arnalds' }
    ];

    let plays = [];
    let currentFloater = null;
    let sourceEl = null;
    let currentTrack = null;

    function init(c) {
        if (initialized) return;
        initialized = true;
        ctx = c;
        root = document.getElementById('view-stack');
        if (!root) return;

        stackEl       = root.querySelector('#stack');
        stack3d       = root.querySelector('#stack3d');
        pageMeta      = root.querySelector('#page-meta');
        nowChip       = root.querySelector('#now-chip');
        nowChipCover  = root.querySelector('#now-chip-cover');
        nowChipTitle  = root.querySelector('#now-chip-title');
        nowChipArtist = root.querySelector('#now-chip-artist');
        nowChipPlay   = root.querySelector('#now-chip-play');
        playerEl       = root.querySelector('#player');
        coverSlot      = root.querySelector('#cover-slot');
        playerTitle    = root.querySelector('#player-title');
        playerArtist   = root.querySelector('#player-artist');
        playerAlbum    = root.querySelector('#player-album');
        playerLyrics   = root.querySelector('#player-lyrics');
        playerCurrent  = root.querySelector('#player-current');
        playerTotal    = root.querySelector('#player-total');
        playerFill     = root.querySelector('#player-fill');
        playerBar      = root.querySelector('#player-bar');
        playerPlay     = root.querySelector('#player-play');
        playerPlayIcon = root.querySelector('#player-play-icon');
        playerPrev     = root.querySelector('#player-prev');
        playerNext     = root.querySelector('#player-next');
        playerClose    = root.querySelector('#player-close');
        eqBars         = root.querySelectorAll('#player-eq .eq-bar');

        bindOverlayControls();
        bindMouseParallax();
        bindKeyboard();
        bindMoreMenuAndAuth();

        // Bus events
        ctx.bus.addEventListener('state:track', (e) => {
            currentTrack = e.detail;
            updateNowChip(currentTrack);
            if (root.classList.contains('is-active') && document.body.classList.contains('player-open')) {
                playerTitle.textContent = currentTrack.name || '—';
                playerArtist.textContent = currentTrack.artist || '—';
            }
        });
        ctx.bus.addEventListener('state:dj', (e) => {
            if (document.body.classList.contains('player-open')) {
                playerLyrics.textContent = e.detail || '';
            }
        });
        ctx.bus.addEventListener('state:play', (e) => setPlayingIcon(e.detail));
        ctx.bus.addEventListener('state:progress', (e) => {
            playerFill.style.width = (e.detail.pct * 100) + '%';
            playerCurrent.textContent = fmt(e.detail.currentTime);
            playerTotal.textContent   = fmt(e.detail.duration);
        });
        ctx.bus.addEventListener('library:refresh', () => loadLibrary());

        // Restore from current shared state
        if (ctx.state.track) {
            currentTrack = ctx.state.track;
            updateNowChip(currentTrack);
            setPlayingIcon(ctx.state.isPlaying);
        }

        loadLibrary();
    }

    function show() {
        // Refresh stack when becoming active
        loadLibrary();
    }

    async function loadLibrary() {
        try {
            const res = await fetch('/api/library', { cache: 'no-store' });
            const data = await res.json();
            const all = Array.isArray(data.plays) ? data.plays : [];

            if (all.length === 0) {
                plays = SIGNATURE_FALLBACK;
                pageMeta.textContent = '— signature';
            } else {
                plays = all.slice(0, 20);
                pageMeta.textContent = `${String(all.length).padStart(3, '0')} / Recent`;
            }
            renderStack();
        } catch (err) {
            plays = SIGNATURE_FALLBACK;
            pageMeta.textContent = '— offline';
            renderStack();
        }
    }

    function renderStack() {
        const total = plays.length;
        stackEl.innerHTML = plays.map((p, i) => {
            const accent = ACCENT_PALETTE[i % ACCENT_PALETTE.length];
            const depth = total - 1 - i;
            const artistUpper = (p.artist || '').toUpperCase();
            const overline = formatOverline(p);
            const preview = formatPreview(p);
            const coverHTML = p.cover_url
                ? `<div class="cover" style="background-image:url('${escAttr(p.cover_url)}')"></div>`
                : `<div class="cover ${proceduralClass(p.song_id || p.song_name || '')}"></div>`;

            const aboutUrl  = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(p.artist || p.song_name)}`;
            const tracksUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent((p.artist || '') + ' songs')}`;
            const storyUrl  = p.song_id
                ? `https://www.youtube.com/watch?v=${encodeURIComponent(p.song_id)}`
                : `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent((p.song_name || '') + ' ' + (p.artist || ''))}`;

            return `
                <div class="card"
                    style="--i:${i}; --depth:${depth}; --c:${accent};"
                    data-song-id="${escAttr(p.song_id || '')}"
                    data-song-name="${escAttr(p.song_name || '')}"
                    data-song-artist="${escAttr(p.artist || '')}"
                    data-cover-url="${escAttr(p.cover_url || '')}"
                    data-accent="${accent}">
                    <div class="strip">
                        <span class="strip-dots">• • •</span>
                        <span class="strip-artist">${escHtml(artistUpper || '—')}</span>
                        <div class="strip-nav">
                            <a href="${aboutUrl}"  target="_blank" rel="noopener noreferrer" data-external>About</a>
                            <a href="${tracksUrl}" target="_blank" rel="noopener noreferrer" data-external>Tracks</a>
                            <a href="${storyUrl}"  target="_blank" rel="noopener noreferrer" data-external>Story</a>
                        </div>
                        <span class="read-badge">PLAY</span>
                    </div>
                    <div class="body"><div class="body-inner">
                        ${coverHTML}
                        <div class="info">
                            <div class="info-overline">${escHtml(overline)}</div>
                            <div class="info-title">${escHtml(p.song_name || '—')}</div>
                            <div class="info-feat">${escHtml(p.artist || '')}</div>
                            <div class="info-preview">
                                <span class="preview-badge">PREVIEW</span>
                                <p class="preview-text" data-preview-default="${escAttr(preview)}">${escHtml(preview)}</p>
                            </div>
                            <button class="listen-btn" type="button">▶ LISTEN</button>
                        </div>
                    </div></div>
                </div>
            `;
        }).join('');

        // No auto-active — show all strips compactly so the user can scan
        // the full stack at a glance. Click any card to expand it.

        bindCardClicks();
    }

    function proceduralClass(seed) {
        let h = 0;
        const s = String(seed);
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return 'p' + ((Math.abs(h) % 8) + 1);
    }

    function formatOverline(p) {
        const artist = (p.artist || '').toUpperCase();
        if (p.timestamp) {
            const d = new Date(p.timestamp);
            if (!Number.isNaN(d.getTime())) {
                const year = d.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'Asia/Taipei' });
                return artist ? `${artist} · ${year}` : year;
            }
        }
        return artist || '—';
    }

    function formatPreview(p) {
        if (p.timestamp) {
            const d = new Date(p.timestamp);
            if (!Number.isNaN(d.getTime())) {
                const diffMs = Date.now() - d.getTime();
                const day = 86400000;
                if (diffMs < day) return 'Played today on your Taipei radio.';
                if (diffMs < 7 * day) {
                    const days = Math.floor(diffMs / day);
                    return `Played ${days} ${days === 1 ? 'day' : 'days'} ago. The kind of record that finds you again.`;
                }
                return 'From an older session. Worth a return visit.';
            }
        }
        return 'From your signature pool — not yet played, but waiting.';
    }

    function bindCardClicks() {
        stackEl.querySelectorAll('.card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.listen-btn')) return;
                if (e.target.closest('a[target="_blank"]')) return;   // external link → let browser handle
                const wasActive = card.classList.contains('active');
                stackEl.querySelectorAll('.card').forEach(c => c.classList.remove('active'));
                if (!wasActive) {
                    card.classList.add('active');
                    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
                    hydrateStory(card);
                }
            });
            const listenBtn = card.querySelector('.listen-btn');
            listenBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                openPlayerFromCard(card);
            });
        });
    }

    // Story lazy-load: when a card expands, fetch a Claude-generated sentence
    // for it. Cached client-side too so re-expanding doesn't refetch.
    const storyCache = new Map();
    async function hydrateStory(card) {
        const previewEl = card.querySelector('.preview-text');
        if (!previewEl) return;

        const songId   = card.dataset.songId || '';
        const songName = card.dataset.songName || '';
        const artist   = card.dataset.songArtist || '';
        const key      = songId || `${songName}|${artist}`;
        if (!songName) return;

        if (storyCache.has(key)) {
            previewEl.textContent = storyCache.get(key);
            previewEl.classList.add('preview-text--story');
            return;
        }

        // Loading state — soft ellipsis, keep the previous text dim underneath
        const fallback = previewEl.dataset.previewDefault || previewEl.textContent;
        previewEl.classList.add('preview-text--loading');
        previewEl.textContent = '…';

        try {
            const res = await fetch('/api/story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ song_id: songId, song_name: songName, artist })
            });
            const data = await res.json().catch(() => ({}));
            previewEl.classList.remove('preview-text--loading');
            if (data.story) {
                storyCache.set(key, data.story);
                previewEl.textContent = data.story;
                previewEl.classList.add('preview-text--story');
            } else {
                previewEl.textContent = fallback;
            }
        } catch (err) {
            previewEl.classList.remove('preview-text--loading');
            previewEl.textContent = fallback;
        }
    }

    function bindMouseParallax() {
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion) return;

        let tgtY = 0, tgtX = 0, curY = 0, curX = 0;
        document.addEventListener('mousemove', (e) => {
            if (!root.classList.contains('is-active')) return;
            if (document.body.classList.contains('player-open')) return;
            const x = (e.clientX / window.innerWidth - 0.5) * 2;
            const y = (e.clientY / window.innerHeight - 0.5) * 2;
            tgtY = x * 5;
            tgtX = -y * 2.5 + 1;
        });
        function frame() {
            if (root.classList.contains('is-active') && stack3d) {
                curY += (tgtY - curY) * 0.08;
                curX += (tgtX - curX) * 0.08;
                stack3d.style.transform = `rotateX(${curX}deg) rotateY(${curY}deg)`;
            }
            requestAnimationFrame(frame);
        }
        frame();
    }

    async function openPlayerFromCard(card) {
        const d = card.dataset;
        const accent = d.accent || '#a3e635';
        const song_name = d.songName;
        const artist    = d.songArtist;
        const song_id   = d.songId || null;

        document.documentElement.style.setProperty('--player-accent', accent);
        playerTitle.textContent  = song_name || '—';
        playerArtist.textContent = artist || '—';
        playerAlbum.textContent  = formatOverline({ artist, timestamp: null });
        playerLyrics.textContent = song_name || '';

        flyCoverToOverlay(card.querySelector('.cover'));

        try {
            await ctx.actions.playByName(song_name, artist, song_id);
        } catch (err) {
            playerLyrics.textContent = 'Playback failed: ' + err.message;
        }
    }

    function openPlayerFromChip() {
        if (!currentTrack) return;
        playerTitle.textContent  = currentTrack.name || '—';
        playerArtist.textContent = currentTrack.artist || '—';
        playerAlbum.textContent  = (currentTrack.artist || '').toUpperCase();
        playerLyrics.textContent = ctx.state.djSay || currentTrack.name || '';
        flyCoverToOverlay(nowChipCover, true);
    }

    function flyCoverToOverlay(source, fromChip = false) {
        sourceEl = source;
        const sourceRect = source.getBoundingClientRect();

        source.style.visibility = 'hidden';

        const floater = source.cloneNode(true);
        floater.classList.remove('now-chip-cover');
        floater.classList.add('cover-floater', 'flying-out');

        // Set styles INDIVIDUALLY so the inline background-image cloned from
        // the source (the YT thumbnail URL) is preserved. Using style.cssText
        // wipes the style attribute, losing the cover image entirely.
        floater.style.position = 'fixed';
        floater.style.left = sourceRect.left + 'px';
        floater.style.top = sourceRect.top + 'px';
        floater.style.width = sourceRect.width + 'px';
        floater.style.height = sourceRect.height + 'px';
        floater.style.margin = '0';
        floater.style.visibility = 'visible';
        floater.style.opacity = '1';
        floater.style.borderRadius = fromChip ? '50%' : '4px';
        // Below dropdown (6000) + auth modal (9999), above player overlay (5000)
        floater.style.zIndex = '5500';

        document.body.appendChild(floater);
        currentFloater = floater;

        document.body.classList.add('player-open');

        requestAnimationFrame(() => requestAnimationFrame(() => {
            const target = coverSlot.getBoundingClientRect();
            floater.classList.add('in-player');
            floater.style.left   = target.left + 'px';
            floater.style.top    = target.top + 'px';
            floater.style.width  = target.width + 'px';
            floater.style.height = target.height + 'px';
            floater.style.borderRadius = '6px';
        }));

        startEqAnimation();
    }

    function closePlayer() {
        document.body.classList.remove('player-open');
        stopEqAnimation();

        if (!currentFloater || !sourceEl) return;

        currentFloater.classList.remove('flying-out');
        currentFloater.classList.add('flying-back');

        const r = sourceEl.getBoundingClientRect();
        currentFloater.classList.remove('in-player');
        currentFloater.style.left   = r.left + 'px';
        currentFloater.style.top    = r.top + 'px';
        currentFloater.style.width  = r.width + 'px';
        currentFloater.style.height = r.height + 'px';
        currentFloater.style.borderRadius = sourceEl.classList.contains('now-chip-cover') ? '50%' : '4px';

        stackEl.style.transition = 'transform 0.25s ease-in';
        stackEl.style.transform = 'scale(0.97)';
        setTimeout(() => {
            stackEl.style.transition = 'transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)';
            stackEl.style.transform = '';
        }, 250);

        setTimeout(() => {
            if (currentFloater) currentFloater.remove();
            if (sourceEl && sourceEl.style) sourceEl.style.visibility = '';
            currentFloater = null;
            sourceEl = null;
        }, 950);
    }

    function bindOverlayControls() {
        playerClose.addEventListener('click', closePlayer);
        playerPlay.addEventListener('click', () => ctx.actions.togglePlayPause());
        playerNext.addEventListener('click', () => ctx.actions.next());
        playerPrev.addEventListener('click', () => {});
        playerBar.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            ctx.actions.seek((e.clientX - rect.left) / rect.width);
        });

        nowChip.addEventListener('click', (e) => {
            if (e.target.closest('.now-chip-play')) {
                e.stopPropagation();
                ctx.actions.togglePlayPause();
                return;
            }
            openPlayerFromChip();
        });

        window.addEventListener('resize', () => {
            if (currentFloater && document.body.classList.contains('player-open')) {
                const t = coverSlot.getBoundingClientRect();
                currentFloater.style.left   = t.left + 'px';
                currentFloater.style.top    = t.top + 'px';
                currentFloater.style.width  = t.width + 'px';
                currentFloater.style.height = t.height + 'px';
            }
        });
    }

    function bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!root.classList.contains('is-active')) return;
            if (document.body.classList.contains('player-open')) {
                if (e.key === 'Escape') closePlayer();
                return;
            }
            const cards = stackEl.querySelectorAll('.card');
            const active = stackEl.querySelector('.card.active');
            if (!active || !cards.length) return;
            const list = Array.from(cards);
            const i = list.indexOf(active);
            if (e.key === 'ArrowDown' && i < list.length - 1) {
                active.classList.remove('active');
                list[i + 1].classList.add('active');
                list[i + 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (e.key === 'ArrowUp' && i > 0) {
                active.classList.remove('active');
                list[i - 1].classList.add('active');
                list[i - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (e.key === 'Escape') {
                active.classList.remove('active');
            }
        });
    }

    function bindMoreMenuAndAuth() {
        const moreBtn      = root.querySelector('#more-btn');
        const moreDropdown = root.querySelector('#more-dropdown');
        const authModal    = document.getElementById('auth-modal');
        const authBackdrop = document.getElementById('auth-backdrop');
        const authClose    = document.getElementById('auth-close');
        const authForm     = document.getElementById('auth-form');
        const authEmail    = document.getElementById('auth-email');
        const authError    = document.getElementById('auth-error');
        const authSuccess  = document.getElementById('auth-success');
        const authSubmit   = document.getElementById('auth-submit');

        if (!moreBtn || !moreDropdown) return;

        const setMenuOpen = (open) => {
            moreDropdown.hidden = !open;
            moreBtn.setAttribute('aria-expanded', String(open));
        };

        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMenuOpen(moreDropdown.hidden);
        });

        document.addEventListener('click', (e) => {
            if (moreDropdown.hidden) return;
            if (e.target.closest('.more-menu')) return;
            setMenuOpen(false);
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

        moreDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.more-item[data-action]:not(:disabled)');
            if (!item) return;
            setMenuOpen(false);
            if (item.dataset.action === 'login') openAuthModal();
            if (item.dataset.action === 'signout') {
                (async () => {
                    try {
                        await fetch('/api/auth/signout', { method: 'POST' });
                    } catch { /* ignore */ }
                    location.reload();
                })();
            }
        });

        function openAuthModal() {
            if (!authModal) return;
            authModal.hidden = false;
            setTimeout(() => authEmail?.focus(), 50);
        }
        function closeAuthModal() {
            if (!authModal) return;
            authModal.hidden = true;
            if (authError) authError.hidden = true;
            if (authSuccess) authSuccess.hidden = true;
            authForm?.reset();
        }

        authBackdrop?.addEventListener('click', closeAuthModal);
        authClose?.addEventListener('click', closeAuthModal);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (authModal && !authModal.hidden) { closeAuthModal(); return; }
            if (!moreDropdown.hidden) setMenuOpen(false);
        });

        authForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = authEmail.value.trim();
            if (!email) return;
            authSubmit.disabled = true;
            authError.hidden = true;
            authSuccess.hidden = true;
            try {
                const res = await fetch('/api/auth/request-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Request failed');
                if (data.delivered) {
                    authSuccess.textContent = `Sign-in link sent to ${email}. Check your inbox (and spam).`;
                } else if (data.devLink) {
                    authSuccess.innerHTML = `Email not configured. <a href="${data.devLink}">Click here to sign in</a>.`;
                } else {
                    authSuccess.textContent = 'Link generated but delivery failed. Check server logs.';
                }
                authSuccess.hidden = false;
            } catch (err) {
                authError.textContent = err.message;
                authError.hidden = false;
            } finally {
                authSubmit.disabled = false;
            }
        });
    }

    function updateNowChip(track) {
        if (!nowChip) return;
        if (!track || !track.name) {
            nowChip.hidden = true;
            return;
        }
        nowChip.hidden = false;
        nowChipTitle.textContent = track.name;
        nowChipArtist.textContent = (track.artist || '').toUpperCase();
        if (track.coverUrl) nowChipCover.style.backgroundImage = `url("${track.coverUrl}")`;
        else nowChipCover.style.backgroundImage = '';
    }

    function setPlayingIcon(playing) {
        if (playerPlayIcon) playerPlayIcon.innerHTML = playing ? pauseSVG : playSVG;
        if (nowChipPlay)    nowChipPlay.textContent  = playing ? '⏸' : '▶';
    }

    // ── EQ ─────────────────────────────────────────────────────────────────
    let eqT = 0;
    let eqInterval = null;
    function startEqAnimation() {
        if (eqInterval) return;
        eqInterval = setInterval(() => {
            eqT += 0.18;
            eqBars.forEach((b, i) => {
                const phase = i * 0.7;
                const wave = (Math.sin(eqT + phase) + Math.sin(eqT * 1.7 + phase) * 0.5) * 0.5 + 0.5;
                b.style.height = (25 + wave * 75) + '%';
            });
        }, 80);
    }
    function stopEqAnimation() {
        clearInterval(eqInterval);
        eqInterval = null;
        eqBars.forEach(b => b.style.height = '15%');
    }

    function fmt(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }
    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escAttr(s) {
        return String(s ?? '').replace(/['"<>\\]/g, c => `&#${c.charCodeAt(0)};`);
    }

    window.ViewStack = { init, show };
})();
