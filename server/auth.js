'use strict';
/**
 * Authentication & session helpers.
 * - Passwords are hashed with bcryptjs — never stored in plain text.
 * - Login returns a JWT that references a row in `sessions`, so any session
 *   can be revoked instantly from the Devices & Sessions page.
 * - Login attempts are rate limited per identifier (brute-force protection).
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { run, get, all } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-in-production';
const TOKEN_TTL = '30d';

/* ------------------------------------------------------------------ utils */
function detectIdentifierType(identifier) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) return 'email';
  if (/^\+?[0-9][0-9\s-]{6,14}$/.test(identifier)) return 'phone';
  return null;
}

function hashPassword(plain) { return bcrypt.hashSync(plain, 10); }
function checkPassword(plain, hash) { return bcrypt.compareSync(plain, hash); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

/* ------------------------------------------------------- login rate limit */
// Failed attempts per identifier within the window → temporary lockout.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // identifier -> { count, firstAt }

function loginRateLimited(identifier) {
  const rec = loginFails.get(identifier);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(identifier); return false; }
  return rec.count >= LOGIN_MAX_FAILS;
}
function recordLoginFail(identifier) {
  const now = Date.now();
  const rec = loginFails.get(identifier);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) loginFails.set(identifier, { count: 1, firstAt: now });
  else rec.count += 1;
}
function clearLoginFails(identifier) { loginFails.delete(identifier); }

/* ---------------------------------------------------------------- sessions */
function createSession(userId, deviceLabel, ip) {
  const now = Date.now();
  const info = run(
    'INSERT INTO sessions (user_id, device_label, ip, created_at, last_used_at) VALUES (?,?,?,?,?)',
    userId, deviceLabel || 'Unknown device', ip || null, now, now
  );
  const sessionId = Number(info.lastInsertRowid);
  const token = jwt.sign({ sub: userId, sid: sessionId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, sessionId };
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const session = get('SELECT * FROM sessions WHERE id = ? AND revoked = 0', payload.sid);
    if (!session || Number(session.user_id) !== Number(payload.sub)) return null;
    run('UPDATE sessions SET last_used_at = ? WHERE id = ?', Date.now(), session.id);
    const user = get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) return null;
    return { user, session };
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid, non-revoked session token. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const result = token ? verifyToken(token) : null;
  if (!result) return res.status(401).json({ error: 'Unauthorized — please log in again.' });
  req.user = result.user;
  req.session = result.session;
  next();
}

/* ------------------------------------------------------------- user views */
function getSetting(userId, key, fallback) {
  const row = get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', userId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setSetting(userId, key, value) {
  run(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    userId, key, JSON.stringify(value)
  );
}

/**
 * Shape a user row for API output, enforcing the target's privacy settings
 * relative to the viewer. last_seen_visibility / photo_visibility:
 * 'everyone' | 'nobody'. Online presence is hidden when last-seen is hidden.
 */
function publicUser(row, viewerId, presence) {
  if (!row) return null;
  const isSelf = viewerId && Number(viewerId) === Number(row.id);
  const lastSeenVisibility = getSetting(row.id, 'last_seen_visibility', 'everyone');
  const photoVisibility = getSetting(row.id, 'photo_visibility', 'everyone');
  const canSeePresence = isSelf || lastSeenVisibility !== 'nobody';
  const canSeePhoto = isSelf || photoVisibility !== 'nobody';
  const p = presence ? presence.get(row.id) : null;
  return {
    id: row.id,
    identifier: isSelf ? row.identifier : undefined,
    identifierType: row.identifier_type,
    name: row.name,
    bio: row.bio || '',
    avatarUrl: canSeePhoto && row.avatar_path ? `/files/avatars/${row.avatar_path}` : null,
    online: canSeePresence ? Boolean(p && p.online) : false,
    lastSeenAt: canSeePresence ? (row.last_seen_at || null) : null,
    createdAt: row.created_at,
  };
}

module.exports = {
  detectIdentifierType, hashPassword, checkPassword, sha256,
  loginRateLimited, recordLoginFail, clearLoginFails,
  createSession, verifyToken, requireAuth,
  getSetting, setSetting, publicUser,
};
