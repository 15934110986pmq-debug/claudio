// Claudio Stack — 3D stacked-records library view with in-page player overlay.
//
// Pulls /api/library, renders the most recent 11 plays as stacked cards, applies
// mouse-driven parallax, and on ▶ LISTEN does a FLIP transition that flies the
// cover to the player overlay's slot. The audio element is shared between the
// overlay and a sticky now-chip so playback survives overlay open/close.

// ── DOM refs ────────────────────────────────────────────────────────────────
const stackEl   = document.getElementById('stack');
const stack3d   = document.getElementById('stack3d');
const pageMeta  = document.getElementById('page-meta');
const audio     = document.getElementById('audio');
audio.preload = 'auto';

const nowChip       = document.getElementById('now-chip');
const nowChipCover  = document.getElementById('now-chip-cover');
const nowChipTitle  = document.getElementById('now-chip-title');
const nowChipArtist = document.getElementById('now-chip-artist');
const nowChipPlay   = document.getElementById('now-chip-play');

const playerEl       = document.getElementById('player');
const coverSlot      = document.getElementById('cover-slot');
const playerTitle    = document.getElementById('player-title');
const playerArtist   = document.getElementById('player-artist');
const playerAlbum    = document.getElementById('player-album');
const playerLyrics   = document.getElementById('player-lyrics');
const playerCurrent  = document.getElementById('player-current');
const playerTotal    = document.getElementById('player-total');
const playerFill     = document.getElementById('player-fill');
const playerBar      = document.getElementById('player-bar');
const playerPlay     = document.getElementById('player-play');
const playerPlayIcon = document.getElementById('player-play-icon');
const playerPrev     = document.getElementById('player-prev');
const playerNext     = document.getElementById('player-next');
const playerClose    = document.getElementById('player-close');
const eqBars         = document.querySelectorAll('#player-eq .eq-bar');

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

let ws = null;
let plays = [];
let currentFloater = null;
let sourceEl = null;       // The DOM element the floater came from (.cover or .now-chip-cover)
let currentTrack = null;   // {name, artist, coverUrl, songId} of what's loaded in <audio>

// ── Boot ────────────────────────────────────────────────────────────────────
restoreFromState();
loadLibrary();
bootWebSocket();
bindMouseParallax();
bindGlobalAudioEvents();
bindOverlayControls();
bindKeyboard();
bindMoreMenuAndAuth();

