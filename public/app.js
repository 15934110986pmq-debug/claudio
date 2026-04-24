document.addEventListener('DOMContentLoaded', () => {
    const playBtn = document.getElementById('play-btn');
    const playIcon = playBtn.querySelector('i');
    let isPlaying = false;

    // 1. 尝试连接后端的 WebSocket 管道
    const ws = new WebSocket('ws://localhost:8080/stream');

    ws.onopen = () => {
        console.log('管道连接成功');
        document.querySelector('.status-text').textContent = 'Claudio 已连接';
        document.querySelector('.status-dot').style.backgroundColor = '#4caf50'; // 绿灯亮起
    };

    // 2. 接收后端推过来的数据
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // 如果后端发来的是“正在播放”指令，就更新网页内容
        if (data.type === 'now-playing') {
            document.getElementById('track-title').textContent = data.track.name;
            document.getElementById('track-artist').textContent = data.track.artist;
            document.getElementById('cover-img').src = data.track.coverUrl;

            // 更新字幕框
            if (data.dj && data.dj.say) {
                document.getElementById('dj-text').textContent = `"${data.dj.say}"`;
            }
        }
    };

    // 3. 告诉后端：按钮被点击了
    playBtn.addEventListener('click', () => {
        isPlaying = !isPlaying;
        if (isPlaying) {
            playIcon.classList.remove('fa-play');
            playIcon.classList.add('fa-pause');

            // 顺着管道给后端发消息
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'play' }));
                document.getElementById('dj-text').textContent = "正在为你思考合适的音乐...";
            }
        } else {
            playIcon.classList.remove('fa-pause');
            playIcon.classList.add('fa-play');
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'pause' }));
            }
        }
    });
});