// 文件：netease.js
const { search, song_url_v1 } = require('NeteaseCloudMusicApi');

async function fetchRealMusic(songName, artistName) {
    console.log(`🔍 正在网易云搜索: ${songName} - ${artistName}`);
    try {
        // 1. 搜索歌曲
        const searchResult = await search({
            keywords: `${songName} ${artistName}`,
            limit: 1, // 只拿最匹配的第一首
        });

        const songs = searchResult.body.result.songs;
        if (!songs || songs.length === 0) {
            throw new Error("没搜到这首歌");
        }

        const songId = songs[0].id;
        const coverUrl = songs[0].al.picUrl; // 获取真实高清专辑封面
        const realName = songs[0].name;
        const realArtist = songs[0].ar[0].name;

        // 2. 获取真实的 MP3 播放链接 (standard 标准音质通常不需要 VIP)
        const urlResult = await song_url_v1({
            id: songId,
            level: 'standard'
        });

        const audioUrl = urlResult.body.data[0].url;
        
        if (!audioUrl) {
            throw new Error("获取音频源失败（可能是 VIP 歌曲或无版权）");
        }

        console.log(`✅ 成功获取音频流: ${realName}`);
        
        // 返回结构化数据给你的主服务器
        return {
            name: realName,
            artist: realArtist,
            coverUrl: coverUrl,
            audioUrl: audioUrl
        };

    } catch (error) {
        console.error("❌ 网易云 API 调用失败:", error.message);
        return null; // 搜不到就返回 null
    }
}

module.exports = { fetchRealMusic };