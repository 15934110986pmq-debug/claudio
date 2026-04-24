require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// 初始化 Express 框架
const app = express();
const server = http.createServer(app);

// 建立 WebSocket 服务器，挂载在 /stream 路径下
const wss = new WebSocket.Server({ server, path: '/stream' });

// 告诉服务器：把 public 文件夹当做网页静态资源展示出去
app.use(express.static('public'));

// 当有前端网页连接进来时
wss.on('connection', (ws) => {
    console.log('🟢 前端网页已成功连接到 WebSocket!');

    // 监听前端发来的消息（比如点击播放按钮）
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.action === 'play') {
            console.log('▶️ 收到前端播放指令，假装正在思考...');

            // 模拟延迟 2 秒，假装是 Gemini 在思考
            setTimeout(() => {
                // 构造发给前端的更新指令
                const responseData = {
                    type: 'now-playing',
                    track: {
                        name: "模拟的一首好歌",
                        artist: "Claudio 测试歌手",
                        // 给一张橙色的测试封面图
                        coverUrl: "https://via.placeholder.com/300x300/ff5722/ffffff?text=Music"
                    },
                    dj: {
                        say: "早上好！我猜你现在想听点轻快的，这就为你播放。"
                    }
                };

                // 把数据顺着管道推给前端
                ws.send(JSON.stringify(responseData));
                console.log('📤 数据已推送到前端！');
            }, 2000);
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Claudio 主控台已启动: http://localhost:${PORT}`);
});