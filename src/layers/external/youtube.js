// YouTube adapter — same interface as netease.js (fetchRealMusic).
//
// Search via youtube-sr (scrapes public search, no API key), pick the best
// match for a "real song" (penalize covers/live/remix), and return a URL that
// points at our server's /audio/:videoId proxy. The actual audio stream is
// extracted on demand by the proxy via @distube/ytdl-core.

const YouTube = require('youtube-sr').default;

async function fetchRealMusic(songName, artistName) {
    console.log(`[YouTube] 搜索: ${songName} — ${artistName}`);
    try {
        const query = `${songName} ${artistName} audio`;
        const results = await YouTube.search(query, { limit: 8, type: 'video' });
        if (!results?.length) throw new Error('未找到视频');

        const pick = pickBestMatch(results, songName, artistName);
        const videoId = pick.id;
        if (!videoId) throw new Error('无 videoId');

        const coverUrl = pick.thumbnail?.url || pick.thumbnail?.displayThumbnailURL?.('maxresdefault') || '';
        const realName = pick.title || songName;
        const realArtist = pick.channel?.name?.replace(/\s*-\s*Topic$/, '') || artistName;

        // audioUrl points at our own proxy. The browser hits /audio/:videoId,
        // server pipes the YT stream back. Required because direct
        // googlevideo.com URLs are IP-bound, CORS-blocked, and short-TTL.
        const audioUrl = `/audio/${videoId}`;

        console.log(`[YouTube] ✓ ${realName} — ${realArtist} (videoId=${videoId})`);
        return { id: videoId, name: realName, artist: realArtist, coverUrl, audioUrl };
    } catch (err) {
        console.error('[YouTube] 搜索失败:', err.message);
        return null;
    }
}

// Heuristic scorer. YouTube returns a mix of official audio, MV, covers,
// reactions, live, remixes — for an AI radio we want the "real song" track.
function pickBestMatch(results, songName, artistName) {
    const a = (artistName || '').toLowerCase();
    const s = (songName || '').toLowerCase();

    const scored = results.map(r => {
        const title = (r.title || '').toLowerCase();
        const channel = (r.channel?.name || '').toLowerCase();
        let score = 0;

        // Channel matches the artist — strongest signal
        if (a && channel.includes(a)) score += 5;

        // "Topic" channels are YouTube Music's auto-generated artist channels —
        // basically always the canonical audio upload
        if (channel.endsWith(' - topic')) score += 4;

        // Title also mentions the artist
        if (a && title.includes(a)) score += 2;

        // Title contains the song name
        if (s && title.includes(s)) score += 2;

        // "Official audio" / "official video" hints
        if (/official\s+(audio|video|music\s+video)/.test(title)) score += 2;

        // Penalize off-target variants
        if (/\bcover\b/.test(title)) score -= 6;
        if (/\bremix\b/.test(title)) score -= 2;
        if (/\b(live|concert|tour)\b/.test(title)) score -= 2;
        if (/\b(reaction|review|tutorial|lesson|karaoke)\b/.test(title)) score -= 8;
        if (/\b(sped\s*up|slowed|nightcore|8d|loop)\b/.test(title)) score -= 4;

        // Heavily penalize obvious lyric/visualizer-only when we wanted audio (still acceptable)
        if (/\blyrics?\b/.test(title)) score -= 0.5;

        // Duration sanity: songs are usually 1.5–10 min. Skip ultra-short clips.
        const dur = r.duration || 0;
        if (dur > 0 && dur < 30_000) score -= 4;       // <30s — almost certainly a clip
        if (dur > 0 && dur > 15 * 60_000) score -= 2;  // >15min — likely compilation / mix

        return { r, score };
    });

    scored.sort((x, y) => y.score - x.score);
    return scored[0].r;
}

module.exports = { fetchRealMusic };
