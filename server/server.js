'use strict';
/**
 * ConnectX AI — server entry point.
 * Express REST API + WebSocket realtime + static SPA, all on one port.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { run, get, all } = require('./db');
const core = require('./core');
const { registerRoutes, AVATAR_DIR } = require('./routes');
const { registerRoutes2 } = require('./routes2');
const wsLayer = require('./ws');

const PORT = Number(process.env.PORT || 3000);
const SWEEP_MS = Number(process.env.SWEEP_MS || 1000);

const app = express();
app.use(express.json({ limit: '2mb' }));

registerRoutes(app);
registerRoutes2(app);

// Avatars are public images (subject to per-user photo-visibility in API
// responses); message attachments are NEVER served statically — they go
// through the access-checked /api/attachments/:id/download route.
app.use('/files/avatars', express.static(AVATAR_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer / upload errors → clean JSON 400s.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || (err && /file type|Unsupported|Avatar must/.test(err.message || ''))) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});
app.use((err, req, res, next) => {
  console.error('[connectx] error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const server = http.createServer(app);
wsLayer.attach(server);

/* --------------------------------------------------------- background jobs */
function sweep() {
  const now = Date.now();
  try {
    // 1) Disappearing messages whose timer has elapsed.
    run('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?', now);

    // 2) Scheduled messages that are due → deliver them now.
    const due = all('SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at', now);
    for (const row of due) {
      const conv = core.getConversation(row.conversation_id);
      if (!conv) { run('DELETE FROM messages WHERE id = ?', row.id); continue; }
      let expiresAt = null;
      if (conv.disappearing_seconds > 0) expiresAt = now + conv.disappearing_seconds * 1000;
      run('UPDATE messages SET scheduled_at = NULL, created_at = ?, expires_at = ? WHERE id = ?', now, expiresAt, row.id);
      const fresh = get('SELECT * FROM messages WHERE id = ?', row.id);
      core.deliverMessage(conv, fresh);
    }

    // 3) Temporary groups past expiry → archive (read-only).
    const expiredGroups = all(
      'SELECT * FROM conversations WHERE expires_at IS NOT NULL AND expires_at <= ? AND archived = 0', now);
    for (const conv of expiredGroups) {
      run('UPDATE conversations SET archived = 1 WHERE id = ?', conv.id);
      const fresh = core.getConversation(conv.id);
      core.addSystemMessage(fresh, '⏰ This temporary group has expired and is now archived (read-only).');
      if (core.getHub()) core.getHub().broadcastToConversation(conv.id, { type: 'conversation-updated', conversationId: conv.id });
    }
  } catch (e) {
    console.error('[connectx] sweep error:', e.message);
  }
}
const sweepTimer = setInterval(sweep, SWEEP_MS);
sweepTimer.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ConnectX AI running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