// ── Library data ────────────────────────────────────────────────────────────
async function loadLibrary() {
    try {
        const res = await fetch('/api/library', { cache: 'no-store' });
        const data = await res.json();
        const all = Array.isArray(data.plays) ? data.plays : [];

        if (all.length === 0) {
            plays = SIGNATURE_FALLBACK;
            pageMeta.textContent = '— signature';
        } else {
            plays = all.slice(0, 11);
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
                    <div class="strip-nav"><span>About</span><span>Tracks</span><span>Story</span></div>
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
                            <p class="preview-text">${escHtml(preview)}</p>
                        </div>
                        <button class="listen-btn" type="button">▶ LISTEN</button>
                    </div>
                </div></div>
            </div>
        `;
    }).join('');

    // Open the top (most recent) card by default
    const firstCard = stackEl.querySelector('.card');
    if (firstCard) firstCard.classList.add('active');

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
            if (diffMs < day) {
                return 'Played today on your Taipei radio.';
            }
            if (diffMs < 7 * day) {
                const days = Math.floor(diffMs / day);
                return `Played ${days} ${days === 1 ? 'day' : 'days'} ago. The kind of record that finds you again.`;
            }
            return 'From an older session. Worth a return visit.';
        }
    }
    return 'From your signature pool — not yet played, but waiting.';
}

// ── Card interactions ──────────────────────────────────────────────────────
function bindCardClicks() {
    const cards = stackEl.querySelectorAll('.card');
    cards.forEach(card => {
        card.addEventListener('click', (e) => {
            // The LISTEN button has its own handler — don't toggle on it
            if (e.target.closest('.listen-btn')) return;

            const wasActive = card.classList.contains('active');
            cards.forEach(c => c.classList.remove('active'));
            if (!wasActive) {
                card.classList.add('active');
                setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
            }
        });

        const listenBtn = card.querySelector('.listen-btn');
        listenBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            openPlayerFromCard(card);
        });
    });
}

// ── Mouse parallax tilt ────────────────────────────────────────────────────
function bindMouseParallax() {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    let tgtY = 0, tgtX = 0, curY = 0, curX = 0;
    document.addEventListener('mousemove', (e) => {
        if (document.body.classList.contains('player-open')) return;
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        tgtY = x * 5;
        tgtX = -y * 2.5 + 1;
    });
    function frame() {
        curY += (tgtY - curY) * 0.08;
        curX += (tgtX - curX) * 0.08;
        stack3d.style.transform = `rotateX(${curX}deg) rotateY(${curY}deg)`;
        requestAnimationFrame(frame);
    }
    frame();
}

// ── Open player from a card via FLIP transition ────────────────────────────
async function openPlayerFromCard(card) {
    const d = card.dataset;
    const accent = d.accent || '#a3e635';
    const song_name = d.songName;
    const artist = d.songArtist;
    const song_id = d.songId || null;

    document.documentElement.style.setProperty('--player-accent', accent);
    playerTitle.textContent = song_name || '—';
    playerArtist.textContent = artist || '—';
    playerAlbum.textContent = formatOverline({ artist, timestamp: null });
    playerLyrics.textContent = song_name || '';

    flyCoverToOverlay(card.querySelector('.cover'));

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
        startAudio(track);
    } catch (err) {
        console.error('[stack] /api/play failed:', err.message);
        playerLyrics.textContent = 'Playback failed: ' + err.message;
    }
}

// ── Open player from now-chip (when audio was restored) ────────────────────
function openPlayerFromChip() {
    if (!currentTrack) return;
    playerTitle.textContent = currentTrack.name || '—';
    playerArtist.textContent = currentTrack.artist || '—';
    playerAlbum.textContent = (currentTrack.artist || '').toUpperCase();
    playerLyrics.textContent = currentTrack.djSay || currentTrack.name || '';
    flyCoverToOverlay(nowChipCover, /* fromChip */ true);
}

// FLIP transition: clone the source element, fly it to the cover-slot.
// Hides the source until close. fromChip controls how to recover.
function flyCoverToOverlay(source, fromChip = false) {
    sourceEl = source;
    const sourceRect = source.getBoundingClientRect();

    // Hide source while floater takes over
    source.style.visibility = 'hidden';

    const floater = source.cloneNode(true);
    floater.classList.remove('now-chip-cover');
    floater.classList.add('cover-floater', 'flying-out');
    floater.style.cssText = `
        position: fixed;
        left: ${sourceRect.left}px;
        top: ${sourceRect.top}px;
        width: ${sourceRect.width}px;
        height: ${sourceRect.height}px;
        margin: 0;
        z-index: 9999;
        visibility: visible;
        opacity: 1;
        border-radius: ${fromChip ? '50%' : '4px'};
    `;
    document.body.appendChild(floater);
    currentFloater = floater;

    document.body.classList.add('player-open');

    // Two-frame wait so overlay layout settles before measuring target
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = coverSlot.getBoundingClientRect();
        floater.classList.add('in-player');
        floater.style.left = target.left + 'px';
        floater.style.top = target.top + 'px';
        floater.style.width = target.width + 'px';
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
    currentFloater.style.left = r.left + 'px';
    currentFloater.style.top = r.top + 'px';
    currentFloater.style.width = r.width + 'px';
    currentFloater.style.height = r.height + 'px';
    currentFloater.style.borderRadius = sourceEl.classList.contains('now-chip-cover') ? '50%' : '4px';

    // Stack "inhale" — quick scale-down on the inner stack so it feels alive
    stackEl.style.transition = 'transform 0.25s ease-in';
    stackEl.style.transform = 'scale(0.97)';
    setTimeout(() => {
        stackEl.style.transition = 'transform 0.7s var(--strong-spring)';
        stackEl.style.transform = '';
    }, 250);

    setTimeout(() => {
        if (currentFloater) currentFloater.remove();
        if (sourceEl && sourceEl.style) sourceEl.style.visibility = '';
        currentFloater = null;
        sourceEl = null;
    }, 950);
}

// ── Real audio start + state persistence ───────────────────────────────────
function startAudio(track) {
    audio.src = track.audioUrl;
    currentTrack = {
        name: track.name,
        artist: track.artist,
        coverUrl: track.coverUrl,
        songId: track.id || ''
    };
    audio.play().then(() => setPlayingIcon(true)).catch(() => setPlayingIcon(false));
    updateNowChip(currentTrack);
    ClaudioAudio.save({
        src: track.audioUrl,
        currentTime: 0,
        isPlaying: true,
        track: currentTrack
    });
}

function updateNowChip(track) {
    nowChip.hidden = false;
    nowChipTitle.textContent = track.name || '—';
    nowChipArtist.textContent = (track.artist || '').toUpperCase();
    if (track.coverUrl) nowChipCover.style.backgroundImage = `url("${track.coverUrl}")`;
    else nowChipCover.style.backgroundImage = '';
}

function setPlayingIcon(playing) {
    if (playerPlayIcon) playerPlayIcon.innerHTML = playing ? pauseSVG : playSVG;
    if (nowChipPlay)    nowChipPlay.textContent  = playing ? '⏸' : '▶';
}

// ── Cross-page restore from localStorage ───────────────────────────────────
function restoreFromState() {
    const s = ClaudioAudio.load();
    if (!s || !s.src || !s.track) return;

    audio.src = s.src;
    currentTrack = { ...s.track, djSay: s.djSay };

    audio.addEventListener('loadedmetadata', () => {
        if (typeof s.currentTime === 'number' && s.currentTime > 0) {
            try { audio.currentTime = s.currentTime; } catch {}
        }
    }, { once: true });

    updateNowChip(currentTrack);

    if (s.isPlaying) {
        audio.play().then(() => setPlayingIcon(true)).catch(() => setPlayingIcon(false));
    } else {
        setPlayingIcon(false);
    }
}

// ── Audio events ───────────────────────────────────────────────────────────
function bindGlobalAudioEvents() {
    let lastSave = 0;

    audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        playerFill.style.width = pct + '%';
        playerCurrent.textContent = fmt(audio.currentTime);
        playerTotal.textContent = fmt(audio.duration);

        const now = Date.now();
        if (now - lastSave > 1500) {
            lastSave = now;
            ClaudioAudio.save({ currentTime: audio.currentTime });
        }
    });

    audio.addEventListener('play',  () => { setPlayingIcon(true);  ClaudioAudio.save({ isPlaying: true });  });
    audio.addEventListener('pause', () => { setPlayingIcon(false); ClaudioAudio.save({ isPlaying: false }); });
    audio.addEventListener('ended', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'next' }));
    });

    window.addEventListener('pagehide', () => {
        ClaudioAudio.save({ currentTime: audio.currentTime, isPlaying: !audio.paused });
    });
}

// ── Overlay + chip controls ────────────────────────────────────────────────
function bindOverlayControls() {
    playerClose.addEventListener('click', closePlayer);

    playerPlay.addEventListener('click', () => {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });

    playerNext.addEventListener('click', () => {
        audio.pause();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'next' }));
    });

    playerPrev.addEventListener('click', () => {
        // Backend has no prev route — silent no-op for now
    });

    playerBar.addEventListener('click', (e) => {
        if (!audio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pct * audio.duration;
    });

    // Now-chip: clicking the play icon toggles audio; clicking the rest opens overlay
    nowChip.addEventListener('click', (e) => {
        if (e.target.closest('.now-chip-play')) {
            e.stopPropagation();
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
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

// ── Keyboard nav ───────────────────────────────────────────────────────────
function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
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

// ── EQ (cosmetic) ──────────────────────────────────────────────────────────
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

// ── WebSocket — react to cron-triggered now-playing ────────────────────────
function bootWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/stream`);

    ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type !== 'now-playing') return;
        const { track, dj } = data;
        if (!track?.audioUrl) return;

        currentTrack = {
            name: track.name,
            artist: track.artist,
            coverUrl: track.coverUrl,
            songId: track.id || '',
            djSay: dj?.say || ''
        };

        updateNowChip(currentTrack);

        if (document.body.classList.contains('player-open')) {
            playerTitle.textContent = track.name || '—';
            playerArtist.textContent = track.artist || '—';
            playerLyrics.textContent = dj?.say || track.name || '';
        }

        audio.src = track.audioUrl;
        audio.play().then(() => setPlayingIcon(true)).catch(() => setPlayingIcon(false));

        ClaudioAudio.save({
            src: track.audioUrl,
            currentTime: 0,
            isPlaying: true,
            track: currentTrack,
            djSay: dj?.say || ''
        });

        // Refresh the stack so the new play floats to the top
        loadLibrary();
    };
}

