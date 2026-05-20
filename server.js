require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

// ── Layers ────────────────────────────────────────────────────────────────────
const router = require('./src/layers/local-brain/router');
const scheduler = require('./src/layers/local-brain/scheduler');
const tts = require('./src/layers/local-brain/tts');
const state = require('./src/layers/local-brain/state');
const { fetchRealMusic } = require('./src/layers/external/youtube');
const { pushAudio } = require('./src/layers/external/upnp');
const { execFile } = require('child_process');
const { Readable } = require('stream');

// Proxy (optional — remove if not needed)
if (process.env.PROXY_URL) {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });
const bus = new EventEmitter();

app.use(express.json());
app.use(express.static('public'));

// Serve cached TTS audio files
app.use('/tts', express.static(path.join(__dirname, 'cache/tts')));

// ── HTTP API ──────────────────────────────────────────────────────────────────

// GET /api/plan/today — returns today's scheduled plan (or triggers one)
app.get('/api/plan/today', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    let plan = await state.getPlan(today).catch(() => null);

    if (!plan) {
        try {
            const result = await router.handle('为我规划今天的音频日程，输出一段简短描述。');
            plan = result.say || '今天我来为你随机选曲。';
            await state.savePlan(today, plan);
        } catch {
            plan = '今天随机模式。';
        }
    }

    res.json({ date: today, plan });
});

// POST /api/story — Claude-generated one-sentence editorial for a song.
// Cached in-memory by song_id so each track is only generated once per server lifetime.
const storyCache = new Map();
async function generateStory(songName, artist) {
    const prompt = `Write ONE short editorial sentence (16 words or fewer) about the song "${songName}" by "${artist || 'this artist'}", in the voice of a late-night American radio host introducing the record on air.

Be specific — reference an era, label, mood, production detail, or context if you know one. Avoid generic praise.

Hard rules:
- Do NOT start with "This", "A", "An", or "Here".
- Do NOT wrap in quotation marks.
- End with a period.
- Output the single sentence only — no preamble, no commentary, no JSON.`;
    return new Promise((resolve) => {
        const proc = require('child_process').spawn('claude', [
            '--print',
            '--output-format', 'json',
            '--model', 'claude-haiku-4-5-20251001',
            '--no-session-persistence'
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.stdin.write(prompt);
        proc.stdin.end();
        const timer = setTimeout(() => {
            console.warn('[Story] timeout 60s; stderr tail:', stderr.slice(-300));
            proc.kill('SIGKILL');
            resolve('');
        }, 60_000);
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) console.warn('[Story] exit', code, 'stderr:', stderr.slice(-200));
            try {
                const obj = JSON.parse(stdout.trim());
                if (obj.type === 'result' && obj.result) {
                    const story = obj.result.replace(/^["']|["']$/g, '').trim();
                    return resolve(story);
                }
                console.warn('[Story] unexpected output:', stdout.slice(0, 200));
            } catch (e) {
                console.warn('[Story] parse failed:', e.message, 'stdout:', stdout.slice(0, 200));
            }
            resolve('');
        });
        proc.on('error', (err) => { clearTimeout(timer); console.warn('[Story] spawn error:', err.message); resolve(''); });
    });
}

app.post('/api/story', async (req, res) => {
    const { song_id, song_name, artist } = req.body || {};
    if (!song_name) return res.status(400).json({ error: 'song_name required' });
    const key = song_id || `${song_name}|${artist}`;
    if (storyCache.has(key)) {
        return res.json({ story: storyCache.get(key), cached: true });
    }
    try {
        const story = await generateStory(song_name, artist || '');
        if (story) storyCache.set(key, story);
        res.json({ story });
    } catch (err) {
        console.error('[/api/story]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/auth/login — placeholder for future account system.
// Returns 501 so the frontend modal can render its error path while the real
// auth backend (user table, session, password hashing) is built later.
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: 'email 和 password 都是必填的' });
    }
    res.status(501).json({ error: '账号系统暂未启用，敬请期待。' });
});

