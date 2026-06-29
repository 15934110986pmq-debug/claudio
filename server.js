require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const logger = require('./src/lib/logger');
const rateLimit = require('express-rate-limit');

// ── Layers ────────────────────────────────────────────────────────────────────
const push = require('./src/layers/external/push');
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

// Rate limiting
const writeRateLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down a bit.' }
});
const authRateLimit = rateLimit({
    windowMs: 60 * 60_000,
    max: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in requests — try later.' }
});

// ── WebPush init ──────────────────────────────────────────────────────────────
try {
    const pubKey = push.publicKey();
    console.log('[push] VAPID public key:', pubKey.slice(0, 20) + '...');
} catch (e) {
    console.warn('[push] init failed:', e.message);
}

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

app.post('/api/story', writeRateLimit, async (req, res) => {
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

// ── Session middleware ────────────────────────────────────────────────────────
// Reads the claudio_session cookie and attaches req.user (or null for anon).
app.use(async (req, res, next) => {
    const raw = req.headers.cookie || '';
    const match = raw.match(/(?:^|;\s*)claudio_session=([^;]+)/);
    if (match) {
        try {
            const user = await state.getUserBySession(decodeURIComponent(match[1]));
            req.user = user || null;
        } catch {
            req.user = null;
        }
    } else {
        req.user = null;
    }
    next();
});

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /api/auth/request-link — send a magic sign-in link.
app.post('/api/auth/request-link', authRateLimit, async (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'valid email required' });
    }
    try {
        const mailer = require('./src/layers/external/mailer');
        const user = await state.getOrCreateUser(email.trim().toLowerCase());
        const { token } = await state.createMagicLink(user.email);
        const result = await mailer.sendMagicLink(user.email, token);
        const response = { ok: true, delivered: result.delivered };
        if (!result.delivered) {
            // Dev mode: build the link from the actual request host so it works
            // when the server sits behind a reverse proxy / tunnel (Cloudflare,
            // ngrok, …) — the env-based URL from mailer.js may point to
            // localhost which is unreachable from the visitor's device.
            const xfHost  = req.get('x-forwarded-host')  || req.get('host');
            const xfProto = req.get('x-forwarded-proto') || req.protocol || 'http';
            response.devLink = `${xfProto}://${xfHost}/api/auth/verify?token=${encodeURIComponent(token)}`;
        }
        res.json(response);
    } catch (err) {
        logger.error({ err, route: '/api/auth/request-link' }, 'request-link error');
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auth/verify — consume magic link token, set session cookie.
app.get('/api/auth/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
        const result = await state.consumeMagicLink(token);
        if (!result.ok) return res.status(400).json({ error: result.reason });
        const user = await state.getOrCreateUser(result.email);
        const session = await state.createSession(user.id);
        res.setHeader('Set-Cookie',
            `claudio_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
        );
        // Redirect to app — the onboarding wizard will auto-open if needed.
        res.redirect('/');
    } catch (err) {
        logger.error({ err, route: '/api/auth/verify' }, 'verify error');
        res.status(500).json({ error: err.message });
    }
});

// GET /api/auth/me — current session user (or null for anon).
app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user || null });
});

// POST /api/auth/signout — clear session cookie and invalidate server-side.
app.post('/api/auth/signout', async (req, res) => {
    const raw = req.headers.cookie || '';
    const match = raw.match(/(?:^|;\s*)claudio_session=([^;]+)/);
    if (match) {
        await state.deleteSession(decodeURIComponent(match[1])).catch(() => {});
    }
    res.setHeader('Set-Cookie', 'claudio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
});

// ── Onboarding routes ─────────────────────────────────────────────────────────

// GET /api/onboarding/state — returns auth status + current taste for prefill.
app.get('/api/onboarding/state', async (req, res) => {
    if (!req.user) return res.json({ user: null, taste: null });
    try {
        const taste = await state.getUserTaste(req.user.id);
        res.json({
            user: { id: req.user.id, email: req.user.email, onboarded: !!req.user.onboarded_at },
            taste
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/onboarding/save — persist user taste from the wizard.
app.post('/api/onboarding/save', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { artistsLove, artistsAvoid, timePrefs, moodSeeds, weatherCity } = req.body || {};
    try {
        await state.saveUserTaste(req.user.id, {
            artistsLove:  Array.isArray(artistsLove)  ? artistsLove  : [],
            artistsAvoid: Array.isArray(artistsAvoid) ? artistsAvoid : [],
            timePrefs:    typeof timePrefs === 'object' && timePrefs ? timePrefs : {},
            moodSeeds:    Array.isArray(moodSeeds)    ? moodSeeds    : [],
            weatherCity:  typeof weatherCity === 'string' ? weatherCity.trim() : null
        });
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, route: '/api/onboarding/save' }, 'save taste error');
        res.status(500).json({ error: err.message });
    }
});

// ── Taste import routes ───────────────────────────────────────────────────────

// POST /api/import/extract — accept free-form text, return cleaned list of
// artist names. Uses the brain provider's generateResponse() with an
// extraction-specific prompt. Auth required (this only makes sense for users
// who have a taste profile to merge into).
app.post('/api/import/extract', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 5) {
        return res.status(400).json({ error: 'paste at least a few characters' });
    }
    if (text.length > 50_000) {
        return res.status(400).json({ error: 'too long — paste under 50K characters' });
    }
    try {
        await checkLlmQuota(req);
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }

    const claude = require('./src/layers/local-brain/claude');
    const extractionPrompt = `Extract music artist or band names from the following text dump (could be a Spotify CSV, an Apple Music playlist, a list, an email, anything). Return ONLY a JSON object with this shape — no preamble, no markdown fence:

{"artists": ["Name 1", "Name 2", ...]}

Rules:
- Deduplicate. Case-insensitive but preserve original capitalization (the most common form wins).
- Include at most 60 artists. If more are present, pick the most prominent (highest play count, repeated mentions, etc.).
- Skip anything that's clearly a song title, album, genre, or date.
- Trim whitespace. No quotes around names.
- If the input has zero recognizable artists, return {"artists": []}.

TEXT TO EXTRACT FROM:
\`\`\`
${text}
\`\`\``;

    try {
        const result = await claude.generateResponse(extractionPrompt);
        // The brain's contract returns {say, play[], reason, segue} for DJ prompts,
        // but for this extraction prompt we expect {artists: [...]}. If the LLM
        // followed instructions, result.artists will be the array we need.
        const artists = Array.isArray(result?.artists)
            ? result.artists.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 60)
            : [];
        res.json({ ok: true, artists, count: artists.length });
    } catch (err) {
        logger.error({ err, route: '/api/import/extract' }, 'extract failed');
        res.status(500).json({ error: 'extraction failed' });
    }
});

// POST /api/import/merge — append (deduped) artists to current user_taste.
// Frontend sends final selected list after user reviews the extraction.
app.post('/api/import/merge', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { artists } = req.body || {};
    if (!Array.isArray(artists)) return res.status(400).json({ error: 'artists array required' });

    try {
        const existing = await state.getUserTaste(req.user.id) || {};
        const seen = new Set((existing.artistsLove || []).map(s => s.toLowerCase().trim()));
        const merged = [...(existing.artistsLove || [])];
        for (const a of artists) {
            if (typeof a !== 'string') continue;
            const key = a.toLowerCase().trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            merged.push(a.trim());
        }
        await state.saveUserTaste(req.user.id, {
            ...existing,
            artistsLove: merged.slice(0, 200)  // cap total so the prompt doesn't blow up
        });
        res.json({ ok: true, totalArtists: merged.length, added: merged.length - (existing.artistsLove?.length || 0) });
    } catch (err) {
        logger.error({ err, route: '/api/import/merge' }, 'merge failed');
        res.status(500).json({ error: 'merge failed' });
    }
});

