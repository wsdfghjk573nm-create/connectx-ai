'use strict';
/**
 * Database layer — SQLite via Node's built-in `node:sqlite` (Node >= 22.5).
 * Zero-setup local database. See README → "Migrating to PostgreSQL" for the
 * production database path; the SQL used in this codebase is deliberately
 * kept close to standard SQL to make that migration straightforward.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'connectx.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier    TEXT NOT NULL UNIQUE,          -- email address or phone number
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('email','phone')),
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_path   TEXT,                          -- relative path under uploads/
  last_seen_at  INTEGER,                       -- epoch ms
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label TEXT NOT NULL DEFAULT 'Unknown device',
  ip           TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS communities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);

-- kind: 'dm' | 'group' | 'channel'. Channels belong to a community.
-- broadcast = 1 → only participants with role 'admin' may post (channels).
-- expires_at on a group → temporary group: archived automatically at expiry.
CREATE TABLE IF NOT EXISTS conversations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('dm','group','channel')),
  title                TEXT,
  community_id         INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  broadcast            INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_token         TEXT,
  disappearing_seconds INTEGER NOT NULL DEFAULT 0,
  expires_at           INTEGER,
  archived             INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_community ON conversations(community_id);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  joined_at           INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted_until         INTEGER NOT NULL DEFAULT 0,   -- 0 = not muted
  category            TEXT NOT NULL DEFAULT 'Personal',
  wallpaper           TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uploader_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL DEFAULT 'text'
                  CHECK (type IN ('text','image','video','document','voice','system','poll')),
  body            TEXT NOT NULL DEFAULT '',
  attachment_id   INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  poll_id         INTEGER,
  reply_to        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  edited_at       INTEGER,
  deleted         INTEGER NOT NULL DEFAULT 0,  -- deleted-for-everyone tombstone
  expires_at      INTEGER,                     -- disappearing messages
  scheduled_at    INTEGER,                     -- NULL = sent immediately
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- Per-message delivery/read receipts (drives DM read ticks).
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at INTEGER,
  read_at      INTEGER,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Per-conversation pins (visible to all participants).
CREATE TABLE IF NOT EXISTS pins (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

-- Per-user stars.
CREATE TABLE IF NOT EXISTS stars (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  creator_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  text    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  caller_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('voice','video')),
  status          TEXT NOT NULL DEFAULT 'ringing'
                  CHECK (status IN ('ringing','ongoing','ended','missed','declined')),
  started_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_users ON calls(caller_id, callee_id);

CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL DEFAULT 'message',
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  text            TEXT NOT NULL DEFAULT '',
  is_read         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS blocks (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`);

/* ---- tiny prepared-statement helpers ------------------------------------ */
function run(sql, ...params) { return db.prepare(sql).run(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }

module.exports = { db, run, get, all, DB_PATH };
