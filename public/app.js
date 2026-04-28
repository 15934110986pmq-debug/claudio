if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
    const playBtn = document.getElementById('play-btn');
    const nextBtn = document.getElementById('next-btn');
    const playIcon = playBtn.querySelector('i');
    const statusText = document.getElementById('status-text');
    const progressBar = document.getElementById('progress');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');

    const musicPlayer = new Audio();
    const ttsPlayer = new Audio();
    let isPlaying = false;

    // Use relative WS URL so it works on both localhost and LAN/PWA
    const wsUrl = `ws://${location.host}/stream`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setStatus('已连接，准备就绪');
    ws.onclose = () => setStatus('连接断开，请刷新');

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'status') {
            setStatus(data.message);
            return;
        }

        if (data.type === 'error') {
            setStatus('⚠ ' + data.message);
            return;
        }

        if (data.type === 'now-playing') {
            const { track, dj } = data;

            // Update UI
            document.getElementById('track-title').textContent = track.name || '—';
            document.getElementById('track-artist').textContent = track.artist || '';
            if (track.coverUrl) document.getElementById('cover-img').src = track.coverUrl;
            if (dj?.say) document.getElementById('dj-text').textContent = `"${dj.say}"`;

            setStatus('正在播放');
            isPlaying = true;
            playIcon.classList.remove('fa-play');
            playIcon.classList.add('fa-pause');

            // Play TTS first, then music
            if (dj?.ttsUrl && track.audioUrl) {
                ttsPlayer.src = dj.ttsUrl;
                ttsPlayer.play().catch(() => {});
                ttsPlayer.onended = () => {
                    musicPlayer.src = track.audioUrl;
                    musicPlayer.play().catch(() => {});
                };
            } else if (track.audioUrl) {
                musicPlayer.src = track.audioUrl;
                musicPlayer.play().catch(() => {});
            } else if (dj?.ttsUrl) {
                ttsPlayer.src = dj.ttsUrl;
                ttsPlayer.play().catch(() => {});
            }
        }
    };

    // Progress bar
    musicPlayer.addEventListener('timeupdate', () => {
        if (!musicPlayer.duration) return;
        const pct = (musicPlayer.currentTime / musicPlayer.duration) * 100;
        progressBar.style.width = pct + '%';
        currentTimeEl.textContent = fmt(musicPlayer.currentTime);
        totalTimeEl.textContent = fmt(musicPlayer.duration);
    });

    // Auto-next when song ends
    musicPlayer.addEventListener('ended', () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'next' }));
        }
    });

    // Play / Pause button
    playBtn.addEventListener('click', () => {
        if (!isPlaying) {
            isPlaying = true;
            playIcon.classList.replace('fa-play', 'fa-pause');
            if (musicPlayer.src) {
                musicPlayer.play().catch(() => {});
            } else if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'play' }));
            }
        } else {
            isPlaying = false;
            playIcon.classList.replace('fa-pause', 'fa-play');
            musicPlayer.pause();
            ttsPlayer.pause();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'pause' }));
            }
        }
    });

    // Next button
    nextBtn.addEventListener('click', () => {
        musicPlayer.pause();
        ttsPlayer.pause();
        if (ws.readyState === WebSocket.OPEN) {
            setStatus('换歌中...');
            ws.send(JSON.stringify({ action: 'next' }));
        }
    });

    function setStatus(msg) {
        if (statusText) statusText.textContent = msg;
    }

    function fmt(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }
});