// GET /audio/:videoId — streaming proxy for YouTube audio.
//
// yt-dlp resolves the IP-bound googlevideo URL (datacenter IPs like ours
// can't use the JS ytdl libraries — YouTube's anti-bot blocks them; yt-dlp
// still works). Then we fetch from that CDN URL with the client's Range
// header passed through, and pipe back. Supports HTTP Range so seek works.
const ytUrlCache = new Map();              // videoId → { url, mime, length, expiresAt }
const YT_CACHE_FALLBACK_MS = 60 * 60_000;  // 1h if no expire param parsed

function resolveStreamUrl(videoId) {
    const cached = ytUrlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);

    return new Promise((resolve, reject) => {
        execFile('yt-dlp', [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '-g', '--no-warnings',
            `https://www.youtube.com/watch?v=${videoId}`
        ], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim().slice(0, 200)));
            const url = stdout.trim().split('\n')[0];
            if (!url) return reject(new Error('empty yt-dlp output'));

            // Parse cheap metadata from URL params — saves a HEAD request.
            const params = new URL(url).searchParams;
            const mime = decodeURIComponent(params.get('mime') || 'audio/mp4');
            const length = parseInt(params.get('clen'), 10) || 0;
            const expSec = parseInt(params.get('expire'), 10);
            const expiresAt = expSec
                ? Math.min(expSec * 1000 - 60_000, Date.now() + YT_CACHE_FALLBACK_MS)
                : Date.now() + YT_CACHE_FALLBACK_MS;

            const entry = { url, mime, length, expiresAt };
            ytUrlCache.set(videoId, entry);
            resolve(entry);
        });
    });
}

app.get('/audio/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).send('Invalid video id');
    }

    try {
        const { url, mime } = await resolveStreamUrl(videoId);

        const headers = {};
        if (req.headers.range) headers.range = req.headers.range;

        const upstream = await fetch(url, { headers });
        if (!upstream.ok && upstream.status !== 206) {
            console.error('[Audio]', videoId, 'upstream', upstream.status);
            // Invalidate cache — URL may have expired despite our window
            ytUrlCache.delete(videoId);
            return res.status(502).send('Upstream ' + upstream.status);
        }

        res.status(upstream.status);
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', mime);
        if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on('error', (err) => {
            console.error('[Audio] pipe error:', err.message);
            if (!res.headersSent) res.status(502).end(); else res.end();
        });
        req.on('close', () => nodeStream.destroy());
        nodeStream.pipe(res);
    } catch (err) {
        console.error('[Audio]', videoId, 'failed:', err.message);
        if (!res.headersSent) res.status(502).send('Upstream failed');
    }
});

// GET /api/library — full play history for the library page
app.get('/api/library', async (req, res) => {
    const plays = await state.getAllPlays(500).catch(() => []);
    res.json({ plays });
});

