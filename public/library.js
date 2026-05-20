// Claudio Library — grid + sticky mini-player.
//
// Three jobs:
// 1. Render the album grid from /api/library (or a Signature fallback).
// 2. Mini-player at top — hydrates from localStorage so audio continues
//    when coming from the full Player page.
// 3. Click any card → POST /api/play → mini-player plays that song.

// ── DOM refs ────────────────────────────────────────────────────────────────
const grid           = document.getElementById('grid');
const titleCount     = document.getElementById('title-count');
const hint           = document.getElementById('hint');
const controlButtons = document.querySelectorAll('.control');

const mini           = document.getElementById('mini-player');
const miniCover      = document.getElementById('mini-cover');
const miniTitle      = document.getElementById('mini-title');
const miniArtist     = document.getElementById('mini-artist');
const miniPlay       = document.getElementById('mini-play');
const miniPlayIcon   = document.getElementById('mini-play-icon');
const miniNext       = document.getElementById('mini-next');
const miniTrackEl    = document.getElementById('mini-progress-track');
const miniFill       = document.getElementById('mini-progress-fill');

const audio = new Audio();
audio.preload = 'auto';

const playSVG  = `<path d="M7 4 L20 12 L7 20 Z"/>`;
const pauseSVG = `<rect x="6" y="5" width="4" height="14" rx="0.5"/><rect x="14" y="5" width="4" height="14" rx="0.5"/>`;

let ws = null;
let currentSongId = null;

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

// ── Boot ────────────────────────────────────────────────────────────────────
restoreMiniPlayer();
bootWebSocket();
loadLibrary();
bindMiniControls();
bindGlobalAudioEvents();

// ── Library data ────────────────────────────────────────────────────────────
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

controlButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        controlButtons.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        state.sort = btn.dataset.sort;
        render();
    });
});

// ── Card interactions (click-to-play + 3D tilt) ─────────────────────────────
function bindCardInteractions() {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    document.querySelectorAll('.album').forEach(album => {
        album.addEventListener('click', () => {
            playByCardData(album.dataset);
        });
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
    const artist = d.songArtist || '';
    const song_id = d.songId || null;
    const cover_url = d.cover || '';
    if (!song_name) return;

    // Optimistic: show the mini-player immediately with what the card knows
    showMini({ name: song_name, artist, coverUrl: cover_url });
    markPlayingCard(song_id);

    try {
        const res = await fetch('/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ song_name, artist, song_id })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const { track } = await res.json();
        startAudio(track);
    } catch (err) {
        console.error('[library] /api/play failed:', err.message);
        miniTitle.textContent = '播放失败';
        miniArtist.textContent = err.message;
    }
}

function markPlayingCard(songId) {
    document.querySelectorAll('.album.is-now-playing').forEach(a => a.classList.remove('is-now-playing'));
    if (!songId) return;
    const target = document.querySelector(`.album[data-song-id="${cssEscape(songId)}"]`);
    if (target) target.classList.add('is-now-playing');
}

// ── Mini-player rendering + audio start ─────────────────────────────────────
function showMini(track) {
    mini.hidden = false;
    miniTitle.textContent = track.name || '—';
    miniArtist.textContent = track.artist || '';
    if (track.coverUrl) {
        miniCover.style.backgroundImage = `url("${track.coverUrl}")`;
    } else {
        miniCover.style.backgroundImage = '';
    }
}

function startAudio(track) {
    audio.src = track.audioUrl;
    currentSongId = track.id || null;
    showMini({ name: track.name, artist: track.artist, coverUrl: track.coverUrl });
    audio.play()
        .then(() => setPlayingIcon(true))
        .catch((err) => {
            console.warn('[library] autoplay blocked:', err.message);
            setPlayingIcon(false);
        });
    ClaudioAudio.save({
        src: track.audioUrl,
        currentTime: 0,
        isPlaying: true,
        track: {
            name: track.name,
            artist: track.artist,
            coverUrl: track.coverUrl,
            songId: track.id || ''
        }
    });
}

function setPlayingIcon(playing) {
    if (miniPlayIcon) miniPlayIcon.innerHTML = playing ? pauseSVG : playSVG;
}

// ── Restore from localStorage when navigating in from Player ────────────────
function restoreMiniPlayer() {
    const s = ClaudioAudio.load();
    if (!s || !s.src || !s.track) return;

    showMini(s.track);
    audio.src = s.src;
    currentSongId = s.track.songId || null;

    audio.addEventListener('loadedmetadata', () => {
        if (typeof s.currentTime === 'number' && s.currentTime > 0) {
            try { audio.currentTime = s.currentTime; } catch {}
        }
    }, { once: true });

    if (s.isPlaying) {
        audio.play()
            .then(() => setPlayingIcon(true))
            .catch(() => setPlayingIcon(false));   // autoplay can be blocked w/o gesture
    } else {
        setPlayingIcon(false);
    }
}

// ── Mini controls ───────────────────────────────────────────────────────────
function bindMiniControls() {
    miniPlay?.addEventListener('click', () => {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });

    miniNext?.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            audio.pause();
            ws.send(JSON.stringify({ action: 'next' }));
        }
    });

    miniTrackEl?.addEventListener('click', (e) => {
        if (!audio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pct * audio.duration;
    });
}

function bindGlobalAudioEvents() {
    let lastSave = 0;
    audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        miniFill.style.width = (audio.currentTime / audio.duration * 100) + '%';
        const now = Date.now();
        if (now - lastSave > 1500) {
            lastSave = now;
            ClaudioAudio.save({ currentTime: audio.currentTime });
        }
    });
    audio.addEventListener('play',  () => { setPlayingIcon(true);  ClaudioAudio.save({ isPlaying: true });  });
    audio.addEventListener('pause', () => { setPlayingIcon(false); ClaudioAudio.save({ isPlaying: false }); });
    audio.addEventListener('ended', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'next' }));
        }
    });
    window.addEventListener('pagehide', () => {
        ClaudioAudio.save({ currentTime: audio.currentTime, isPlaying: !audio.paused });
    });
}

// ── WebSocket — receive now-playing events when Claude picks a new song ─────
function bootWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/stream`);

    ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type !== 'now-playing') return;

        const { track, dj } = data;
        if (!track?.audioUrl) return;

        showMini({ name: track.name, artist: track.artist, coverUrl: track.coverUrl });
        audio.src = track.audioUrl;
        currentSongId = track.id || null;
        audio.play().then(() => setPlayingIcon(true)).catch(() => setPlayingIcon(false));

        ClaudioAudio.save({
            src: track.audioUrl,
            currentTime: 0,
            isPlaying: true,
            track: {
                name: track.name,
                artist: track.artist,
                coverUrl: track.coverUrl,
                songId: track.id || ''
            },
            djSay: dj?.say || ''
        });

        // Refresh the grid so the new play row appears
        loadLibrary();
    };
}

// ── Tiny helpers ────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
}
function escAttr(s) {
    return String(s ?? '').replace(/['"<>\\]/g, c => `&#${c.charCodeAt(0)};`);
}
function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
}
