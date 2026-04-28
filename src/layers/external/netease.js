const { search, song_url_v1 } = require('NeteaseCloudMusicApi');

async function fetchRealMusic(songName, artistName) {
    console.log(`[Netease] 搜索: ${songName} — ${artistName}`);
    try {
        const searchResult = await search({
            keywords: `${songName} ${artistName}`,
            limit: 1
        });

        const songs = searchResult.body.result?.songs;
        if (!songs?.length) throw new Error('未找到歌曲');

        const song = songs[0];
        const songId = song.id;
        const coverUrl = song.al?.picUrl || '';
        const realName = song.name;
        const realArtist = song.ar?.[0]?.name || artistName;

        const urlResult = await song_url_v1({ id: songId, level: 'standard' });
        const audioUrl = urlResult.body.data?.[0]?.url;

        if (!audioUrl) throw new Error('无音频地址（VIP 或无版权）');

        console.log(`[Netease] ✓ ${realName} — ${realArtist}`);
        return { id: String(songId), name: realName, artist: realArtist, coverUrl, audioUrl };
    } catch (err) {
        console.error('[Netease] 搜索失败:', err.message);
        return null;
    }
}

module.exports = { fetchRealMusic };
