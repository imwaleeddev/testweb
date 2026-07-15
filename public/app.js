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

function log(...args) {
    console.log(`[${new Date().toISOString()}] [screenwatch]`, ...args);
}

function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    log('connecting to', url);
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
        log('ws open, sending auth');
        ws.send(JSON.stringify({ type: 'auth', key }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        log('recv', msg.type, msg);

        if (msg.type === 'authOk') {
            log('auth OK');
            localStorage.setItem('screenwatch_key', key);
            keyGate.classList.add('hidden');
            dashboard.classList.remove('hidden');
        } else if (msg.type === 'authFail') {
            log('auth FAILED');
            keyError.innerText = 'مفتاح غير صحيح';
            localStorage.removeItem('screenwatch_key');
            ws.close();
        } else if (msg.type === 'sessions') {
            log('sessions update:', msg.sessions.length, 'active');
            renderSessions(msg.sessions);
        } else if (msg.type === 'offer') {
            log('offer received for session', msg.sessionId);
            handleOffer(msg);
        } else if (msg.type === 'candidate') {
            log('remote ICE candidate received');
            if (pc) pc.addIceCandidate(msg.candidate).catch((err) => log('addIceCandidate failed:', err));
        } else if (msg.type === 'stopped') {
            log('session stopped:', msg.sessionId);
            if (msg.sessionId === currentSessionId) closeViewer();
        } else if (msg.type === 'watchTimeout') {
            log('watch timed out for session', msg.sessionId);
            if (msg.sessionId === currentSessionId) {
                viewerTitle.innerText = 'انتهت المهلة - اللاعب لم يبدأ المشاركة';
            }
        }
    });

    ws.addEventListener('close', () => {
        log('ws closed');
        if (!dashboard.classList.contains('hidden')) {
            log('reconnecting in 2s');
            setTimeout(connect, 2000);
        }
    });

    ws.addEventListener('error', (err) => {
        log('ws error', err);
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
    log('watching session', sessionId, playerName);
    currentSessionId = sessionId;
    viewerTitle.innerText = playerName;
    viewerOverlay.classList.remove('hidden');

    pc = new RTCPeerConnection({ iceServers });
    pc.ontrack = (e) => {
        log('ontrack: received remote stream');
        viewerVideo.srcObject = e.streams[0];
    };
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            log('sending local ICE candidate');
            ws.send(JSON.stringify({ type: 'candidate', sessionId, candidate: e.candidate }));
        }
    };
    pc.onconnectionstatechange = () => log('peerconnection state:', pc.connectionState);
    pc.oniceconnectionstatechange = () => log('ice connection state:', pc.iceConnectionState);

    ws.send(JSON.stringify({ type: 'watch', sessionId }));
}

async function handleOffer(msg) {
    if (!pc || msg.sessionId !== currentSessionId) {
        log('ignoring offer: no active pc or session mismatch');
        return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('sending answer for session', currentSessionId);
    ws.send(JSON.stringify({ type: 'answer', sessionId: currentSessionId, sdp: answer }));
}

function closeViewer() {
    log('closing viewer for session', currentSessionId);
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
