'use strict';
/** Conversations, messages, polls, communities, calls, search. */
const crypto = require('crypto');
const { run, get, all } = require('./db');
const auth = require('./auth');
const core = require('./core');

function registerRoutes2(app) {
  const presence = () => (core.getHub() ? core.getHub().presence : new Map());
  const hub = () => core.getHub();

  function mustParticipant(req, res) {
    const conv = core.getConversation(Number(req.params.id));
    if (!conv) { res.status(404).json({ error: 'Conversation not found.' }); return null; }
    const part = core.getParticipant(conv.id, req.user.id);
    if (!part) { res.status(403).json({ error: 'You are not a member of this conversation.' }); return null; }
    return { conv, part };
  }

  /* ------------------------------------------------------ conversations */
  app.get('/api/conversations', auth.requireAuth, (req, res) => {
    const rows = all(
      `SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.id
        WHERE p.user_id = ?`, req.user.id);
    const list = rows.map(c => core.serializeConversation(c, req.user.id, presence()));
    list.sort((a, b) => {
      const am = a.lastMessage ? a.lastMessage.id : 0;
      const bm = b.lastMessage ? b.lastMessage.id : 0;
      return bm - am || b.id - a.id;
    });
    res.json({ conversations: list });
  });

  app.get('/api/conversations/:id', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    res.json({ conversation: core.serializeConversation(found.conv, req.user.id, presence()) });
  });

  app.post('/api/conversations/dm', auth.requireAuth, (req, res) => {
    const targetId = Number((req.body || {}).userId);
    const target = get('SELECT * FROM users WHERE id = ?', targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
    if (core.isBlockedEitherWay(req.user.id, targetId)) {
      return res.status(403).json({ error: 'Messages are blocked between you and this user.' });
    }
    let conv = core.findDm(req.user.id, targetId);
    if (!conv) {
      const now = Date.now();
      const info = run("INSERT INTO conversations (kind, created_by, created_at) VALUES ('dm', ?, ?)", req.user.id, now);
      conv = core.getConversation(Number(info.lastInsertRowid));
      run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, req.user.id, 'member', now);
      run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, targetId, 'member', now);
    }
    res.status(201).json({ conversation: core.serializeConversation(conv, req.user.id, presence()) });
  });

  app.post('/api/conversations/groups', auth.requireAuth, (req, res) => {
    const { title, memberIds, temporaryHours, disappearingSeconds } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Group name is required.' });
    const now = Date.now();
    const expiresAt = temporaryHours ? now + Number(temporaryHours) * 3600 * 1000 : null;
    const info = run(
      `INSERT INTO conversations (kind, title, created_by, invite_token, disappearing_seconds, expires_at, created_at)
       VALUES ('group', ?, ?, ?, ?, ?, ?)`,
      String(title).trim(), req.user.id, crypto.randomBytes(12).toString('hex'),
      Number(disappearingSeconds || 0), expiresAt, now);
    const conv = core.getConversation(Number(info.lastInsertRowid));
    run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, req.user.id, 'admin', now);
    for (const mid of Array.isArray(memberIds) ? memberIds : []) {
      const u = get('SELECT id FROM users WHERE id = ?', Number(mid));
      if (u && Number(mid) !== req.user.id) {
        run('INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, Number(mid), 'member', now);
      }
    }
    core.addSystemMessage(conv, `${req.user.name} created the group "${conv.title}"`);
    res.status(201).json({ conversation: core.serializeConversation(conv, req.user.id, presence()) });
  });

  app.patch('/api/conversations/:id', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { conv, part } = found;
    const { title, disappearingSeconds } = req.body || {};
    if (conv.kind !== 'dm' && part.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can change group/channel settings.' });
    }
    if (title !== undefined && conv.kind !== 'dm') run('UPDATE conversations SET title = ? WHERE id = ?', String(title).slice(0, 100), conv.id);
    if (disappearingSeconds !== undefined) {
      run('UPDATE conversations SET disappearing_seconds = ? WHERE id = ?', Math.max(0, Number(disappearingSeconds) || 0), conv.id);
    }
    const updated = core.getConversation(conv.id);
    if (hub()) hub().broadcastToConversation(conv.id, { type: 'conversation-updated', conversationId: conv.id });
    res.json({ conversation: core.serializeConversation(updated, req.user.id, presence()) });
  });

  app.post('/api/conversations/:id/members', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { conv, part } = found;
    if (conv.kind === 'dm') return res.status(400).json({ error: 'Cannot add members to a direct message.' });
    if (part.role !== 'admin') return res.status(403).json({ error: 'Only admins can add members.' });
    const target = get('SELECT * FROM users WHERE id = ?', Number((req.body || {}).userId));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    run('INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      conv.id, target.id, 'member', Date.now());
    core.addSystemMessage(conv, `${target.name} was added to the conversation`);
    res.json({ conversation: core.serializeConversation(conv, req.user.id, presence()) });
  });

  app.delete('/api/conversations/:id/members/:userId', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { conv, part } = found;
    const targetId = Number(req.params.userId);
    if (part.role !== 'admin' && targetId !== req.user.id) {
      return res.status(403).json({ error: 'Only admins can remove other members.' });
    }
    run('DELETE FROM participants WHERE conversation_id = ? AND user_id = ?', conv.id, targetId);
    res.json({ ok: true });
  });

  app.post('/api/conversations/:id/invite', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { conv, part } = found;
    if (conv.kind === 'dm') return res.status(400).json({ error: 'Direct messages have no invite link.' });
    if (!conv.invite_token) {
      if (part.role !== 'admin') return res.status(403).json({ error: 'Only admins can create an invite link.' });
      run('UPDATE conversations SET invite_token = ? WHERE id = ?', crypto.randomBytes(12).toString('hex'), conv.id);
      conv.invite_token = get('SELECT invite_token FROM conversations WHERE id = ?', conv.id).invite_token;
    }
    res.json({ inviteToken: conv.invite_token, invitePath: `/join/${conv.invite_token}` });
  });

  app.post('/api/join/:token', auth.requireAuth, (req, res) => {
    const conv = get('SELECT * FROM conversations WHERE invite_token = ?', String(req.params.token));
    if (!conv || conv.kind === 'dm') return res.status(404).json({ error: 'Invite link is invalid.' });
    if (conv.archived) return res.status(410).json({ error: 'This group has expired and is archived.' });
    run('INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      conv.id, req.user.id, 'member', Date.now());
    if (conv.community_id) {
      run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        conv.community_id, req.user.id, 'member', Date.now());
    }
    res.json({ conversation: core.serializeConversation(conv, req.user.id, presence()) });
  });

  app.post('/api/conversations/:id/read', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    core.markReadUpTo(found.conv.id, req.user.id, (req.body || {}).messageId ? Number(req.body.messageId) : null);
    const part = core.getParticipant(found.conv.id, req.user.id);
    if (hub()) hub().broadcastToConversation(found.conv.id, {
      type: 'receipt', conversationId: found.conv.id, userId: req.user.id, lastReadMessageId: part.last_read_message_id,
    });
    res.json({ ok: true, lastReadMessageId: part.last_read_message_id });
  });

  app.put('/api/conversations/:id/prefs', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { category, mutedUntil, wallpaper } = req.body || {};
    if (category !== undefined) {
      const ok = ['Personal', 'Work', 'Family', 'Community'];
      run('UPDATE participants SET category = ? WHERE conversation_id = ? AND user_id = ?',
        ok.includes(category) ? category : 'Personal', found.conv.id, req.user.id);
    }
    if (mutedUntil !== undefined) {
      run('UPDATE participants SET muted_until = ? WHERE conversation_id = ? AND user_id = ?',
        Number(mutedUntil) || 0, found.conv.id, req.user.id);
    }
    if (wallpaper !== undefined) {
      run('UPDATE participants SET wallpaper = ? WHERE conversation_id = ? AND user_id = ?',
        wallpaper ? String(wallpaper).slice(0, 60) : null, found.conv.id, req.user.id);
    }
    res.json({ conversation: core.serializeConversation(found.conv, req.user.id, presence()) });
  });

  /* ----------------------------------------------------------- messages */
  app.get('/api/conversations/:id/messages', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const now = Date.now();
    const rows = all(
      `SELECT * FROM messages WHERE conversation_id = ? AND scheduled_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?) AND id < ?
       ORDER BY id DESC LIMIT ?`, found.conv.id, now, before, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    // Fetching history marks others' messages as delivered to me.
    run(
      `INSERT OR IGNORE INTO message_receipts (message_id, user_id, delivered_at)
       SELECT id, ?, ? FROM messages WHERE conversation_id = ? AND sender_id != ? AND scheduled_at IS NULL`,
      req.user.id, now, found.conv.id, req.user.id);
    run(
      `UPDATE message_receipts SET delivered_at = COALESCE(delivered_at, ?)
        WHERE user_id = ? AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
      now, req.user.id, found.conv.id);
    res.json({ messages: page.map(m => core.serializeMessage(m, req.user.id)), hasMore });
  });

  app.post('/api/conversations/:id/messages', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const { conv, part } = found;
    const err = core.postError(conv, part, req.user.id);
    if (err) return res.status(403).json({ error: err });
    const { body, attachmentId, replyTo, scheduledAt } = req.body || {};
    if (!String(body || '').trim() && !attachmentId) return res.status(400).json({ error: 'Message is empty.' });
    let att = null;
    if (attachmentId) {
      att = get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', Number(attachmentId), req.user.id);
      if (!att) return res.status(400).json({ error: 'Attachment not found.' });
    }
    const { mediaTypeOf } = require('./routes');
    const row = core.createMessage({
      conv, senderId: req.user.id,
      type: att ? mediaTypeOf(att.mime) : 'text',
      body: String(body || ''), attachmentId: att ? att.id : null,
      replyTo: replyTo ? Number(replyTo) : null,
      scheduledAt: scheduledAt ? Number(scheduledAt) : null,
    });
    if (!row.scheduled_at) core.deliverMessage(conv, row);
    res.status(201).json({ message: core.serializeMessage(row, req.user.id) });
  });

  app.get('/api/conversations/:id/scheduled', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const rows = all(
      'SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND scheduled_at IS NOT NULL ORDER BY scheduled_at',
      found.conv.id, req.user.id);
    res.json({ messages: rows.map(m => core.serializeMessage(m, req.user.id)) });
  });

  app.get('/api/conversations/:id/pins', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const rows = all(
      `SELECT m.* FROM pins p JOIN messages m ON m.id = p.message_id
        WHERE p.conversation_id = ? ORDER BY p.created_at DESC`, found.conv.id);
    res.json({ messages: rows.map(m => core.serializeMessage(m, req.user.id)) });
  });

  function mustOwnMessage(req, res) {
    const row = get('SELECT * FROM messages WHERE id = ?', Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Message not found.' }); return null; }
    if (!core.getParticipant(row.conversation_id, req.user.id)) {
      res.status(403).json({ error: 'Not a participant.' }); return null;
    }
    return row;
  }
  function broadcastUpdate(row) {
    const conv = core.getConversation(row.conversation_id);
    if (hub()) {
      for (const p of core.listParticipants(conv.id)) {
        hub().sendToUser(p.user_id, { type: 'message-updated', conversationId: conv.id, message: core.serializeMessage(row, p.user_id) });
      }
    }
  }

  app.patch('/api/messages/:id', auth.requireAuth, (req, res) => {
    const row = mustOwnMessage(req, res); if (!row) return;
    if (Number(row.sender_id) !== Number(req.user.id)) return res.status(403).json({ error: 'You can only edit your own messages.' });
    if (row.deleted) return res.status(400).json({ error: 'Message already deleted.' });
    if (row.type !== 'text') return res.status(400).json({ error: 'Only text messages can be edited.' });
    run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', String((req.body || {}).body || ''), Date.now(), row.id);
    const updated = get('SELECT * FROM messages WHERE id = ?', row.id);
    broadcastUpdate(updated);
    res.json({ message: core.serializeMessage(updated, req.user.id) });
  });

  app.delete('/api/messages/:id', auth.requireAuth, (req, res) => {
    const row = mustOwnMessage(req, res); if (!row) return;
    if (Number(row.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'You can only delete your own messages.' });
    }
    if (row.scheduled_at) {
      run('DELETE FROM messages WHERE id = ?', row.id);
      return res.json({ ok: true, cancelled: true });
    }
    run('UPDATE messages SET deleted = 1 WHERE id = ?', row.id);
    const updated = get('SELECT * FROM messages WHERE id = ?', row.id);
    broadcastUpdate(updated);
    res.json({ ok: true, message: core.serializeMessage(updated, req.user.id) });
  });

  app.post('/api/messages/:id/reactions', auth.requireAuth, (req, res) => {
    const row = mustOwnMessage(req, res); if (!row) return;
    const emoji = String((req.body || {}).emoji || '').slice(0, 8);
    if (!emoji) return res.status(400).json({ error: 'Emoji required.' });
    run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)',
      row.id, req.user.id, emoji, Date.now());
    broadcastUpdate(row);
    res.json({ message: core.serializeMessage(row, req.user.id) });
  });
  app.delete('/api/messages/:id/reactions', auth.requireAuth, (req, res) => {
    const row = mustOwnMessage(req, res); if (!row) return;
    const emoji = String(req.query.emoji || '').slice(0, 8);
    run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', row.id, req.user.id, emoji);
    broadcastUpdate(row);
    res.json({ message: core.serializeMessage(row, req.user.id) });
  });

  app.post('/api/messages/:id/star', auth.requireAuth, (req, res) => {
    const row = mustOwnMessage(req, res); if (!row) return;
    const existing = get('SELECT 1 AS x FROM stars WHERE message_id = ? AND user_id = ?', row.id, req.user.id);
    if (existing) run('DELETE FROM stars WHERE message_id = ? AND user_id = ?', row.id, req.user.id);
    else run('INSERT INTO stars (message_id, user_id, created_at) VALUES (?,?,?)', row.id, req.user.id, Date.now());
    res.json({ starred: !existing, message: core.serializeMessage(row, req.user.id) });
  });

  app.post('/api/conversations/:id/pins', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const messageId = Number((req.body || {}).messageId);
    const msg = get('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', messageId, found.conv.id);
    if (!msg) return res.status(404).json({ error: 'Message not found in this conversation.' });
    const existing = get('SELECT 1 AS x FROM pins WHERE conversation_id = ? AND message_id = ?', found.conv.id, messageId);
    if (existing) run('DELETE FROM pins WHERE conversation_id = ? AND message_id = ?', found.conv.id, messageId);
    else run('INSERT INTO pins (conversation_id, message_id, pinned_by, created_at) VALUES (?,?,?,?)', found.conv.id, messageId, req.user.id, Date.now());
    broadcastUpdate(msg);
    res.json({ pinned: !existing, message: core.serializeMessage(msg, req.user.id) });
  });

  app.get('/api/starred', auth.requireAuth, (req, res) => {
    const rows = all(
      `SELECT m.* FROM stars s JOIN messages m ON m.id = s.message_id
        WHERE s.user_id = ? AND m.deleted = 0 ORDER BY s.created_at DESC LIMIT 100`, req.user.id);
    res.json({ messages: rows.map(m => core.serializeMessage(m, req.user.id)) });
  });

  app.get('/api/search', auth.requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ messages: [] });
    const params = [req.user.id, `%${q}%`];
    let sql = `SELECT m.* FROM messages m JOIN participants p ON p.conversation_id = m.conversation_id
       WHERE p.user_id = ? AND m.deleted = 0 AND m.scheduled_at IS NULL AND m.body LIKE ?`;
    if (req.query.senderId) { sql += ' AND m.sender_id = ?'; params.push(Number(req.query.senderId)); }
    if (req.query.conversationId) { sql += ' AND m.conversation_id = ?'; params.push(Number(req.query.conversationId)); }
    if (req.query.from) { sql += ' AND m.created_at >= ?'; params.push(Number(req.query.from)); }
    if (req.query.to) { sql += ' AND m.created_at <= ?'; params.push(Number(req.query.to)); }
    sql += ' ORDER BY m.id DESC LIMIT 100';
    const rows = all(sql, ...params);
    res.json({ messages: rows.map(m => core.serializeMessage(m, req.user.id)) });
  });

  /* -------------------------------------------------------------- polls */
  app.post('/api/conversations/:id/polls', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const err = core.postError(found.conv, found.part, req.user.id);
    if (err) return res.status(403).json({ error: err });
    const { question, options } = req.body || {};
    const opts = (Array.isArray(options) ? options : []).map(o => String(o).trim()).filter(Boolean);
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'Poll question is required.' });
    if (opts.length < 2 || opts.length > 10) return res.status(400).json({ error: 'A poll needs 2–10 options.' });
    const info = run('INSERT INTO polls (conversation_id, creator_id, question, created_at) VALUES (?,?,?,?)',
      found.conv.id, req.user.id, String(question).trim(), Date.now());
    const pollId = Number(info.lastInsertRowid);
    for (const text of opts) run('INSERT INTO poll_options (poll_id, text) VALUES (?,?)', pollId, text);
    const row = core.createMessage({ conv: found.conv, senderId: req.user.id, type: 'poll', body: String(question).trim(), pollId });
    core.deliverMessage(found.conv, row);
    res.status(201).json({ message: core.serializeMessage(row, req.user.id) });
  });

  app.get('/api/conversations/:id/polls', auth.requireAuth, (req, res) => {
    const found = mustParticipant(req, res); if (!found) return;
    const polls = all('SELECT id FROM polls WHERE conversation_id = ? ORDER BY id DESC', found.conv.id);
    res.json({ polls: polls.map(p => core.serializePoll(p.id, req.user.id)) });
  });

  app.post('/api/polls/:id/vote', auth.requireAuth, (req, res) => {
    const poll = get('SELECT * FROM polls WHERE id = ?', Number(req.params.id));
    if (!poll) return res.status(404).json({ error: 'Poll not found.' });
    if (!core.getParticipant(poll.conversation_id, req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    const option = get('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?', Number((req.body || {}).optionId), poll.id);
    if (!option) return res.status(400).json({ error: 'Invalid option.' });
    run(
      `INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?,?,?)
       ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id`,
      poll.id, option.id, req.user.id);
    const msg = get('SELECT * FROM messages WHERE poll_id = ?', poll.id);
    if (msg) broadcastUpdate(msg);
    res.json({ poll: core.serializePoll(poll.id, req.user.id) });
  });

  /* --------------------------------------------------------- communities */
  app.post('/api/communities', auth.requireAuth, (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Community name is required.' });
    const now = Date.now();
    const info = run('INSERT INTO communities (name, description, created_by, created_at) VALUES (?,?,?,?)',
      String(name).trim(), String(description || ''), req.user.id, now);
    const communityId = Number(info.lastInsertRowid);
    run('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?,?,?,?)', communityId, req.user.id, 'admin', now);
    // Default #general channel.
    const ch = run(
      `INSERT INTO conversations (kind, title, community_id, broadcast, created_by, invite_token, created_at)
       VALUES ('channel', 'general', ?, 0, ?, ?, ?)`,
      communityId, req.user.id, crypto.randomBytes(12).toString('hex'), now);
    run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      Number(ch.lastInsertRowid), req.user.id, 'admin', now);
    res.status(201).json({ community: communityDetail(communityId, req.user.id) });
  });

  function communityDetail(communityId, userId) {
    const c = get('SELECT * FROM communities WHERE id = ?', communityId);
    if (!c) return null;
    const members = all(
      `SELECT cm.role, u.id, u.name FROM community_members cm JOIN users u ON u.id = cm.user_id WHERE cm.community_id = ?`, communityId);
    const channels = all('SELECT * FROM conversations WHERE community_id = ? ORDER BY id', communityId)
      .map(ch => {
        const joined = Boolean(core.getParticipant(ch.id, userId));
        return { id: ch.id, title: ch.title, broadcast: Boolean(ch.broadcast), archived: Boolean(ch.archived), joined };
      });
    const mine = members.find(m => Number(m.id) === Number(userId));
    return {
      id: c.id, name: c.name, description: c.description, createdBy: c.created_by, createdAt: c.created_at,
      memberCount: members.length, myRole: mine ? mine.role : null,
      members: members.map(m => ({ id: m.id, name: m.name, role: m.role })),
      channels,
    };
  }

  app.get('/api/communities', auth.requireAuth, (req, res) => {
    const rows = all('SELECT id FROM communities ORDER BY id DESC LIMIT 100');
    res.json({ communities: rows.map(r => communityDetail(r.id, req.user.id)) });
  });

  app.get('/api/communities/:id', auth.requireAuth, (req, res) => {
    const detail = communityDetail(Number(req.params.id), req.user.id);
    if (!detail) return res.status(404).json({ error: 'Community not found.' });
    res.json({ community: detail });
  });

  app.post('/api/communities/:id/join', auth.requireAuth, (req, res) => {
    const c = get('SELECT * FROM communities WHERE id = ?', Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Community not found.' });
    run('INSERT OR IGNORE INTO community_members (community_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      c.id, req.user.id, 'member', Date.now());
    for (const ch of all('SELECT * FROM conversations WHERE community_id = ?', c.id)) {
      run('INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        ch.id, req.user.id, 'member', Date.now());
    }
    res.json({ community: communityDetail(c.id, req.user.id) });
  });

  app.post('/api/communities/:id/channels', auth.requireAuth, (req, res) => {
    const c = get('SELECT * FROM communities WHERE id = ?', Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Community not found.' });
    const membership = get('SELECT * FROM community_members WHERE community_id = ? AND user_id = ?', c.id, req.user.id);
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only community admins can create channels.' });
    }
    const { name, broadcast } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Channel name is required.' });
    const now = Date.now();
    const info = run(
      `INSERT INTO conversations (kind, title, community_id, broadcast, created_by, invite_token, created_at)
       VALUES ('channel', ?, ?, ?, ?, ?, ?)`,
      String(name).trim(), c.id, broadcast ? 1 : 0, req.user.id, crypto.randomBytes(12).toString('hex'), now);
    const channelId = Number(info.lastInsertRowid);
    for (const m of all('SELECT * FROM community_members WHERE community_id = ?', c.id)) {
      run('INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        channelId, m.user_id, m.role === 'admin' ? 'admin' : 'member', now);
    }
    res.status(201).json({ community: communityDetail(c.id, req.user.id), channelId });
  });

  app.post('/api/communities/:id/members/:userId/role', auth.requireAuth, (req, res) => {
    const c = get('SELECT * FROM communities WHERE id = ?', Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Community not found.' });
    const mine = get('SELECT * FROM community_members WHERE community_id = ? AND user_id = ?', c.id, req.user.id);
    if (!mine || mine.role !== 'admin') return res.status(403).json({ error: 'Only community admins can change roles.' });
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'member';
    run('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?', role, c.id, Number(req.params.userId));
    res.json({ community: communityDetail(c.id, req.user.id) });
  });

  /* --------------------------------------------------------------- calls */
  app.post('/api/calls', auth.requireAuth, (req, res) => {
    const { calleeId, kind, conversationId } = req.body || {};
    const callee = get('SELECT * FROM users WHERE id = ?', Number(calleeId));
    if (!callee) return res.status(404).json({ error: 'User not found.' });
    if (!['voice', 'video'].includes(kind)) return res.status(400).json({ error: 'kind must be voice or video.' });
    let conv = conversationId ? core.getConversation(Number(conversationId)) : core.findDm(req.user.id, callee.id);
    if (!conv) {
      const created = run("INSERT INTO conversations (kind, created_by, created_at) VALUES ('dm', ?, ?)", req.user.id, Date.now());
      conv = core.getConversation(Number(created.lastInsertRowid));
      const now = Date.now();
      run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, req.user.id, 'member', now);
      run('INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?)', conv.id, callee.id, 'member', now);
    }
    if (conv.kind !== 'dm') return res.status(400).json({ error: 'Calls are 1-to-1 only in this version.' });
    const info = run(
      'INSERT INTO calls (conversation_id, caller_id, callee_id, kind, status, started_at) VALUES (?,?,?,?,?,?)',
      conv.id, req.user.id, callee.id, kind, 'ringing', Date.now());
    res.status(201).json({ call: get('SELECT * FROM calls WHERE id = ?', Number(info.lastInsertRowid)), conversationId: conv.id });
  });

  app.post('/api/calls/:id/respond', auth.requireAuth, (req, res) => {
    const call = get('SELECT * FROM calls WHERE id = ?', Number(req.params.id));
    if (!call) return res.status(404).json({ error: 'Call not found.' });
    if (Number(call.callee_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Only the person called can respond.' });
    const now = Date.now();
    if ((req.body || {}).accept) run("UPDATE calls SET status = 'ongoing', answered_at = ? WHERE id = ?", now, call.id);
    else run("UPDATE calls SET status = 'declined', ended_at = ? WHERE id = ?", now, call.id);
    res.json({ call: get('SELECT * FROM calls WHERE id = ?', call.id) });
  });

  app.post('/api/calls/:id/end', auth.requireAuth, (req, res) => {
    const call = get('SELECT * FROM calls WHERE id = ?', Number(req.params.id));
    if (!call) return res.status(404).json({ error: 'Call not found.' });
    if (![Number(call.caller_id), Number(call.callee_id)].includes(Number(req.user.id))) {
      return res.status(403).json({ error: 'Not your call.' });
    }
    const status = call.status === 'ringing' ? 'missed' : 'ended';
    run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', status, Date.now(), call.id);
    res.json({ call: get('SELECT * FROM calls WHERE id = ?', call.id) });
  });

  app.get('/api/calls', auth.requireAuth, (req, res) => {
    const rows = all(
      `SELECT c.*, u1.name AS caller_name, u2.name AS callee_name FROM calls c
         JOIN users u1 ON u1.id = c.caller_id JOIN users u2 ON u2.id = c.callee_id
        WHERE c.caller_id = ? OR c.callee_id = ? ORDER BY c.id DESC LIMIT 50`, req.user.id, req.user.id);
    res.json({
      calls: rows.map(c => ({
        id: c.id, conversationId: c.conversation_id, callerId: c.caller_id, calleeId: c.callee_id,
        callerName: c.caller_name, calleeName: c.callee_name, kind: c.kind, status: c.status,
        startedAt: c.started_at, answeredAt: c.answered_at, endedAt: c.ended_at,
        direction: Number(c.caller_id) === Number(req.user.id) ? 'outgoing' : 'incoming',
      })),
    });
  });
}

module.exports = { registerRoutes2 };
