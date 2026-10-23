'use strict';
/**
 * Shared messaging core — used by the REST routes and the WebSocket layer so
 * posting rules (membership, blocks, broadcast channels, archived/temporary
 * groups) are enforced identically on every path.
 */
const { run, get, all } = require('./db');
const { getSetting } = require('./auth');

let hub = null;
function setHub(h) { hub = h; }
function getHub() { return hub; }

/* ------------------------------------------------------------- membership */
function getConversation(id) { return get('SELECT * FROM conversations WHERE id = ?', id); }
function getParticipant(conversationId, userId) {
  return get('SELECT * FROM participants WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
}
function listParticipants(conversationId) {
  return all(
    `SELECT p.*, u.name, u.identifier, u.identifier_type, u.bio, u.avatar_path, u.last_seen_at, u.created_at AS user_created_at
       FROM participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = ? ORDER BY p.joined_at`, conversationId);
}
function isBlockedEitherWay(aId, bId) {
  const row = get(
    `SELECT 1 AS x FROM blocks
      WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)`,
    aId, bId, bId, aId);
  return Boolean(row);
}

/** Returns an error string when the user may not post, otherwise null. */
function postError(conv, participant, senderId) {
  if (!conv) return 'Conversation not found.';
  if (!participant) return 'You are not a member of this conversation.';
  if (conv.archived) return 'This conversation is archived (read-only).';
  if (conv.broadcast && participant.role !== 'admin') {
    return 'Only admins can post in this broadcast channel.';
  }
  if (conv.kind === 'dm') {
    const other = get(
      'SELECT user_id FROM participants WHERE conversation_id = ? AND user_id != ?', conv.id, senderId);
    if (other && isBlockedEitherWay(senderId, other.user_id)) {
      return 'Messages are blocked between you and this user.';
    }
  }
  return null;
}

/* ------------------------------------------------------------- messages */
function createMessage({ conv, senderId, type = 'text', body = '', attachmentId = null, pollId = null, replyTo = null, scheduledAt = null }) {
  const now = Date.now();
  let expiresAt = null;
  if (!scheduledAt && conv.disappearing_seconds > 0 && type !== 'system') {
    expiresAt = now + conv.disappearing_seconds * 1000;
  }
  const info = run(
    `INSERT INTO messages (conversation_id, sender_id, type, body, attachment_id, poll_id, reply_to, expires_at, scheduled_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    conv.id, senderId, type, body, attachmentId, pollId, replyTo, expiresAt, scheduledAt, now
  );
  return get('SELECT * FROM messages WHERE id = ?', Number(info.lastInsertRowid));
}

function serializeMessage(row, viewerId) {
  if (!row) return null;
  const sender = get('SELECT id, name FROM users WHERE id = ?', row.sender_id);
  let attachment = null;
  if (row.attachment_id) {
    const a = get('SELECT id, original_name, mime, size FROM attachments WHERE id = ?', row.attachment_id);
    if (a) attachment = { id: a.id, name: a.original_name, mime: a.mime, size: a.size, url: `/api/attachments/${a.id}/download` };
  }
  let reply = null;
  if (row.reply_to) {
    const r = get(
      `SELECT m.id, m.body, m.type, m.deleted, u.name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`, row.reply_to);
    if (r) reply = { id: r.id, body: r.deleted ? '' : r.body.slice(0, 120), type: r.type, senderName: r.sender_name, deleted: Boolean(r.deleted) };
  }
  const reactions = all(
    `SELECT emoji, COUNT(*) AS n,
            MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE message_id = ? GROUP BY emoji`, viewerId, row.id)
    .map(r => ({ emoji: r.emoji, count: r.n, mine: Boolean(r.mine) }));
  const starred = viewerId
    ? Boolean(get('SELECT 1 AS x FROM stars WHERE message_id = ? AND user_id = ?', row.id, viewerId)) : false;
  const pinned = Boolean(get('SELECT 1 AS x FROM pins WHERE message_id = ? AND conversation_id = ?', row.id, row.conversation_id));
  let poll = null;
  if (row.poll_id) poll = serializePoll(row.poll_id, viewerId);
  // Read/delivery state (sender's view): derived from receipts.
  let delivery = null;
  if (viewerId && Number(viewerId) === Number(row.sender_id)) {
    const recs = all('SELECT delivered_at, read_at FROM message_receipts WHERE message_id = ?', row.id);
    if (recs.length) {
      const allRead = recs.every(r => r.read_at);
      const allDelivered = recs.every(r => r.delivered_at);
      delivery = allRead ? 'read' : allDelivered ? 'delivered' : 'sent';
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: sender ? sender.name : 'Unknown',
    type: row.deleted ? 'text' : row.type,
    body: row.deleted ? '' : row.body,
    deleted: Boolean(row.deleted),
    attachment: row.deleted ? null : attachment,
    replyTo: reply,
    editedAt: row.edited_at || null,
    reactions, starred, pinned, poll, delivery,
    scheduledAt: row.scheduled_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  };
}

function serializePoll(pollId, viewerId) {
  const poll = get('SELECT * FROM polls WHERE id = ?', pollId);
  if (!poll) return null;
  const options = all(
    `SELECT o.id, o.text, COUNT(v.user_id) AS votes,
            MAX(CASE WHEN v.user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
      WHERE o.poll_id = ? GROUP BY o.id ORDER BY o.id`, viewerId || 0, pollId);
  const total = options.reduce((s, o) => s + o.votes, 0);
  const myVote = get('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, viewerId || 0);
  return {
    id: poll.id, question: poll.question, totalVotes: total,
    myOptionId: myVote ? myVote.option_id : null,
    options: options.map(o => ({ id: o.id, text: o.text, votes: o.votes, mine: Boolean(o.mine) })),
  };
}

function markDelivered(messageId, userId) {
  run(
    `INSERT INTO message_receipts (message_id, user_id, delivered_at) VALUES (?,?,?)
     ON CONFLICT(message_id, user_id) DO UPDATE SET delivered_at = COALESCE(delivered_at, excluded.delivered_at)`,
    messageId, userId, Date.now());
}
function markReadUpTo(conversationId, userId, messageId) {
  const part = getParticipant(conversationId, userId);
  if (!part) return;
  const target = messageId || Number(get('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE conversation_id = ?', conversationId).m);
  if (target > part.last_read_message_id) {
    run('UPDATE participants SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?', target, conversationId, userId);
  }
  run(
    `INSERT OR IGNORE INTO message_receipts (message_id, user_id, delivered_at, read_at)
     SELECT id, ?, ?, ? FROM messages
      WHERE conversation_id = ? AND id <= ? AND sender_id != ?`,
    userId, Date.now(), Date.now(), conversationId, target, userId);
  run(
    `UPDATE message_receipts SET read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?)
      WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE conversation_id = ? AND id <= ?)`,
    Date.now(), Date.now(), userId, conversationId, target);
}

/* ---------------------------------------------------------- notifications */
function notifyMessage(conv, messageRow, senderName) {
  const others = all('SELECT user_id FROM participants WHERE conversation_id = ? AND user_id != ?', conv.id, messageRow.sender_id);
  const textBody = messageRow.type === 'text' ? messageRow.body.slice(0, 80) : `sent a ${messageRow.type}`;
  for (const o of others) {
    const info = run(
      `INSERT INTO notifications (user_id, type, conversation_id, message_id, text, created_at) VALUES (?,?,?,?,?,?)`,
      o.user_id, 'message', conv.id, messageRow.id, `${senderName}: ${textBody}`, Date.now());
    if (hub) {
      hub.sendToUser(o.user_id, {
        type: 'notification',
        notification: { id: Number(info.lastInsertRowid), conversationId: conv.id, text: `${senderName}: ${textBody}`, createdAt: Date.now() },
      });
    }
  }
}

/** Persist + push a fresh message to all participants (except optionally one). */
function deliverMessage(conv, messageRow, exceptUserId) {
  const sender = get('SELECT name FROM users WHERE id = ?', messageRow.sender_id);
  notifyMessage(conv, messageRow, sender ? sender.name : 'Someone');
  if (hub) hub.broadcastMessage(conv, messageRow, exceptUserId);
}

/* --------------------------------------------------------- conversations */
function unreadCount(conversationId, userId, lastRead) {
  const row = get(
    `SELECT COUNT(*) AS n FROM messages
      WHERE conversation_id = ? AND id > ? AND sender_id != ? AND scheduled_at IS NULL AND deleted = 0`,
    conversationId, lastRead, userId);
  return row ? row.n : 0;
}

function serializeConversation(conv, userId, presenceMap) {
  const part = getParticipant(conv.id, userId);
  const participants = listParticipants(conv.id);
  let title = conv.title;
  let otherUser = null;
  if (conv.kind === 'dm') {
    const other = participants.find(p => Number(p.user_id) !== Number(userId));
    if (other) {
      title = other.name;
      otherUser = {
        id: other.user_id, name: other.name, bio: other.bio || '',
        identifierType: other.identifier_type,
        avatarUrl: null, online: false, lastSeenAt: null,
      };
      // fill presence/privacy-aware fields
      const full = get('SELECT * FROM users WHERE id = ?', other.user_id);
      const { publicUser } = require('./auth');
      const pub = publicUser(full, userId, presenceMap);
      otherUser.avatarUrl = pub.avatarUrl; otherUser.online = pub.online; otherUser.lastSeenAt = pub.lastSeenAt;
    }
  }
  const last = get(
    `SELECT * FROM messages WHERE conversation_id = ? AND scheduled_at IS NULL
      ORDER BY id DESC LIMIT 1`, conv.id);
  return {
    id: conv.id,
    kind: conv.kind,
    title,
    communityId: conv.community_id || null,
    broadcast: Boolean(conv.broadcast),
    archived: Boolean(conv.archived),
    expiresAt: conv.expires_at || null,
    disappearingSeconds: conv.disappearing_seconds,
    createdBy: conv.created_by,
    myRole: part ? part.role : null,
    category: part ? part.category : 'Personal',
    mutedUntil: part ? part.muted_until : 0,
    wallpaper: part ? part.wallpaper : null,
    otherUser,
    participants: participants.map(p => ({ id: p.user_id, name: p.name, role: p.role, joinedAt: p.joined_at })),
    lastMessage: last ? serializeMessage(last, userId) : null,
    unread: part ? unreadCount(conv.id, userId, part.last_read_message_id) : 0,
    createdAt: conv.created_at,
  };
}

function findDm(userA, userB) {
  const row = get(
    `SELECT c.* FROM conversations c
      JOIN participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
      JOIN participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
      WHERE c.kind = 'dm' LIMIT 1`, userA, userB);
  return row || null;
}

function addSystemMessage(conv, body) {
  const row = createMessage({ conv, senderId: conv.created_by || get('SELECT user_id FROM participants WHERE conversation_id = ? LIMIT 1', conv.id)?.user_id, type: 'system', body });
  if (hub) hub.broadcastMessage(conv, row);
  return row;
}

module.exports = {
  setHub, getHub,
  getConversation, getParticipant, listParticipants, isBlockedEitherWay, postError,
  createMessage, serializeMessage, serializePoll, markDelivered, markReadUpTo,
  notifyMessage, deliverMessage, unreadCount, serializeConversation,
  findDm, addSystemMessage,
};
