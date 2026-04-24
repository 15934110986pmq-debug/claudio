

document.addEventListener('DOMContentLoaded', () => {
    const playBtn = document.getElementById('play-btn');
    const playIcon = playBtn.querySelector('i');
    let isPlaying = false;
    
    // 👇 新增：创建一个隐形的 HTML5 唱片机
    const audioPlayer = new Audio(); 

    const ws = new WebSocket('ws://localhost:8080/stream'); // 注意：如果你前面改了 IP，这里也要用对应的 IP

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'now-playing') {
            document.getElementById('track-title').textContent = data.track.name;
            document.getElementById('track-artist').textContent = data.track.artist;
            if(data.track.coverUrl) document.getElementById('cover-img').src = data.track.coverUrl;
            if (data.dj && data.dj.say) document.getElementById('dj-text').textContent = `"${data.dj.say}"`;

            // 👇 新增：将接收到的真实 MP3 链接塞进唱片机，并开始播放！
            if (data.track.audioUrl) {
                audioPlayer.src = data.track.audioUrl;
                audioPlayer.play();
                isPlaying = true; // 确保播放状态正确
                playIcon.classList.remove('fa-play');
                playIcon.classList.add('fa-pause');
            }
        }
    }

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