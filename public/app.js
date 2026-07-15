let ws = null;
let key = localStorage.getItem('screenwatch_key') || '';
let pc = null;
let currentSessionId = null;

const keyGate = document.getElementById('keyGate');
const dashboard = document.getElementById('dashboard');
const sessionList = document.getElementById('sessionList');
const keyError = document.getElementById('keyError');
const viewerOverlay = document.getElementById('viewerOverlay');
const viewerVideo = document.getElementById('viewerVideo');
const viewerTitle = document.getElementById('viewerTitle');

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', key }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'authOk') {
            localStorage.setItem('screenwatch_key', key);
            keyGate.classList.add('hidden');
            dashboard.classList.remove('hidden');
        } else if (msg.type === 'authFail') {
            keyError.innerText = 'مفتاح غير صحيح';
            localStorage.removeItem('screenwatch_key');
            ws.close();
        } else if (msg.type === 'sessions') {
            renderSessions(msg.sessions);
        } else if (msg.type === 'offer') {
            handleOffer(msg);
        } else if (msg.type === 'candidate') {
            if (pc) pc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.type === 'stopped') {
            if (msg.sessionId === currentSessionId) closeViewer();
        }
    });

    ws.addEventListener('close', () => {
        if (!dashboard.classList.contains('hidden')) {
            setTimeout(connect, 2000);
        }
    });
}

function renderSessions(sessions) {
    sessionList.innerHTML = '';
    if (!sessions.length) {
        sessionList.innerHTML = '<p class="empty">لا يوجد بث نشط حالياً</p>';
        return;
    }
    sessions.forEach((s) => {
        const el = document.createElement('div');
        el.className = 'session-card';

        const info = document.createElement('div');
        info.className = 'session-info';
        const name = document.createElement('strong');
        name.innerText = s.playerName;
        const host = document.createElement('span');
        host.innerText = s.hostName;
        info.appendChild(name);
        info.appendChild(host);

        const btn = document.createElement('button');
        btn.innerText = 'مشاهدة';
        btn.addEventListener('click', () => watchSession(s.sessionId, s.playerName));

        el.appendChild(info);
        el.appendChild(btn);
        sessionList.appendChild(el);
    });
}

function watchSession(sessionId, playerName) {
    currentSessionId = sessionId;
    viewerTitle.innerText = playerName;
    viewerOverlay.classList.remove('hidden');

    pc = new RTCPeerConnection({ iceServers });
    pc.ontrack = (e) => {
        viewerVideo.srcObject = e.streams[0];
    };
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            ws.send(JSON.stringify({ type: 'candidate', sessionId, candidate: e.candidate }));
        }
    };

    ws.send(JSON.stringify({ type: 'watch', sessionId }));
}

async function handleOffer(msg) {
    if (!pc || msg.sessionId !== currentSessionId) return;
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', sessionId: currentSessionId, sdp: answer }));
}

function closeViewer() {
    if (pc) {
        pc.close();
        pc = null;
    }
    viewerVideo.srcObject = null;
    viewerOverlay.classList.add('hidden');
    currentSessionId = null;
}

document.getElementById('keyBtn').addEventListener('click', () => {
    key = document.getElementById('keyInput').value.trim();
    if (!key) return;
    keyError.innerText = '';
    connect();
});

document.getElementById('keyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('keyBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('screenwatch_key');
    location.reload();
});

document.getElementById('viewerClose').addEventListener('click', closeViewer);

if (key) connect();
