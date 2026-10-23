'use strict';
/**
 * WebSocket layer (ws package) — one socket protocol powers:
 *  - real-time messages, typing indicators, delivery/read receipts, presence
 *  - WebRTC signaling for 1:1 voice/video calls (offer/answer/ICE relay)
 *
 * Signaling messages are relayed ONLY to the other participant(s) of the
 * given conversation — the server never forwards them anywhere else.
 * Calls are 1:1 only: signaling inside a group/channel conversation is
 * rejected with an explicit "group calls not available" error.
 */
const { WebSocketServer } = require('ws');
const { run, get, all } = require('./db');
const { verifyToken, getSetting } = require('./auth');
const core = require('./core');

const connections = new Map(); // userId -> Set<ws>
const presence = new Map();    // userId -> { online: bool }

function userSockets(userId) { return connections.get(userId) || new Set(); }

function sendToUser(userId, obj) {
  const sockets = connections.get(userId);
  if (!sockets) return 0;
  const data = JSON.stringify(obj);
  let sent = 0;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) { ws.send(data); sent += 1; }
  }
  return sent;
}

function participantIds(conversationId) {
  return all('SELECT user_id FROM participants WHERE conversation_id = ?', conversationId).map(r => r.user_id);
}

function broadcastToConversation(conversationId, obj, exceptUserId) {
  for (const uid of participantIds(conversationId)) {
    if (exceptUserId && Number(uid) === Number(exceptUserId)) continue;
    sendToUser(uid, obj);
  }
}

/** Broadcast a stored message; marks delivery receipts for reached users. */
function broadcastMessage(conv, messageRow, exceptUserId) {
  for (const uid of participantIds(conv.id)) {
    if (exceptUserId && Number(uid) === Number(exceptUserId)) continue;
    const payload = { type: 'message', conversationId: conv.id, message: core.serializeMessage(messageRow, uid) };
    const reached = sendToUser(uid, payload);
    if (reached > 0 && Number(uid) !== Number(messageRow.sender_id)) {
      core.markDelivered(messageRow.id, uid);
      // Refresh the sender's copy so their tick flips to "delivered".
      const senderPayload = { type: 'message-updated', conversationId: conv.id, message: core.serializeMessage(messageRow, messageRow.sender_id) };
      sendToUser(messageRow.sender_id, senderPayload);
    }
  }
}

function broadcastPresence(userId, online) {
  const hidePresence = getSetting(userId, 'last_seen_visibility', 'everyone') === 'nobody';
  const user = get('SELECT last_seen_at FROM users WHERE id = ?', userId);
  const payload = {
    type: 'presence', userId,
    online: hidePresence ? false : online,
    lastSeenAt: hidePresence ? null : (user ? user.last_seen_at : null),
  };
  const convIds = all('SELECT conversation_id FROM participants WHERE user_id = ?', userId).map(r => r.conversation_id);
  const seen = new Set();
  for (const cid of convIds) {
    for (const uid of participantIds(cid)) {
      if (Number(uid) !== Number(userId) && !seen.has(uid)) { seen.add(uid); sendToUser(uid, payload); }
    }
  }
}

const hub = { sendToUser, broadcastToConversation, broadcastMessage, presence, connections };

/* ------------------------------------------------------------ call status */
function updateCallStatus(callId, event, byUserId) {
  const call = get('SELECT * FROM calls WHERE id = ?', callId);
  if (!call) return;
  const now = Date.now();
  if (event === 'accept' && Number(byUserId) === Number(call.callee_id)) {
    run("UPDATE calls SET status = 'ongoing', answered_at = ? WHERE id = ?", now, callId);
  } else if (event === 'decline' && Number(byUserId) === Number(call.callee_id)) {
    run("UPDATE calls SET status = 'declined', ended_at = ? WHERE id = ?", now, callId);
  } else if (event === 'end') {
    const status = call.status === 'ringing' ? 'missed' : 'ended';
    run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', status, now, callId);
  }
}

/* ---------------------------------------------------------------- attach */
function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const token = url.searchParams.get('token');
    const result = token ? verifyToken(token) : null;
    if (!result) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.user = result.user;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    const userId = ws.user.id;
    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(ws);
    presence.set(userId, { online: true });
    broadcastPresence(userId, true);
    ws.send(JSON.stringify({ type: 'ready', userId }));

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(ws, msg);
    });

    const cleanup = () => {
      const set = connections.get(userId);
      if (set) { set.delete(ws); if (set.size === 0) connections.delete(userId); }
      if (!connections.has(userId)) {
        presence.set(userId, { online: false });
        run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), userId);
        broadcastPresence(userId, false);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}

function sendError(ws, message) { ws.send(JSON.stringify({ type: 'error', message })); }

function handleMessage(ws, msg) {
  const userId = ws.user.id;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

  if (msg.type === 'message') {
    const conv = core.getConversation(Number(msg.conversationId));
    const part = conv ? core.getParticipant(conv.id, userId) : null;
    const err = core.postError(conv, part, userId);
    if (err) return sendError(ws, err);
    const body = String(msg.body || '');
    if (!body.trim() && !msg.attachmentId) return sendError(ws, 'Message is empty.');
    let attachmentId = null;
    if (msg.attachmentId) {
      const att = get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', msg.attachmentId, userId);
      if (!att) return sendError(ws, 'Attachment not found.');
      attachmentId = att.id;
    }
    const type = attachmentId
      ? (msg.mediaType && ['image', 'video', 'document', 'voice'].includes(msg.mediaType) ? msg.mediaType : 'document')
      : 'text';
    const row = core.createMessage({
      conv, senderId: userId, type, body, attachmentId,
      replyTo: msg.replyTo ? Number(msg.replyTo) : null,
    });
    core.deliverMessage(conv, row);
    return;
  }

  if (msg.type === 'typing') {
    const conv = core.getConversation(Number(msg.conversationId));
    if (!conv || !core.getParticipant(conv.id, userId)) return;
    broadcastToConversation(conv.id, {
      type: 'typing', conversationId: conv.id, userId, typing: Boolean(msg.typing),
    }, userId);
    return;
  }

  if (msg.type === 'read') {
    const conv = core.getConversation(Number(msg.conversationId));
    if (!conv || !core.getParticipant(conv.id, userId)) return;
    core.markReadUpTo(conv.id, userId, msg.messageId ? Number(msg.messageId) : null);
    const part = core.getParticipant(conv.id, userId);
    broadcastToConversation(conv.id, {
      type: 'receipt', conversationId: conv.id, userId, lastReadMessageId: part.last_read_message_id,
    });
    return;
  }

  // ---- WebRTC signaling + call lifecycle: 1:1 conversations only. ----
  if (msg.type === 'signal' || msg.type === 'call-event') {
    const conv = core.getConversation(Number(msg.conversationId));
    if (!conv || !core.getParticipant(conv.id, userId)) return sendError(ws, 'Not a participant.');
    if (conv.kind !== 'dm') {
      return sendError(ws, 'Group calls are not available in this version — 1-to-1 calls work.');
    }
    if (msg.type === 'call-event' && msg.callId) updateCallStatus(Number(msg.callId), msg.event, userId);
    broadcastToConversation(conv.id, {
      type: msg.type, conversationId: conv.id, fromUserId: userId,
      callId: msg.callId || null, event: msg.event || null, kind: msg.kind || null,
      payload: msg.payload || null,
    }, userId);
    return;
  }
}

core.setHub(hub);

module.exports = { attach, hub };