// POST /api/auth/login — legacy placeholder kept for older frontend references.
app.post('/api/auth/login', authRateLimit, (req, res) => {
    res.status(410).json({ error: 'Use /api/auth/request-link instead.' });
});

// ── Persona routes ─────────────────────────────────────────────────────────────

const PERSONAS = [
    { id: 'default',    name: 'Claudio',     description: 'Warm, late-night jazz radio default' },
    { id: 'morning',    name: 'Morning',     description: 'Bright but quiet — alert without overload' },
    { id: 'late-night', name: 'Late Night',  description: 'Low energy, intimate, lots of space' },
    { id: 'deep-cuts',  name: 'Deep Cuts',   description: 'Record-store nerd, obscure picks' }
];

// GET /api/personas — list available personas (builtins + user's custom)
app.get('/api/personas', async (req, res) => {
    let custom = [];
    let current = null;
    if (req.user) {
        try {
            const customRows = await state.listCustomPersonas(req.user.id);
            custom = customRows.map(r => ({
                id: `custom:${r.id}`,
                name: r.name,
                description: 'Custom — your own DJ',
                builtin: false
            }));
            const taste = await state.getUserTaste(req.user.id);
            current = taste?.persona || null;
        } catch (err) {
            console.error('[/api/personas]', err.message);
        }
    }
    res.json({
        personas: [
            ...PERSONAS.map(p => ({ ...p, builtin: true })),
            ...custom
        ],
        current
    });
});

