const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const ADMIN_KEY = `change-this-to-a-long-random-secret`;

if (!ADMIN_KEY) {
    console.error('ADMIN_KEY is not set (see .env.example). Refusing to start with no access gate.');
    process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// sessionId -> { broadcaster: ws, viewers: Map<viewerId, ws>, hostName, playerName, startedAt }
const sessions = new Map();
// ws -> { role, sessionId, viewerId, authed }
const meta = new Map();
// ws -> short id, just for readable debug logs
const connIds = new Map();
let nextConnId = 1;

function log(connOrLabel, ...args) {
    const tag = typeof connOrLabel === 'string' ? connOrLabel : `#${connIds.get(connOrLabel) ?? '?'}`;
    console.log(`[${new Date().toISOString()}] [${tag}]`, ...args);
}

function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Shrinks noisy payloads (sdp blobs, ICE candidates) before they hit the log.
function summarize(msg) {
    const { type, sessionId, viewerId } = msg;
    const out = { type, sessionId, viewerId };
    if (msg.sdp) out.sdp = `<sdp ${String(msg.sdp.sdp || msg.sdp).length} chars>`;
    if (msg.candidate) out.candidate = String(msg.candidate.candidate || '').slice(0, 40) + '...';
    if (msg.key) out.key = '<redacted>';
    if (msg.hostName) out.hostName = msg.hostName;
    if (msg.playerName) out.playerName = msg.playerName;
    return out;
}

function sessionSummaries() {
    return [...sessions.entries()].map(([id, s]) => ({
        sessionId: id,
        hostName: s.hostName,
        playerName: s.playerName,
        startedAt: s.startedAt,
        viewerCount: s.viewers.size
    }));
}

function broadcastSessionsToViewers() {
    const payload = { type: 'sessions', sessions: sessionSummaries() };
    for (const [ws, m] of meta.entries()) {
        if (m.role === 'viewer' && m.authed) send(ws, payload);
    }
}

wss.on('connection', (ws, req) => {
    const id = nextConnId++;
    connIds.set(ws, id);
    meta.set(ws, { role: null, authed: false, sessionId: null, viewerId: null });
    log(ws, 'connected from', req.socket.remoteAddress);

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            log(ws, 'bad JSON, dropping message:', err.message);
            return;
        }

        const m = meta.get(ws);
        log(ws, 'recv', msg.type, summarize(msg));

        // A FiveM client (target) publishing a stream. No key required to publish -
        // the FiveM-side consent flow already gated this; the key only gates who can watch.
        if (msg.type === 'registerBroadcaster') {
            if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
                log(ws, 'registerBroadcaster rejected: missing/invalid sessionId');
                return;
            }
            sessions.set(msg.sessionId, {
                broadcaster: ws,
                viewers: new Map(),
                hostName: String(msg.hostName || 'unknown').slice(0, 64),
                playerName: String(msg.playerName || 'unknown').slice(0, 64),
                startedAt: Date.now()
            });
            m.role = 'broadcaster';
            m.sessionId = msg.sessionId;
            log(ws, 'session registered:', msg.sessionId, 'player=', msg.playerName, 'host=', msg.hostName);
            broadcastSessionsToViewers();
            return;
        }

        if (msg.type === 'auth') {
            if (msg.key === ADMIN_KEY) {
                m.authed = true;
                m.role = 'viewer';
                log(ws, 'auth OK, now a viewer');
                send(ws, { type: 'authOk' });
                send(ws, { type: 'sessions', sessions: sessionSummaries() });
            } else {
                log(ws, 'auth FAILED (wrong key)');
                send(ws, { type: 'authFail' });
            }
            return;
        }

        // everything below requires an authed viewer or a registered broadcaster
        if (m.role === 'viewer' && !m.authed) {
            log(ws, 'ignored', msg.type, '- viewer not authed');
            return;
        }
        if (!m.role) {
            log(ws, 'ignored', msg.type, '- no role yet');
            return;
        }

        if (msg.type === 'watch' && m.role === 'viewer') {
            const session = sessions.get(msg.sessionId);
            if (!session) {
                log(ws, 'watch rejected: no such session', msg.sessionId);
                return;
            }
            const viewerId = m.viewerId || Math.random().toString(36).slice(2);
            m.viewerId = viewerId;
            m.sessionId = msg.sessionId;
            session.viewers.set(viewerId, ws);
            log(ws, 'viewer', viewerId, 'joined session', msg.sessionId);
            send(session.broadcaster, { type: 'viewerJoin', viewerId });
            return;
        }

        if (['offer', 'answer', 'candidate', 'stopped'].includes(msg.type)) {
            const session = sessions.get(msg.sessionId);
            if (!session) {
                log(ws, 'relay rejected: no such session', msg.sessionId);
                return;
            }

            if (m.role === 'broadcaster') {
                const viewerWs = session.viewers.get(msg.viewerId);
                log(ws, 'relay', msg.type, '-> viewer', msg.viewerId);
                send(viewerWs, msg);
            } else if (m.role === 'viewer') {
                log(ws, 'relay', msg.type, '-> broadcaster of session', msg.sessionId);
                send(session.broadcaster, { ...msg, viewerId: m.viewerId });
            }
        }
    });

    ws.on('close', () => {
        const m = meta.get(ws);
        log(ws, 'disconnected, role=', m && m.role);
        if (m) {
            if (m.role === 'broadcaster' && m.sessionId) {
                const session = sessions.get(m.sessionId);
                if (session) {
                    log(ws, 'broadcaster gone, stopping session', m.sessionId, 'for', session.viewers.size, 'viewer(s)');
                    for (const viewerWs of session.viewers.values()) {
                        send(viewerWs, { type: 'stopped', sessionId: m.sessionId });
                    }
                }
                sessions.delete(m.sessionId);
                broadcastSessionsToViewers();
            } else if (m.role === 'viewer' && m.sessionId) {
                const session = sessions.get(m.sessionId);
                if (session) {
                    session.viewers.delete(m.viewerId);
                    log(ws, 'viewer', m.viewerId, 'left session', m.sessionId);
                    send(session.broadcaster, { type: 'viewerLeft', viewerId: m.viewerId });
                }
            }
        }
        meta.delete(ws);
        connIds.delete(ws);
    });

    ws.on('error', (err) => {
        log(ws, 'socket error:', err.message);
    });
});

server.listen(PORT, () => console.log(`screenwatch signaling listening on :${PORT}`));
