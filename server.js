require('dotenv').config();

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

function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
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

wss.on('connection', (ws) => {
    meta.set(ws, { role: null, authed: false, sessionId: null, viewerId: null });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        const m = meta.get(ws);

        // A FiveM client (target) publishing a stream. No key required to publish -
        // the FiveM-side consent flow already gated this; the key only gates who can watch.
        if (msg.type === 'registerBroadcaster') {
            if (typeof msg.sessionId !== 'string' || !msg.sessionId) return;
            sessions.set(msg.sessionId, {
                broadcaster: ws,
                viewers: new Map(),
                hostName: String(msg.hostName || 'unknown').slice(0, 64),
                playerName: String(msg.playerName || 'unknown').slice(0, 64),
                startedAt: Date.now()
            });
            m.role = 'broadcaster';
            m.sessionId = msg.sessionId;
            broadcastSessionsToViewers();
            return;
        }

        if (msg.type === 'auth') {
            if (msg.key === ADMIN_KEY) {
                m.authed = true;
                m.role = 'viewer';
                send(ws, { type: 'authOk' });
                send(ws, { type: 'sessions', sessions: sessionSummaries() });
            } else {
                send(ws, { type: 'authFail' });
            }
            return;
        }

        // everything below requires an authed viewer or a registered broadcaster
        if (m.role === 'viewer' && !m.authed) return;
        if (!m.role) return;

        if (msg.type === 'watch' && m.role === 'viewer') {
            const session = sessions.get(msg.sessionId);
            if (!session) return;
            const viewerId = m.viewerId || Math.random().toString(36).slice(2);
            m.viewerId = viewerId;
            m.sessionId = msg.sessionId;
            session.viewers.set(viewerId, ws);
            send(session.broadcaster, { type: 'viewerJoin', viewerId });
            return;
        }

        if (['offer', 'answer', 'candidate', 'stopped'].includes(msg.type)) {
            const session = sessions.get(msg.sessionId);
            if (!session) return;

            if (m.role === 'broadcaster') {
                const viewerWs = session.viewers.get(msg.viewerId);
                send(viewerWs, msg);
            } else if (m.role === 'viewer') {
                send(session.broadcaster, { ...msg, viewerId: m.viewerId });
            }
        }
    });

    ws.on('close', () => {
        const m = meta.get(ws);
        if (m) {
            if (m.role === 'broadcaster' && m.sessionId) {
                const session = sessions.get(m.sessionId);
                if (session) {
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
                    send(session.broadcaster, { type: 'viewerLeft', viewerId: m.viewerId });
                }
            }
        }
        meta.delete(ws);
    });
});

server.listen(PORT, () => console.log(`screenwatch signaling listening on :${PORT}`));