// POST /api/play — play a specific song without going through Claude.
// Used by the Library when a card is clicked, and by replay-from-history flows.
app.post('/api/play', async (req, res) => {
    const { song_name, artist, song_id } = req.body || {};
    if (!song_name && !song_id) {
        return res.status(400).json({ error: 'song_name or song_id required' });
    }

    try {
        let track;
        // Fast path: if we already know the YouTube videoId (from a prior play),
        // skip the search entirely — saves a round-trip and avoids re-scoring.
        if (song_id && /^[a-zA-Z0-9_-]{11}$/.test(song_id)) {
            track = {
                id: song_id,
                name: song_name || '—',
                artist: artist || '',
                coverUrl: '',
                audioUrl: `/audio/${song_id}`
            };
        } else {
            track = await fetchRealMusic(song_name, artist || '');
            if (!track) return res.status(404).json({ error: '未找到该歌曲' });
        }

        await state.savePlay({
            id: track.id || '',
            name: track.name,
            artist: track.artist,
            coverUrl: track.coverUrl
        }).catch(() => {});

        res.json({ ok: true, track });
    } catch (err) {
        console.error('[/api/play]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/chat — text input from the player UI
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    try {
        await state.saveMessage('user', message);
        const result = await router.handle(message);
        await state.saveMessage('assistant', result.say || '');

        if (result.action === 'BROADCAST' && result.play?.length > 0) {
            broadcastResult(result);
        }

        res.json({ ok: true, say: result.say });
    } catch (err) {
        console.error('[/api/chat]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('[WS] 前端已连接');

    // Forward bus events to this client
    const onBroadcast = (payload) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    };
    bus.on('broadcast', onBroadcast);

    ws.on('message', async (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        if (data.action === 'play') {
            ws.send(JSON.stringify({ type: 'status', message: '正在为你思考...' }));
            try {
                const result = await router.handle('根据当前时间和我的心情推荐一首歌。');
                await broadcastResult(result, ws);
            } catch (err) {
                console.error('[WS play]', err.message);
                ws.send(JSON.stringify({ type: 'error', message: '大脑出错了，请检查终端。' }));
            }
        }

        if (data.action === 'next') {
            ws.send(JSON.stringify({ type: 'status', message: '换一首...' }));
            try {
                const result = await router.handle('换一首，风格可以稍有不同。');
                await broadcastResult(result, ws);
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: '换歌失败。' }));
            }
        }

        if (data.action === 'pause') {
            // Client-side only; nothing to do server-side
        }
    });

    ws.on('close', () => {
        bus.off('broadcast', onBroadcast);
        console.log('[WS] 前端已断开');
    });
});

// ── Core broadcast logic ──────────────────────────────────────────────────────
async function broadcastResult(result, directWs = null) {
    const send = (payload) => {
        if (directWs) {
            if (directWs.readyState === WebSocket.OPEN) directWs.send(JSON.stringify(payload));
        } else {
            bus.emit('broadcast', payload);
        }
    };

    // 1. TTS: convert DJ speech to audio
    let ttsUrl = null;
    if (result.say) {
        ttsUrl = await tts.textToSpeech(result.say).catch(() => null);
    }

    // 2. Resolve music from Netease
    let track = null;
    if (result.play?.length > 0) {
        const rec = result.play[0];
        const music = await fetchRealMusic(rec.name, rec.artist).catch(() => null);
        if (music) {
            track = music;
            await state.savePlay({ id: music.id || '', name: music.name, artist: music.artist, coverUrl: music.coverUrl }).catch(() => {});

            // Pre-warm yt-dlp URL resolution. Without this, the browser's first
            // GET /audio/:videoId blocks ~5-10s on yt-dlp cold spawn. Kicking it
            // off here means by the time the client hits the route, the URL
            // and metadata are already in ytUrlCache.
            if (music.id) {
                resolveStreamUrl(music.id).catch(err => {
                    console.warn('[Audio] pre-warm failed:', err.message);
                });
            }
        }
    }

    // 3. Push to UPnP speaker (if configured)
    if (track?.audioUrl) {
        pushAudio(track.audioUrl).catch(() => {});
    }

    // 4. Broadcast to PWA
    send({
        type: 'now-playing',
        dj: { say: result.say, ttsUrl },
        track: track || { name: result.say ? '(仅 DJ 播报)' : '暂无', artist: '', coverUrl: '', audioUrl: '' }
    });
}

// SPA fallback — serve index.html for client-side routes so direct loads /
// refreshes on /library and /stack work. Must come AFTER /api and static.
app.get(['/library', '/stack'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Scheduler wiring ──────────────────────────────────────────────────────────
scheduler.setBroadcaster(async (input, extras) => {
    const result = await router.handle(input, extras);
    if (result.action === 'BROADCAST') {
        await broadcastResult(result);
    }
});

scheduler.init();

// ── Start ─────────────────────────────────────────────────────────────────────
function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const dev of Object.values(ifaces)) {
        for (const alias of dev) {
            if (alias.family === 'IPv4' && !alias.internal) return alias.address;
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`\n🎙️  Claudio 已启动`);
    console.log(`   本地访问: http://localhost:${PORT}`);
    console.log(`   局域网  : http://${ip}:${PORT}\n`);
});