// POST /api/persona — set the authenticated user's chosen persona
app.post('/api/persona', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { persona } = req.body || {};
    const builtin = PERSONAS.map(p => p.id);
    let valid = builtin.includes(persona);
    if (!valid && typeof persona === 'string' && persona.startsWith('custom:')) {
        const id = parseInt(persona.slice(7), 10);
        const owned = id ? await state.getCustomPersona(req.user.id, id).catch(() => null) : null;
        valid = !!owned;
    }
    if (!valid) return res.status(400).json({ error: 'invalid persona' });
    try {
        const existing = await state.getUserTaste(req.user.id) || {};
        await state.saveUserTaste(req.user.id, { ...existing, persona });
        res.json({ ok: true, persona });
    } catch (err) {
        logger.error({ err, route: '/api/persona' }, 'set persona error');
        res.status(500).json({ error: err.message });
    }
});

// GET /api/personas/custom — list current user's custom personas
app.get('/api/personas/custom', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    try {
        const rows = await state.listCustomPersonas(req.user.id);
        res.json({ personas: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/personas/custom/:id — fetch one (for the edit form)
app.get('/api/personas/custom/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
        const row = await state.getCustomPersona(req.user.id, id);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json({ persona: row });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/personas/custom — create or update a custom persona
app.post('/api/personas/custom', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { id, name, promptMd } = req.body || {};
    try {
        const newId = await state.upsertCustomPersona(req.user.id, { id, name, promptMd });
        res.json({ ok: true, id: newId });
    } catch (err) {
        const status = /required|too long|not found/.test(err.message) ? 400 : 500;
        res.status(status).json({ error: err.message });
    }
});

// DELETE /api/personas/custom/:id
app.delete('/api/personas/custom/:id', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
        await state.deleteCustomPersona(req.user.id, id);
        // If the user's currently-selected persona was the one deleted, fall back to default
        const existing = await state.getUserTaste(req.user.id);
        if (existing?.persona === `custom:${id}`) {
            await state.saveUserTaste(req.user.id, { ...existing, persona: 'default' });
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
app.post('/api/play', writeRateLimit, async (req, res) => {
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
        logger.error({ err, route: '/api/play', song_name, artist }, 'play handler error');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/feedback — record a love / unlove / skip / down event for a song.
// type ∈ {love, unlove, skip, down}; persist via state.saveFeedback.
app.post('/api/feedback', writeRateLimit, async (req, res) => {
    const { song_id, song_name, artist, type, position_pct } = req.body || {};
    if (!type || !['love', 'unlove', 'skip', 'down'].includes(type)) {
        return res.status(400).json({ error: 'type must be love | unlove | skip | down' });
    }
    if (!song_id && !song_name) {
        return res.status(400).json({ error: 'song_id or song_name required' });
    }
    try {
        await state.saveFeedback({ song_id, song_name, artist, type, position_pct, user_id: uid(req) });
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/feedback]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/chat — text input from the player UI
app.post('/api/chat', writeRateLimit, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    try {
        await checkLlmQuota(req);
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }

    try {
        await state.saveMessage('user', message);
        const result = await router.handle(message, {
            novelty: typeof req.body?.novelty === 'number' ? req.body.novelty : 50,
            userId: uid(req),
            onDelta: (text) => emitStreamDelta(null, text)
        });
        emitStreamEnd(null);
        await state.saveMessage('assistant', result.say || '');

        if (result.action === 'BROADCAST' && result.play?.length > 0) {
            broadcastResult(result);
        }

        res.json({ ok: true, say: result.say });
    } catch (err) {
        logger.error({ err, route: '/api/chat', message }, 'chat handler error');
        res.status(500).json({ error: err.message });
    }
});

// ── WebPush endpoints ─────────────────────────────────────────────────────────

// GET /api/push/vapid-key — public key for the browser when subscribing
app.get('/api/push/vapid-key', (req, res) => {
    try {
        res.json({ publicKey: push.publicKey() });
    } catch (err) {
        res.status(500).json({ error: 'push not configured' });
    }
});

// POST /api/push/subscribe — body: PushSubscription JSON from the browser
app.post('/api/push/subscribe', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    try {
        await state.savePushSubscription(req.user.id, req.body);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/push/subscribe]', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/push/unsubscribe — body: { endpoint }
app.post('/api/push/unsubscribe', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    try {
        await state.deletePushSubscription(endpoint);
        res.json({ ok: true });
    } catch (err) {
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

    // Per-connection cursor for walking backward through play history.
    // 0 = currently playing is the most recent in `plays`; increments on each prev.
    // Resets to 0 whenever the user moves forward (play / next).
    ws._prevOffset = 0;

    ws.on('message', async (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        if (data.action === 'play') {
            ws._prevOffset = 0;
            ws.send(JSON.stringify({ type: 'status', message: '正在为你思考...' }));
            try {
                const fakeReq = { user: ws._userId !== DEFAULT_USER_ID ? { id: ws._userId } : null };
                await checkLlmQuota(fakeReq);
            } catch (e) {
                return ws.send(JSON.stringify({ type: 'error', message: e.message }));
            }
            try {
                const result = await router.handle('根据当前时间和我的心情推荐一首歌。', {
                    novelty: typeof data.novelty === 'number' ? data.novelty : 50,
                    userId: ws._userId,
                    onDelta: (text) => emitStreamDelta(ws, text)
                });
                emitStreamEnd(ws);
                await broadcastResult(result, ws);
            } catch (err) {
                console.error('[WS play]', err.message);
                ws.send(JSON.stringify({ type: 'error', message: '大脑出错了，请检查终端。' }));
            }
        }

        if (data.action === 'next') {
            ws._prevOffset = 0;
            ws.send(JSON.stringify({ type: 'status', message: '换一首...' }));
            try {
                const fakeReq = { user: ws._userId !== DEFAULT_USER_ID ? { id: ws._userId } : null };
                await checkLlmQuota(fakeReq);
            } catch (e) {
                return ws.send(JSON.stringify({ type: 'error', message: e.message }));
            }
            try {
                const result = await router.handle('换一首，风格可以稍有不同。', {
                    novelty: typeof data.novelty === 'number' ? data.novelty : 50,
                    userId: ws._userId,
                    onDelta: (text) => emitStreamDelta(ws, text)
                });
                emitStreamEnd(ws);
                await broadcastResult(result, ws);
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: '换歌失败。' }));
            }
        }

        if (data.action === 'prev') {
            ws._prevOffset = (ws._prevOffset || 0) + 1;
            const userId = ws._userId || DEFAULT_USER_ID;
            try {
                const prior = await state.getPlayAtOffset(userId, ws._prevOffset);
                if (!prior) {
                    ws._prevOffset = Math.max(0, ws._prevOffset - 1);  // roll back the increment
                    return ws.send(JSON.stringify({ type: 'error', message: '已经是最早一首了' }));
                }

                let audioUrl = '';
                if (prior.song_id && /^[a-zA-Z0-9_-]{11}$/.test(prior.song_id)) {
                    audioUrl = `/audio/${prior.song_id}`;
                } else {
                    const resolved = await fetchRealMusic(prior.song_name, prior.artist || '').catch(() => null);
                    if (resolved) audioUrl = resolved.audioUrl;
                }
                if (!audioUrl) {
                    return ws.send(JSON.stringify({ type: 'error', message: '上一首音频解析失败' }));
                }

                const isLoved = await state.isSongLoved(prior.song_id, userId).catch(() => false);
                ws.send(JSON.stringify({
                    type: 'now-playing',
                    dj: { say: '', reason: '', segue: 'direct', ttsUrl: null },
                    track: {
                        id:       prior.song_id,
                        name:     prior.song_name,
                        artist:   prior.artist,
                        coverUrl: prior.cover_url || '',
                        audioUrl
                    },
                    isLoved
                }));
            } catch (err) {
                console.error('[WS prev]', err.message);
                ws.send(JSON.stringify({ type: 'error', message: '换回上一首失败' }));
            }
            return;
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

// ── Streaming delta helpers ───────────────────────────────────────────────────
function emitStreamDelta(directWs, text) {
    const payload = { type: 'dj-stream-delta', text };
    if (directWs) {
        if (directWs.readyState === WebSocket.OPEN) directWs.send(JSON.stringify(payload));
    } else {
        bus.emit('broadcast', payload);
    }
}
function emitStreamEnd(directWs) {
    const payload = { type: 'dj-stream-end' };
    if (directWs) {
        if (directWs.readyState === WebSocket.OPEN) directWs.send(JSON.stringify(payload));
    } else {
        bus.emit('broadcast', payload);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function truncate(s, n) {
    return String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s);
}

// ── Core broadcast logic ──────────────────────────────────────────────────────
async function broadcastResult(result, directWs = null, userId = DEFAULT_USER_ID) {
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

    // 5. WebPush — only on server-initiated broadcasts (scheduler cron), not
    //    when the user actively triggered the pick (directWs present = user is
    //    already in the app, no notification needed).
    if (!directWs && track?.audioUrl) {
        try {
            const subs = await state.listPushSubscriptions(userId);
            for (const row of subs) {
                const sub = {
                    endpoint: row.endpoint,
                    keys: { p256dh: row.p256dh, auth: row.auth }
                };
                const payload = {
                    title: result.say ? truncate(result.say, 60) : 'Claudio · new pick',
                    body:  `${track.name} — ${track.artist}`,
                    icon:  '/icons/icon.svg',
                    badge: '/icons/icon.svg',
                    tag:   'claudio-now-playing',
                    data:  { url: '/' }
                };
                const r = await push.send(sub, payload);
                if (!r.ok && r.expired) {
                    await state.deletePushSubscription(row.endpoint).catch(() => {});
                }
            }
        } catch (e) {
            console.warn('[push broadcast]', e.message);
        }
    }
}

// ── Quota enforcement ─────────────────────────────────────────────────────────
const QUOTA_ANON = 200;
const QUOTA_AUTH = 500;
const DEFAULT_USER_ID = 1;

// Extract user ID from request (session or default)
function uid(req) {
    return req.user?.id || DEFAULT_USER_ID;
}

async function checkLlmQuota(req) {
    const userId = uid(req);
    const limit = req.user ? QUOTA_AUTH : QUOTA_ANON;
    const current = await state.getQuotaToday(userId);
    if (current >= limit) {
        const err = new Error(`Daily quota reached (${current}/${limit}). Try again tomorrow.`);
        err.status = 429;
        throw err;
    }
    await state.incrementQuota(userId);
}

// GET /api/taste/share/state — return current share state for the authed user
app.get('/api/taste/share/state', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    try {
        const shareState = await state.getShareState(req.user.id);
        const url = shareState.slug && shareState.public
            ? (process.env.PUBLIC_URL || `http://localhost:${PORT}`) + '/taste/' + shareState.slug
            : null;
        res.json({ public: shareState.public, slug: shareState.slug, url });
    } catch (err) {
        console.error('[/api/taste/share/state]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/taste/share — toggle public/private, mint slug on first publish
app.post('/api/taste/share', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const wantPublic = !!req.body?.public;
    try {
        const result = await state.setSharePublic(req.user.id, wantPublic);
        const url = result.public && result.slug
            ? (process.env.PUBLIC_URL || `http://localhost:${PORT}`) + '/taste/' + result.slug
            : null;
        res.json({ ok: true, public: result.public, slug: result.slug, url });
    } catch (err) {
        console.error('[/api/taste/share]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Public page — server-rendered HTML with the user's curated taste.
// Returns 404 if the slug doesn't map to a public row (no info leak).
app.get('/taste/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!/^[A-Za-z0-9_-]{4,20}$/.test(slug)) return res.status(404).send('Not found');
    try {
        const taste = await state.getTasteBySlug(slug);
        if (!taste) return res.status(404).send('Not found');
        res.send(renderPublicTaste(taste));
    } catch (err) {
        console.error('[/taste/:slug]', err.message);
        res.status(500).send('Server error');
    }
});

function renderPublicTaste(taste) {
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const artists = (taste.artistsLove || []).slice(0, 60);
    const moods   = (taste.moodSeeds   || []).slice(0, 12);
    const t = taste.timePrefs || {};
    const timeRows = ['morning','afternoon','evening','night']
        .map(k => t[k] ? `<tr><td class="t-when">${esc(k)}</td><td class="t-vibe">${esc(t[k])}</td></tr>` : '')
        .filter(Boolean).join('');
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0a09">
<title>A taste profile — Claudio</title>
<meta name="description" content="${artists.length} artists, ${moods.length} vibes — a personal music taste profile curated for Claudio's anti-bubble radio.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
:root { --bg:#0c0a09; --text:#f5efe6; --text-dim:#7a7166; --text-faint:#4a4540; --accent:#d4a574; }
*{margin:0;padding:0;box-sizing:border-box} body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased;min-height:100vh;padding:48px 24px}
.wrap{max-width:760px;margin:0 auto}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:60px}
.brand{font-family:'Fraunces',serif;font-size:22px;color:var(--text);text-decoration:none}
.brand b{color:var(--accent);font-weight:400}
.cta{padding:8px 18px;border:1px solid rgba(245,239,230,0.2);border-radius:999px;color:var(--text);text-decoration:none;font-size:13px;transition:all .3s}
.cta:hover{border-color:var(--accent);color:var(--accent)}
.overline{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);margin-bottom:16px;font-weight:500}
h1{font-family:'Fraunces',serif;font-weight:300;font-size:clamp(36px,5vw,56px);letter-spacing:-.01em;line-height:1.1;margin-bottom:14px}
h1 em{color:var(--accent);font-style:italic}
.sub{color:var(--text-dim);font-size:16px;max-width:50ch;margin-bottom:48px}
section{margin-bottom:48px}
section h2{font-family:'Fraunces',serif;font-weight:400;font-size:22px;color:var(--text);margin-bottom:18px;letter-spacing:-.005em}
section h2 small{color:var(--text-faint);font-size:12px;letter-spacing:.1em;margin-left:10px;text-transform:uppercase;font-family:'Inter',sans-serif;font-weight:500}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:rgba(212,165,116,0.10);border:1px solid rgba(212,165,116,0.22);color:var(--text);padding:6px 14px;border-radius:999px;font-size:13.5px;font-weight:500}
.moods .chip{background:rgba(245,239,230,0.04);border-color:rgba(245,239,230,0.10);color:var(--text-dim);font-style:italic;font-family:'Fraunces',serif;font-weight:300}
table.times{border-collapse:collapse;width:100%;max-width:520px}
table.times td{padding:12px 0;border-bottom:1px solid rgba(245,239,230,0.06);font-size:14px}
table.times .t-when{color:var(--text-faint);text-transform:uppercase;letter-spacing:.18em;font-size:11px;width:120px}
table.times .t-vibe{color:var(--text);font-family:'Fraunces',serif;font-style:italic;font-size:16px}
.foot{margin-top:80px;padding-top:32px;border-top:1px solid rgba(245,239,230,0.06);color:var(--text-faint);font-size:12px;text-align:center}
.foot a{color:var(--text-dim);text-decoration:none}.foot a:hover{color:var(--accent)}
@media(max-width:560px){body{padding:32px 18px}.nav{margin-bottom:40px}}
</style>
</head><body>
<div class="wrap">
  <nav class="nav">
    <a class="brand" href="/about">Claud<b>i</b>o</a>
    <a class="cta" href="/">Build yours &rarr;</a>
  </nav>

  <div class="overline">A taste profile</div>
  <h1>${artists.length} <em>artists.</em> ${moods.length} <em>vibes.</em></h1>
  <p class="sub">This is what one listener tells Claudio they love. The radio picks adjacent — never the same artist twice — explaining each one.</p>

  ${artists.length ? `<section><h2>Artists they love <small>${artists.length}</small></h2><div class="chips">${artists.map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div></section>` : ''}

  ${moods.length ? `<section class="moods"><h2>Vibes <small>${moods.length}</small></h2><div class="chips">${moods.map(m => `<span class="chip">${esc(m)}</span>`).join('')}</div></section>` : ''}

  ${timeRows ? `<section><h2>Time of day <small>moods</small></h2><table class="times">${timeRows}</table></section>` : ''}

  <div class="foot">Curated for <a href="/">Claudio</a> &middot; the AI radio that breaks you out of your algorithm</div>
</div>
</body></html>`;
}

// Marketing landing page — its own document, not part of the SPA shell.
app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// SPA fallback — serve index.html for client-side routes so direct loads /
// refreshes on /library and /stack work. Must come AFTER /api and static.
app.get(['/library', '/stack'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Taste history & rollback ──────────────────────────────────────────────────

function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// GET /api/taste/history — list taste snapshots for the current user
app.get('/api/taste/history', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    try {
        const history = await state.getTasteHistory(req.user.id, 30);
        res.json({
            history: history.map(h => ({
                id:         h.id,
                source:     h.source,
                created_at: h.created_at,
                snapshot:   safeJsonParse(h.snapshot)
            }))
        });
    } catch (err) {
        logger.error({ err, route: '/api/taste/history' }, 'history error');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/taste/rollback?id=N — restore a prior snapshot
app.post('/api/taste/rollback', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const id = parseInt(req.query?.id || req.body?.id, 10);
    if (!id) return res.status(400).json({ error: 'history id required' });
    try {
        const snapshotJson = await state.getTasteHistoryById(req.user.id, id);
        if (!snapshotJson) return res.status(404).json({ error: 'snapshot not found' });
        const snapshot = safeJsonParse(snapshotJson);
        if (!snapshot) return res.status(500).json({ error: 'snapshot corrupt' });
        await state.saveUserTaste(req.user.id, { ...snapshot, __source: 'rollback' });
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, route: '/api/taste/rollback' }, 'rollback error');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/taste/auto-evolve — toggle the weekly LLM evolution opt-in
app.post('/api/taste/auto-evolve', writeRateLimit, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    const enabled = !!req.body?.enabled;
    try {
        await state.setAutoEvolve(req.user.id, enabled);
        res.json({ ok: true, enabled });
    } catch (err) {
        logger.error({ err, route: '/api/taste/auto-evolve' }, 'auto-evolve toggle error');
        res.status(500).json({ error: err.message });
    }
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
    logger.info({ port: PORT, ip, local: `http://localhost:${PORT}`, lan: `http://${ip}:${PORT}` }, '🎙️  Claudio 已启动');
});