// ── More menu (•••) + auth modal ───────────────────────────────────────────
function bindMoreMenuAndAuth() {
    const moreBtn      = document.getElementById('more-btn');
    const moreDropdown = document.getElementById('more-dropdown');
    const authModal    = document.getElementById('auth-modal');
    const authBackdrop = document.getElementById('auth-backdrop');
    const authClose    = document.getElementById('auth-close');
    const authForm     = document.getElementById('auth-form');
    const authEmail    = document.getElementById('auth-email');
    const authPassword = document.getElementById('auth-password');
    const authError    = document.getElementById('auth-error');
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

    // Click anywhere else → close menu
    document.addEventListener('click', (e) => {
        if (moreDropdown.hidden) return;
        if (e.target.closest('.more-menu')) return;
        setMenuOpen(false);
    });

    moreDropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.more-item[data-action]:not(:disabled)');
        if (!item) return;
        setMenuOpen(false);
        if (item.dataset.action === 'login') openAuthModal();
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
        authForm?.reset();
    }

    authBackdrop?.addEventListener('click', closeAuthModal);
    authClose?.addEventListener('click', closeAuthModal);

    // Esc closes modal first, then menu
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (authModal && !authModal.hidden) { closeAuthModal(); return; }
        if (!moreDropdown.hidden) { setMenuOpen(false); }
    });

    authForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        authError.hidden = true;
        const email    = authEmail.value.trim();
        const password = authPassword.value;
        if (!email || !password) {
            authError.textContent = '请输入邮箱和密码';
            authError.hidden = false;
            return;
        }

        authSubmit.disabled = true;
        const original = authSubmit.textContent;
        authSubmit.textContent = 'Signing in…';
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `登录失败 (${res.status})`);
            // Real auth not implemented yet — when it is, replace this branch
            // with: persist session, update UI, close modal.
            closeAuthModal();
        } catch (err) {
            authError.textContent = err.message;
            authError.hidden = false;
        } finally {
            authSubmit.disabled = false;
            authSubmit.textContent = original;
        }
    });
}

// ── Tiny helpers ───────────────────────────────────────────────────────────
function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
}
function escAttr(s) {
    return String(s ?? '').replace(/['"<>\\]/g, c => `&#${c.charCodeAt(0)};`);
}
