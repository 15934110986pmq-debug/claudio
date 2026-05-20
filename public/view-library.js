// view-library.js — Library Grid view module.

(function () {
    let ctx = null;
    let initialized = false;
    let root, grid, titleCount, hint, controlButtons,
        mini, miniCover, miniTitle, miniArtist, miniPlay, miniPlayIcon, miniNext,
        miniTrackEl, miniFill;

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

    let state = { plays: [], isFallback: false, sort: 'recent' };
    let currentSongId = null;

    function init(c) {
        if (initialized) return;
        initialized = true;
        ctx = c;
        root = document.getElementById('view-library');
        if (!root) return;

        grid           = root.querySelector('#grid');
        titleCount     = root.querySelector('#title-count');
        hint           = root.querySelector('#hint');
        controlButtons = root.querySelectorAll('.control');

        mini         = root.querySelector('#mini-player');
        miniCover    = root.querySelector('#mini-cover');
        miniTitle    = root.querySelector('#mini-title');
        miniArtist   = root.querySelector('#mini-artist');
        miniPlay     = root.querySelector('#mini-play');
        miniPlayIcon = root.querySelector('#mini-play-icon');
        miniNext     = root.querySelector('#mini-next');
        miniTrackEl  = root.querySelector('#mini-progress-track');
        miniFill     = root.querySelector('#mini-progress-fill');

        controlButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                controlButtons.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                state.sort = btn.dataset.sort;
                render();
            });
        });

        // Mini controls → shared actions
        miniPlay?.addEventListener('click', () => ctx.actions.togglePlayPause());
        miniNext?.addEventListener('click', () => ctx.actions.next());
        miniTrackEl?.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            ctx.actions.seek((e.clientX - rect.left) / rect.width);
        });

        // Bus events
        ctx.bus.addEventListener('state:track', (e) => {
            const t = e.detail;
            if (!t) return;
            currentSongId = t.songId || null;
            updateMini(t);
            markPlayingCard(currentSongId);
        });
        ctx.bus.addEventListener('state:play', (e) => setPlayingIcon(e.detail));
        ctx.bus.addEventListener('state:progress', (e) => {
            if (miniFill) miniFill.style.width = (e.detail.pct * 100) + '%';
        });
        ctx.bus.addEventListener('library:refresh', () => loadLibrary());

        // If a track is already loaded (restored or from earlier in session)
        if (ctx.state.track) {
            currentSongId = ctx.state.track.songId || null;
            updateMini(ctx.state.track);
            setPlayingIcon(ctx.state.isPlaying);
        }

        loadLibrary();
    }

    function show() {
        // Refresh when becoming active in case data changed in background
        loadLibrary();
    }

    async function loadLibrary() {
        try {
            const res = await fetch('/api/library', { cache: 'no-store' });
            const data = await res.json();
            const plays = Array.isArray(data.plays) ? data.plays : [];

            if (plays.length === 0) {
                state.plays = SIGNATURE_FALLBACK;
                state.isFallback = true;
                hint?.classList.remove('hidden');
                titleCount.textContent = '— signature preview';
            } else {
                state.plays = plays;
                state.isFallback = false;
                hint?.classList.add('hidden');
                titleCount.textContent = `— ${plays.length} ${plays.length === 1 ? 'track' : 'tracks'}`;
            }
            render();
        } catch (err) {
            console.error('[library] fetch failed:', err);
            state.plays = SIGNATURE_FALLBACK;
            state.isFallback = true;
            hint?.classList.remove('hidden');
            titleCount.textContent = '— offline preview';
            render();
        }
    }

    function render() {
        const sorted = sortPlays(state.plays, state.sort);
        grid.innerHTML = sorted.map((p, i) => card(p, i)).join('');
        bindCardInteractions();
        markPlayingCard(currentSongId);
    }

    function card(play, i) {
        const cls = coverClassFor(play.song_id || (play.song_name + play.artist));
        const hasCover = !!play.cover_url;
        const coverInner = hasCover
            ? `<div class="cover-art has-cover" style="background-image:url('${escAttr(play.cover_url)}')"></div>`
            : `<div class="cover-art ${cls}"><span class="cover-label">${escHtml(shortLabel(play.song_name))}</span></div>`;
        const meta = play.timestamp
            ? formatPlayedAt(play.timestamp)
            : (state.isFallback ? 'SIGNATURE' : '');

        return `
            <article class="album"
                data-song-id="${escAttr(play.song_id || '')}"
                data-song-name="${escAttr(play.song_name || '')}"
                data-song-artist="${escAttr(play.artist || '')}"
                data-cover="${escAttr(play.cover_url || '')}"
                style="animation-delay:${Math.min(i * 35, 700)}ms"
                tabindex="0">
                <div class="cover">
                    ${coverInner}
                    <div class="play-overlay"><div class="play-button"></div></div>
                </div>
                <div class="info">
                    <div class="info-title">${escHtml(play.song_name || '—')}</div>
                    <div class="info-artist">${escHtml(play.artist || '')}</div>
                    ${meta ? `<div class="info-meta">${escHtml(meta)}</div>` : ''}
                </div>
            </article>
        `;
    }

    function bindCardInteractions() {
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        root.querySelectorAll('.album').forEach(album => {
            album.addEventListener('click', () => playByCardData(album.dataset));
            album.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    playByCardData(album.dataset);
                }
            });
            if (reduceMotion) return;

            const cover = album.querySelector('.cover');
            album.addEventListener('mousemove', (e) => {
                const rect = album.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width - 0.5;
                const y = (e.clientY - rect.top) / rect.height - 0.5;
                album.style.transform = `scale(1.12) translateY(-10px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg)`;
                cover.style.backgroundImage = `radial-gradient(circle at ${(x + 0.5) * 100}% ${(y + 0.5) * 100}%, rgba(255,255,255,0.12), transparent 50%)`;
            });
            album.addEventListener('mouseleave', () => {
                album.style.transform = '';
                cover.style.backgroundImage = '';
            });
        });
    }

    async function playByCardData(d) {
        const song_name = d.songName;
        const artist    = d.songArtist || '';
        const song_id   = d.songId || null;
        const cover_url = d.cover || '';
        if (!song_name) return;

        updateMini({ name: song_name, artist, coverUrl: cover_url });
        markPlayingCard(song_id);

        try {
            await ctx.actions.playByName(song_name, artist, song_id);
        } catch (err) {
            miniTitle.textContent = '播放失败';
            miniArtist.textContent = err.message;
        }
    }

    function updateMini(track) {
        if (!mini) return;
        mini.hidden = false;
        miniTitle.textContent = track.name || '—';
        miniArtist.textContent = track.artist || '';
        if (track.coverUrl) {
            miniCover.style.backgroundImage = `url("${track.coverUrl}")`;
        } else {
            miniCover.style.backgroundImage = '';
        }
    }

    function setPlayingIcon(playing) {
        if (miniPlayIcon) miniPlayIcon.innerHTML = playing ? pauseSVG : playSVG;
    }

    function markPlayingCard(songId) {
        root.querySelectorAll('.album.is-now-playing').forEach(a => a.classList.remove('is-now-playing'));
        if (!songId) return;
        const target = root.querySelector(`.album[data-song-id="${cssEscape(songId)}"]`);
        if (target) target.classList.add('is-now-playing');
    }

    function coverClassFor(seed) {
        let h = 0;
        const s = String(seed || '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return 'c' + ((Math.abs(h) % 20) + 1);
    }

    function shortLabel(s) {
        if (!s) return '';
        return s.length > 18 ? s.slice(0, 17) + '…' : s;
    }

    function formatPlayedAt(ts) {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        const now = new Date();
        const diffMs = now - d;
        const day = 86400_000;
        if (diffMs < day && d.getDate() === now.getDate()) {
            return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) + '  TODAY';
        }
        if (diffMs < 7 * day) {
            const days = Math.floor(diffMs / day);
            return `${days} ${days === 1 ? 'DAY' : 'DAYS'} AGO`;
        }
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Taipei' }).toUpperCase();
    }

    function sortPlays(plays, by) {
        const copy = [...plays];
        if (by === 'artist') {
            copy.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
        } else if (by === 'title') {
            copy.sort((a, b) => (a.song_name || '').localeCompare(b.song_name || ''));
        } else {
            copy.sort((a, b) => {
                const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return tb - ta;
            });
        }
        return copy;
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escAttr(s) {
        return String(s ?? '').replace(/['"<>\\]/g, c => `&#${c.charCodeAt(0)};`);
    }
    function cssEscape(s) {
        if (window.CSS && CSS.escape) return CSS.escape(s);
        return String(s).replace(/["\\]/g, '\\$&');
    }

    window.ViewLibrary = { init, show };
})();
