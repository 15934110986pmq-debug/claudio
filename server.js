require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 👇 引入刚才写好的网易云音乐搬运工
const { fetchRealMusic } = require('./netease.js'); 

// 强制 Node.js 底层网络走代理
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const proxyUrl = "http://192.168.247.1:7890";
setGlobalDispatcher(new ProxyAgent(proxyUrl));

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 初始化服务器
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

app.use(express.static('public'));

wss.on('connection', (ws) => {
    console.log('🟢 前端网页已连接!');

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        
        if (data.action === 'play') {
            console.log('▶️ 收到播放指令，正在呼叫真实 AI 大脑...');
            
            try {
                // 1. 读取品味并生成 Prompt
                let userTaste = fs.readFileSync('./user/taste.md', 'utf-8');
                
                const systemInstruction = `
                    You are Claudio, a personal AI Radio DJ. 
                    User's musical taste: ${userTaste}
                    Current context: It's time for some music.
                    
                    Task: Recommend exactly 1 song based on their taste.
                    CRITICAL INSTRUCTION: Respond ONLY with a valid JSON object.
                    {
                        "say": "The DJ's friendly spoken script",
                        "play": [{"id": "123", "name": "Song Title", "artist": "Artist Name", "reason": "..."}],
                        "reason": "...",
                        "segue": "direct"
                    }
                `;

                // 2. 调用 Gemini
                const model = genAI.getGenerativeModel({ 
                    model: "gemini-3-flash-preview", // 确保这里是你测试通的模型名
                    generationConfig: { responseMimeType: "application/json" }
                });

                const result = await model.generateContent(systemInstruction);
                
                // ==========================================
                // 👇 这里就是你刚才那段代码插入的位置 👇
                // ==========================================
                
                // --- 1. 获取 Gemini 的推荐 ---
                const jsonObj = JSON.parse(result.response.text());
                const recommendedSong = jsonObj.play[0];
                console.log(`✅ AI 推荐了: ${recommendedSong.name} - ${recommendedSong.artist}`);

                // --- 2. 召唤音乐搬运工，去网易云拿 MP3 ---
                const realMusicInfo = await fetchRealMusic(recommendedSong.name, recommendedSong.artist);

                if (realMusicInfo) {
                    // --- 3. 把真实的音乐数据通过 WebSocket 推给网页 ---
                    const responseData = {
                        type: 'now-playing',
                        track: {
                            name: realMusicInfo.name,
                            artist: realMusicInfo.artist,
                            coverUrl: realMusicInfo.coverUrl, // 真实的专辑封面
                            audioUrl: realMusicInfo.audioUrl  // 真实的 MP3 链接
                        },
                        dj: { say: jsonObj.say }
                    };
                    ws.send(JSON.stringify(responseData));
                    console.log('📤 包含真实 MP3 链接的数据已推送！');
                } else {
                    // 容错处理：如果网易云没搜到
                    ws.send(JSON.stringify({
                        type: 'now-playing',
                        track: { name: "暂无版权或无法播放", artist: recommendedSong.artist, coverUrl: "" },
                        dj: { say: `我本来想给你播《${recommendedSong.name}》，但发现唱片机坏了，换一首试试吧。` }
                    }));
                }
                
                // ==========================================
                // 👆 你刚才那段代码结束的位置 👆
                // ==========================================

            } catch (error) {
                console.error("❌ 大脑处理失败：", error.message);
                ws.send(JSON.stringify({
                    type: 'now-playing',
                    track: { name: "网络波动", artist: "未知", coverUrl: "" },
                    dj: { say: "抱歉，我的大脑好像断线了，请检查终端报错。" }
                }));
            }
        }
    });
});

const os = require('os');
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`🚀 Claudio 完全体主控已启动: http://${ip}:${PORT}`);
});