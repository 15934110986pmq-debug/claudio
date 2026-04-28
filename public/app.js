// ── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const bgA        = $('bg-a');
const bgB        = $('bg-b');
const albumStage = $('album-stage');
const albumFrame = $('album-frame');
const albumIdle  = $('album-idle');
const albumGlow  = $('album-glow');
const coverA     = $('cover-a');
const coverB     = $('cover-b');
const trackTitle = $('track-title');
const trackArtist= $('track-artist');
const trackBlock = document.querySelector('.track-block');
const djCard     = $('dj-card');
const djTextEl   = $('dj-text');
const djCursor   = $('dj-cursor');
const progressEl = $('progress');
const thumbEl    = $('progress-thumb');
const currentTimeEl = $('current-time');
const totalTimeEl   = $('total-time');
const playBtn    = $('play-btn');
const nextBtn    = $('next-btn');
const prevBtn    = $('prev-btn');
const statusLine = $('status-line');
const connDot    = $('conn-dot');
const eq         = $('eq');

// ── State ─────────────────────────────────────────────────────────────────────
let activeCover = 'a';   // which img layer is visible
let activeBg    = 'a';   // which bg layer is visible
let isPlaying   = false;
let isLoading   = false;
let typeTimer   = null;

const musicPlayer = new Audio();
const ttsPlayer   = new Audio();

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws;
let wsRetry = 0;

function connect() {
    const url = `ws://${location.host}/stream`;
    ws = new WebSocket(url);

    ws.onopen = () => {
        wsRetry = 0;
        connDot.classList.add('connected');
        setStatus('已连接');
    };

    ws.onclose = () => {
        connDot.classList.remove('connected');
        setStatus('连接断开…');
        const delay = Math.min(1000 * 2 ** wsRetry++, 16000);
        setTimeout(connect, delay);
    };

    ws.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }

        if (data.type === 'status') { setStatus(data.message); return; }
        if (data.type === 'error')  { setStatus('⚠ ' + data.message); setLoading(false); return; }
        if (data.type === 'now-playing') handleNowPlaying(data);
    };

    ws.onerror = () => {};
}

connect();

// ── Now Playing ───────────────────────────────────────────────────────────────
function handleNowPlaying({ track, dj }) {
    setLoading(false);

    // 1. 更新封面（交叉淡入）
    if (track.coverUrl) {
        updateCover(track.coverUrl);
        updateBackground(track.coverUrl);
    }

    // 2. 曲目信息切换动画
    trackBlock.classList.add('changing');
    setTimeout(() => {
        trackTitle.textContent  = track.name   || '—';
        trackArtist.textContent = track.artist || '';
        trackBlock.classList.remove('changing');
        trackTitle.classList.add('slide-in');
        trackArtist.classList.add('slide-in');
        setTimeout(() => {
            trackTitle.classList.remove('slide-in');
            trackArtist.classList.remove('slide-in');
        }, 500);
    }, 300);

    // 3. DJ 文字打字机
    if (dj?.say) typeWriter(dj.say);

    // 4. 播放音频（TTS → 音乐）
    setPlaying(true);
    albumIdle.classList.add('hidden');

    if (dj?.ttsUrl && track.audioUrl) {
        ttsPlayer.src = dj.ttsUrl;
        ttsPlayer.play().catch(() => {});
        ttsPlayer.onended = () => startMusic(track.audioUrl);
    } else if (track.audioUrl) {
        startMusic(track.audioUrl);
    } else if (dj?.ttsUrl) {
        ttsPlayer.src = dj.ttsUrl;
        ttsPlayer.play().catch(() => {});
    }
}

function startMusic(url) {
    musicPlayer.src = url;
    musicPlayer.play().catch(() => setStatus('无法自动播放，请点击播放键'));
}

