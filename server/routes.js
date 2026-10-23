'use strict';
/**
 * REST API routes. All posting rules are shared with the WebSocket layer via
 * core.js, so REST and WS behave identically.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { run, get, all } = require('./db');
const auth = require('./auth');
const core = require('./core');
const ai = require('./ai');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');
const ATTACH_DIR = path.join(UPLOAD_DIR, 'attachments');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
fs.mkdirSync(ATTACH_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);

/* ------------------------------------------------------------ uploads */
const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.dll', '.com', '.scr', '.ps1', '.jar', '.apk'];
const DOC_MIMES = [
  'application/pdf', 'text/plain', 'application/zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
function attachmentFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (BLOCKED_EXT.includes(ext)) return cb(new Error('This file type is not allowed for security reasons.'));
  const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') ||
    file.mimetype.startsWith('audio/') || DOC_MIMES.includes(file.mimetype);
  if (!ok) return cb(new Error('Unsupported file type. You can share images, videos, audio/voice notes, PDFs, Office documents and text files.'));
  cb(null, true);
}
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: ATTACH_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: attachmentFilter,
});
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => cb(null, `user-${req.user.id}-${Date.now()}${path.extname(file.originalname || '.png')}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : new Error('Avatar must be an image.'), file.mimetype.startsWith('image/')),
});
function mediaTypeOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return 'document';
}

function registerRoutes(app) {
  const presence = () => (core.getHub() ? core.getHub().presence : new Map());

  /* ---------------------------------------------------------- config */
  app.get('/api/config', (req, res) => {
    res.json({
      appName: 'ConnectX AI', version: '1.0.0',
      maxUploadMb: MAX_UPLOAD_MB,
      aiProviderEnabled: Boolean(process.env.AI_API_KEY),
      devMode: process.env.NODE_ENV !== 'production',
    });
  });

  /* ------------------------------------------------------------ auth */
  app.post('/api/auth/register', (req, res) => {
    const { identifier, password, name, deviceLabel } = req.body || {};
    const idf = String(identifier || '').trim().toLowerCase();
    const type = auth.detectIdentifierType(idf);
    if (!type) return res.status(400).json({ error: 'Enter a valid email address or phone number.' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
    if (get('SELECT id FROM users WHERE identifier = ?', idf)) {
      return res.status(409).json({ error: 'An account with this email/phone already exists.' });
    }
    const info = run(
      'INSERT INTO users (identifier, identifier_type, password_hash, name, created_at) VALUES (?,?,?,?,?)',
      idf, type, auth.hashPassword(String(password)), String(name).trim(), Date.now());
    const user = get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
    const { token } = auth.createSession(user.id, deviceLabel, req.ip);
    res.status(201).json({ token, user: auth.publicUser(user, user.id, presence()) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { identifier, password, deviceLabel } = req.body || {};
    const idf = String(identifier || '').trim().toLowerCase();
    if (auth.loginRateLimited(idf)) {
      return res.status(429).json({ error: 'Too many failed login attempts. Please wait a few minutes and try again.' });
    }
    const user = get('SELECT * FROM users WHERE identifier = ?', idf);
    if (!user || !auth.checkPassword(String(password || ''), user.password_hash)) {
      auth.recordLoginFail(idf);
      return res.status(401).json({ error: 'Invalid email/phone or password.' });
    }
    auth.clearLoginFails(idf);
    const { token } = auth.createSession(user.id, deviceLabel, req.ip);
    res.json({ token, user: auth.publicUser(user, user.id, presence()) });
  });

  app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
    run('UPDATE sessions SET revoked = 1 WHERE id = ?', req.session.id);
    res.json({ ok: true });
  });

  app.get('/api/auth/sessions', auth.requireAuth, (req, res) => {
    const rows = all('SELECT * FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_used_at DESC', req.user.id);
    res.json({
      sessions: rows.map(s => ({
        id: s.id, deviceLabel: s.device_label, ip: s.ip,
        createdAt: s.created_at, lastUsedAt: s.last_used_at,
        current: Number(s.id) === Number(req.session.id),
      })),
    });
  });

  app.delete('/api/auth/sessions/:id', auth.requireAuth, (req, res) => {
    const s = get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    run('UPDATE sessions SET revoked = 1 WHERE id = ?', s.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', auth.requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!auth.checkPassword(String(currentPassword || ''), req.user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(String(newPassword)), req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/forgot-password', (req, res) => {
    const idf = String((req.body || {}).identifier || '').trim().toLowerCase();
    const user = get('SELECT * FROM users WHERE identifier = ?', idf);
    const out = { ok: true, message: 'If an account exists, a reset token has been generated.' };
    if (user) {
      const token = crypto.randomBytes(24).toString('hex');
      run('INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?)',
        user.id, auth.sha256(token), Date.now() + 30 * 60 * 1000, Date.now());
      // Dev mode: no SMTP/SMS provider is configured in this build, so the
      // token is returned/logged for local testing. Never do this in production.
      if (process.env.NODE_ENV !== 'production') out.resetToken = token;
      console.log(`[connectx] password reset token for ${idf}: ${token}`);
    }
    res.json(out);
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Reset token required.' });
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    const row = get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?', auth.sha256(String(token)), Date.now());
    if (!row) return res.status(400).json({ error: 'Reset token is invalid or expired.' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(String(newPassword)), row.user_id);
    run('UPDATE password_resets SET used = 1 WHERE id = ?', row.id);
    run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', row.user_id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------ users */
  app.get('/api/users/me', auth.requireAuth, (req, res) => {
    res.json({ user: auth.publicUser(req.user, req.user.id, presence()) });
  });

  app.patch('/api/users/me', auth.requireAuth, (req, res) => {
    const { name, bio } = req.body || {};
    if (name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', String(name).slice(0, 80), req.user.id);
    if (bio !== undefined) run('UPDATE users SET bio = ? WHERE id = ?', String(bio).slice(0, 300), req.user.id);
    res.json({ user: auth.publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id), req.user.id, presence()) });
  });

  app.post('/api/users/me/avatar', auth.requireAuth, avatarUpload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    run('UPDATE users SET avatar_path = ? WHERE id = ?', req.file.filename, req.user.id);
    res.json({ user: auth.publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id), req.user.id, presence()) });
  });

  app.delete('/api/users/me', auth.requireAuth, (req, res) => {
    run('DELETE FROM users WHERE id = ?', req.user.id);
    res.json({ ok: true, message: 'Account and associated data deleted.' });
  });

  app.get('/api/users/me/export', auth.requireAuth, (req, res) => {
    const uid = req.user.id;
    const data = {
      exportedAt: new Date().toISOString(),
      profile: { id: uid, identifier: req.user.identifier, name: req.user.name, bio: req.user.bio, createdAt: req.user.created_at },
      settings: Object.fromEntries(all('SELECT key, value FROM user_settings WHERE user_id = ?', uid).map(r => [r.key, r.value])),
      conversations: all('SELECT conversation_id, role, category FROM participants WHERE user_id = ?', uid),
      myMessages: all('SELECT id, conversation_id, type, body, created_at FROM messages WHERE sender_id = ? AND deleted = 0', uid),
      myCalls: all('SELECT * FROM calls WHERE caller_id = ? OR callee_id = ?', uid, uid),
      blockedUsers: all('SELECT blocked_user_id, created_at FROM blocks WHERE user_id = ?', uid),
      sessions: all('SELECT id, device_label, created_at, last_used_at, revoked FROM sessions WHERE user_id = ?', uid),
    };
    res.setHeader('Content-Disposition', 'attachment; filename="connectx-data-export.json"');
    res.json(data);
  });

  app.get('/api/users/search', auth.requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });
    const rows = all(
      `SELECT * FROM users WHERE id != ? AND (name LIKE ? OR identifier LIKE ?) ORDER BY name LIMIT 20`,
      req.user.id, `%${q}%`, `%${q}%`);
    res.json({ users: rows.map(u => auth.publicUser(u, req.user.id, presence())) });
  });

  app.get('/api/users/:id', auth.requireAuth, (req, res) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: auth.publicUser(u, req.user.id, presence()) });
  });

  /* -------------------------------------------------- blocks & reports */
  app.post('/api/users/:id/block', auth.requireAuth, (req, res) => {
    const target = Number(req.params.id);
    if (target === req.user.id) return res.status(400).json({ error: 'You cannot block yourself.' });
    if (!get('SELECT id FROM users WHERE id = ?', target)) return res.status(404).json({ error: 'User not found.' });
    run('INSERT OR IGNORE INTO blocks (user_id, blocked_user_id, created_at) VALUES (?,?,?)', req.user.id, target, Date.now());
    res.json({ ok: true });
  });
  app.delete('/api/users/:id/block', auth.requireAuth, (req, res) => {
    run('DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?', req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/users/me/blocks', auth.requireAuth, (req, res) => {
    const rows = all(
      `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_user_id WHERE b.user_id = ?`, req.user.id);
    res.json({ users: rows.map(u => auth.publicUser(u, req.user.id, presence())) });
  });

  app.post('/api/reports', auth.requireAuth, (req, res) => {
    const { targetUserId, messageId, reason } = req.body || {};
    if (!targetUserId && !messageId) return res.status(400).json({ error: 'Nothing to report.' });
    run('INSERT INTO reports (reporter_id, target_user_id, message_id, reason, created_at) VALUES (?,?,?,?,?)',
      req.user.id, targetUserId || null, messageId || null, String(reason || '').slice(0, 500), Date.now());
    res.status(201).json({ ok: true, message: 'Report submitted. Our team record has been stored.' });
  });

  /* ---------------------------------------------------------- settings */
  const SETTING_KEYS = ['photo_visibility', 'last_seen_visibility', 'theme', 'low_data'];
  app.get('/api/settings', auth.requireAuth, (req, res) => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = auth.getSetting(req.user.id, k, k === 'low_data' ? false : k === 'theme' ? 'dark' : 'everyone');
    res.json({ settings: out });
  });
  app.put('/api/settings', auth.requireAuth, (req, res) => {
    const body = req.body || {};
    for (const k of SETTING_KEYS) {
      if (body[k] !== undefined) auth.setSetting(req.user.id, k, body[k]);
    }
    const out = {};
    for (const k of SETTING_KEYS) out[k] = auth.getSetting(req.user.id, k, null);
    res.json({ settings: out });
  });

  /* ------------------------------------------------------- notifications */
  app.get('/api/notifications', auth.requireAuth, (req, res) => {
    const rows = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
    res.json({
      notifications: rows.map(n => ({
        id: n.id, type: n.type, conversationId: n.conversation_id, messageId: n.message_id,
        text: n.text, read: Boolean(n.is_read), createdAt: n.created_at,
      })),
      unread: rows.filter(n => !n.is_read).length,
    });
  });
  app.post('/api/notifications/read-all', auth.requireAuth, (req, res) => {
    run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/notifications/:id/read', auth.requireAuth, (req, res) => {
    run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------- uploads */
  app.post('/api/uploads', auth.requireAuth, attachmentUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const conversationId = Number((req.body || {}).conversationId);
    const conv = conversationId ? core.getConversation(conversationId) : null;
    if (!conv || !core.getParticipant(conv.id, req.user.id)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'You can only upload files to conversations you belong to.' });
    }
    const info = run(
      'INSERT INTO attachments (uploader_id, stored_name, original_name, mime, size, created_at) VALUES (?,?,?,?,?,?)',
      req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, Date.now());
    const id = Number(info.lastInsertRowid);
    res.status(201).json({
      attachment: { id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, mediaType: mediaTypeOf(req.file.mimetype) },
    });
  });

  app.get('/api/attachments/:id/download', auth.requireAuth, (req, res) => {
    const att = get('SELECT * FROM attachments WHERE id = ?', Number(req.params.id));
    if (!att) return res.status(404).json({ error: 'File not found.' });
    // Only participants of a conversation containing this file (or the uploader) may download.
    const msg = get('SELECT conversation_id FROM messages WHERE attachment_id = ?', att.id);
    const allowed = Number(att.uploader_id) === Number(req.user.id) ||
      (msg && core.getParticipant(msg.conversation_id, req.user.id));
    if (!allowed) return res.status(403).json({ error: 'You do not have access to this file.' });
    res.download(path.join(ATTACH_DIR, att.stored_name), att.original_name);
  });

  /* ---------------------------------------------------------------- AI */
  app.post('/api/ai/chat', auth.requireAuth, async (req, res) => {
    const message = String((req.body || {}).message || '');
    if (process.env.AI_API_KEY) {
      try {
        const out = await ai.externalChat(message);
        if (out) return res.json({ reply: out, source: 'external-provider' });
      } catch { /* fall through to local assistant */ }
    }
    res.json({ reply: ai.assistantReply(message), source: 'built-in' });
  });

  app.post('/api/ai/translate', auth.requireAuth, (req, res) => {
    const { text, direction } = req.body || {};
    res.json(ai.translatePhrase(String(text || ''), direction === 'hi-en' ? 'hi-en' : 'en-hi'));
  });

  app.post('/api/ai/suggest', auth.requireAuth, (req, res) => {
    res.json({ suggestions: ai.replySuggestions(String((req.body || {}).context || '')) });
  });

  app.post('/api/ai/summarize', auth.requireAuth, (req, res) => {
    const conv = core.getConversation(Number((req.body || {}).conversationId));
    if (!conv || !core.getParticipant(conv.id, req.user.id)) {
      return res.status(403).json({ error: 'You can only summarize your own conversations.' });
    }
    const rows = all(
      `SELECT m.body, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.deleted = 0 AND m.scheduled_at IS NULL AND m.type = 'text' AND m.body != ''
        ORDER BY m.id DESC LIMIT 100`, conv.id).reverse();
    const title = core.serializeConversation(conv, req.user.id, presence()).title;
    res.json({ summary: ai.summarizeMessages(rows.map(r => ({ body: r.body, senderName: r.sender_name })), title) });
  });
}

module.exports = { registerRoutes, UPLOAD_DIR, AVATAR_DIR, mediaTypeOf };
