require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 👇 1. 强制 Node.js 底层网络走代理 (你刚才测通的魔法)
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
                // 2. 读取你的真实品味
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

                // 3. 调用真实大模型 
                // ⚠️ 注意：这里改成你刚才测试成功的模型名字！！！
                const model = genAI.getGenerativeModel({
                    model: "gemini-3-flash-preview",
                    generationConfig: { responseMimeType: "application/json" }
                });

                const result = await model.generateContent(systemInstruction);
                const jsonObj = JSON.parse(result.response.text());
                console.log(`✅ AI 思考完毕！推荐了: ${jsonObj.play[0].name}`);

                // 4. 将真实的 AI 结果通过管道推给前端
                const responseData = {
                    type: 'now-playing',
                    track: {
                        name: jsonObj.play[0].name,
                        artist: jsonObj.play[0].artist,
                        // 封面图我们暂时还是用占位图，等接了网易云再换真实的
                        coverUrl: "https://via.placeholder.com/300x300/ff5722/ffffff?text=AI+DJ"
                    },
                    dj: {
                        say: jsonObj.say
                    }
                };

                ws.send(JSON.stringify(responseData));
                console.log('📤 真实数据已推送到网页！');

            } catch (error) {
                console.error("❌ 大脑处理失败：", error.message);
                // 告诉前端出错了
                ws.send(JSON.stringify({
                    type: 'now-playing',
                    track: { name: "网络波动", artist: "未知", coverUrl: "" },
                    dj: { say: "抱歉，我的大脑好像断线了，请检查终端报错。" }
                }));
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Claudio 完全体主控已启动: http://localhost:${PORT}`);
});