// ── 封面交叉淡入 ──────────────────────────────────────────────────────────────
function updateCover(url) {
    const next = activeCover === 'a' ? 'b' : 'a';
    const nextEl = next === 'a' ? coverA : coverB;
    const prevEl = next === 'a' ? coverB : coverA;

    nextEl.src = url;
    albumFrame.classList.add('loading');

    nextEl.onload = () => {
        albumFrame.classList.remove('loading');
        nextEl.classList.add('active');
        prevEl.classList.remove('active');
        activeCover = next;
    };
    nextEl.onerror = () => albumFrame.classList.remove('loading');
}

// ── 背景模糊切换 ──────────────────────────────────────────────────────────────
function updateBackground(url) {
    const nextEl = activeBg === 'a' ? bgB : bgA;
    const prevEl = activeBg === 'a' ? bgA : bgB;

    nextEl.style.backgroundImage = `url(${url})`;
    nextEl.classList.remove('fade-out');
    prevEl.classList.add('fade-out');
    activeBg = activeBg === 'a' ? 'b' : 'a';
}

// ── 打字机效果 ────────────────────────────────────────────────────────────────
function typeWriter(text) {
    clearTimeout(typeTimer);
    djTextEl.textContent = '';
    djCursor.classList.add('typing');

    let i = 0;
    const tick = () => {
        if (i < text.length) {
            djTextEl.textContent += text[i++];
            typeTimer = setTimeout(tick, i < 8 ? 60 : 28);
        } else {
            djCursor.classList.remove('typing');
        }
    };
    tick();
}

// ── 进度条 ────────────────────────────────────────────────────────────────────
musicPlayer.addEventListener('timeupdate', () => {
    if (!musicPlayer.duration) return;
    const pct = musicPlayer.currentTime / musicPlayer.duration * 100;
    progressEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
    currentTimeEl.textContent = fmt(musicPlayer.currentTime);
    totalTimeEl.textContent   = fmt(musicPlayer.duration);
});

musicPlayer.addEventListener('ended', () => {
    sendWS({ action: 'next' });
    setStatus('换歌中…');
    setLoading(true);
});

musicPlayer.addEventListener('waiting', () => setStatus('缓冲中…'));
musicPlayer.addEventListener('playing', () => setStatus(''));

// 可拖动进度条
$('progress-rail').addEventListener('click', (e) => {
    if (!musicPlayer.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    musicPlayer.currentTime = (e.clientX - rect.left) / rect.width * musicPlayer.duration;
});

// ── 控制按钮 ──────────────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
    if (isLoading) return;

    if (!isPlaying) {
        if (musicPlayer.src) {
            musicPlayer.play().catch(() => {});
            setPlaying(true);
        } else {
            setLoading(true);
            setStatus('正在思考…');
            sendWS({ action: 'play' });
        }
    } else {
        musicPlayer.pause();
        ttsPlayer.pause();
        setPlaying(false);
        sendWS({ action: 'pause' });
    }
});

nextBtn.addEventListener('click', () => {
    musicPlayer.pause();
    ttsPlayer.pause();
    resetProgress();
    setLoading(true);
    setStatus('换歌中…');
    sendWS({ action: 'next' });
});

prevBtn.addEventListener('click', () => {
    if (musicPlayer.currentTime > 4) {
        musicPlayer.currentTime = 0;
    } else {
        musicPlayer.pause();
        ttsPlayer.pause();
        resetProgress();
        setLoading(true);
        sendWS({ action: 'play' });
    }
});

// ── 辅助函数 ──────────────────────────────────────────────────────────────────
function setPlaying(val) {
    isPlaying = val;
    playBtn.classList.toggle('playing', val);
    albumStage.classList.toggle('playing', val);
    eq.classList.toggle('active', val);
}

function setLoading(val) {
    isLoading = val;
    playBtn.classList.toggle('loading', val);
    albumFrame.classList.toggle('loading', val);
}

function setStatus(msg) {
    statusLine.textContent = msg;
}

function resetProgress() {
    progressEl.style.width = '0%';
    thumbEl.style.left = '0%';
    currentTimeEl.textContent = '0:00';
    totalTimeEl.textContent   = '0:00';
}

function sendWS(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
