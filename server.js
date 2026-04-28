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
const { fetchRealMusic } = require('./src/layers/external/netease');
const { pushAudio } = require('./src/layers/external/upnp');

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
            await state.savePlay({ id: music.id || '', name: music.name, artist: music.artist }).catch(() => {});
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
