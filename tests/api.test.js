'use strict';
/**
 * ConnectX AI — end-to-end test suite.
 * Spawns the real server (SQLite in /tmp, fast sweep) and exercises the REST
 * API + WebSocket protocol exactly as clients do. Run: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3219;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const RUN = Date.now();
const DB_PATH = `/tmp/connectx-test-${RUN}.db`;
const UPLOAD_DIR = `/tmp/connectx-test-uploads-${RUN}`;

let serverProc;
let seq = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerUser(label) {
  seq += 1;
  const identifier = `${label}${seq}-${RUN}@example.com`;
  const { status, data } = await req('POST', '/api/auth/register', {
    body: { identifier, password: 'secret123', name: `User ${label}${seq}`, deviceLabel: 'test' },
  });
  assert.equal(status, 201, `register ${label}: ${JSON.stringify(data)}`);
  return { token: data.token, user: data.user, identifier };
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const client = { ws, events: [], waiters: [] };
    ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      client.events.push(msg);
      client.waiters = client.waiters.filter(w => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    client.waitFor = (pred, timeout = 5000) => new Promise((res, rej) => {
      const found = client.events.find(pred);
      if (found) return res(found);
      client.waiters.push({ pred, resolve: res });
      setTimeout(() => rej(new Error('WS waitFor timed out')), timeout);
    });
    client.send = obj => ws.send(JSON.stringify(obj));
    client.close = () => { try { ws.close(); } catch {} };
  });
}

before(async () => {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH, UPLOAD_DIR,
      SWEEP_MS: '250', JWT_SECRET: 'test-secret', NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
});

after(() => {
  if (serverProc) serverProc.kill('SIGKILL');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

/* --------------------------------------------------------------- auth */
test('register stores a bcrypt hash (never plain text) and login works', async () => {
  const a = await registerUser('hash');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a.user.id);
  db.close();
  assert.ok(row.password_hash.startsWith('$2'), 'password must be bcrypt-hashed');
  assert.ok(!row.password_hash.includes('secret123'));
  const login = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'secret123' } });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
});

test('wrong password is rejected', async () => {
  const a = await registerUser('wrongpw');
  const bad = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'not-the-password' } });
  assert.equal(bad.status, 401);
});

test('login rate limit locks after repeated failures', async () => {
  const a = await registerUser('ratelimit');
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'bad' + i } });
    assert.equal(r.status, 401);
  }
  const blocked = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'secret123' } });
  assert.equal(blocked.status, 429);
});

test('password reset flow (dev-mode token) changes the password and revokes sessions', async () => {
  const a = await registerUser('reset');
  const forgot = await req('POST', '/api/auth/forgot-password', { body: { identifier: a.identifier } });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.resetToken, 'dev mode must return the reset token');
  const reset = await req('POST', '/api/auth/reset-password', {
    body: { token: forgot.data.resetToken, newPassword: 'brandnew1' },
  });
  assert.equal(reset.status, 200);
  const oldToken = await req('GET', '/api/users/me', { token: a.token });
  assert.equal(oldToken.status, 401, 'old sessions revoked after reset');
  const oldPw = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'secret123' } });
  assert.equal(oldPw.status, 401);
  const newPw = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'brandnew1' } });
  assert.equal(newPw.status, 200);
});

test('revoking a session kills its token', async () => {
  const a = await registerUser('revoke');
  const second = await req('POST', '/api/auth/login', { body: { identifier: a.identifier, password: 'secret123', deviceLabel: 'second device' } });
  const sessions = await req('GET', '/api/auth/sessions', { token: a.token });
  const other = sessions.data.sessions.find(s => !s.current);
  assert.ok(other);
  const del = await req('DELETE', `/api/auth/sessions/${other.id}`, { token: a.token });
  assert.equal(del.status, 200);
  const use = await req('GET', '/api/users/me', { token: second.data.token });
  assert.equal(use.status, 401);
});

/* ---------------------------------------------------------- messaging */
test('two users exchange a DM over real WebSocket; history paginates', async () => {
  const a = await registerUser('wsA');
  const b = await registerUser('wsB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  assert.equal(dm.status, 201);
  const convId = dm.data.conversation.id;

  const wsA = await connectWs(a.token);
  const wsB = await connectWs(b.token);
  try {
    wsA.send({ type: 'message', conversationId: convId, body: 'hello over websocket' });
    const got = await wsB.waitFor(m => m.type === 'message' && m.message.body === 'hello over websocket');
    assert.equal(got.message.senderId, a.user.id);
  } finally { wsA.close(); wsB.close(); }

  for (let i = 1; i <= 5; i++) {
    const r = await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: `page-msg-${i}` } });
    assert.equal(r.status, 201);
  }
  const page1 = await req('GET', `/api/conversations/${convId}/messages?limit=2`, { token: b.token });
  assert.equal(page1.data.messages.length, 2);
  assert.equal(page1.data.hasMore, true);
  assert.equal(page1.data.messages[1].body, 'page-msg-5');
  const page2 = await req('GET', `/api/conversations/${convId}/messages?limit=2&before=${page1.data.messages[0].id}`, { token: b.token });
  assert.equal(page2.data.messages.length, 2);
  assert.equal(page2.data.messages[1].body, 'page-msg-3');
});

test('receipts: delivered after receive, read after the recipient reads', async () => {
  const a = await registerUser('rcA');
  const b = await registerUser('rcB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const wsB = await connectWs(b.token);
  try {
    const sent = await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'receipt-check' } });
    await wsB.waitFor(m => m.type === 'message' && m.message.body === 'receipt-check');
    await sleep(150);
    let hist = await req('GET', `/api/conversations/${convId}/messages`, { token: a.token });
    let mine = hist.data.messages.find(m => m.id === sent.data.message.id);
    assert.equal(mine.delivery, 'delivered');
    await req('POST', `/api/conversations/${convId}/read`, { token: b.token, body: {} });
    hist = await req('GET', `/api/conversations/${convId}/messages`, { token: a.token });
    mine = hist.data.messages.find(m => m.id === sent.data.message.id);
    assert.equal(mine.delivery, 'read');
  } finally { wsB.close(); }
});

test('typing indicator is relayed to the other participant', async () => {
  const a = await registerUser('tyA');
  const b = await registerUser('tyB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const wsA = await connectWs(a.token);
  const wsB = await connectWs(b.token);
  try {
    wsA.send({ type: 'typing', conversationId: dm.data.conversation.id, typing: true });
    const t = await wsB.waitFor(m => m.type === 'typing' && m.typing === true);
    assert.equal(t.userId, a.user.id);
  } finally { wsA.close(); wsB.close(); }
});

test('edit and delete: owner can, others cannot', async () => {
  const a = await registerUser('edA');
  const b = await registerUser('edB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const sent = await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'original text' } });
  const mid = sent.data.message.id;
  const foreignDelete = await req('DELETE', `/api/messages/${mid}`, { token: b.token });
  assert.equal(foreignDelete.status, 403);
  const foreignEdit = await req('PATCH', `/api/messages/${mid}`, { token: b.token, body: { body: 'hacked' } });
  assert.equal(foreignEdit.status, 403);
  const edit = await req('PATCH', `/api/messages/${mid}`, { token: a.token, body: { body: 'edited text' } });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.message.body, 'edited text');
  assert.ok(edit.data.message.editedAt);
  const del = await req('DELETE', `/api/messages/${mid}`, { token: a.token });
  assert.equal(del.status, 200);
  assert.equal(del.data.message.deleted, true);
  assert.equal(del.data.message.body, '');
});

test('reactions can be added and are counted', async () => {
  const a = await registerUser('rxA');
  const b = await registerUser('rxB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const sent = await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'react to me' } });
  const r = await req('POST', `/api/messages/${sent.data.message.id}/reactions`, { token: b.token, body: { emoji: '👍' } });
  assert.equal(r.status, 200);
  const reaction = r.data.message.reactions.find(x => x.emoji === '👍');
  assert.ok(reaction && reaction.count === 1);
});

test('message search finds by keyword across my conversations', async () => {
  const a = await registerUser('seA');
  const b = await registerUser('seB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'the quixotic zebra dances' } });
  const found = await req('GET', '/api/search?q=quixotic', { token: b.token });
  assert.ok(found.data.messages.some(m => m.body.includes('quixotic zebra')));
  const outsider = await registerUser('seC');
  const notFound = await req('GET', '/api/search?q=quixotic', { token: outsider.token });
  assert.equal(notFound.data.messages.length, 0);
});

test('disappearing messages vanish after the timer', { timeout: 15000 }, async () => {
  const a = await registerUser('diA');
  const b = await registerUser('diB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const patch = await req('PATCH', `/api/conversations/${convId}`, { token: a.token, body: { disappearingSeconds: 1 } });
  assert.equal(patch.status, 200);
  await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'gone soon' } });
  let hist = await req('GET', `/api/conversations/${convId}/messages`, { token: b.token });
  assert.ok(hist.data.messages.some(m => m.body === 'gone soon'));
  await sleep(2200);
  hist = await req('GET', `/api/conversations/${convId}/messages`, { token: b.token });
  assert.ok(!hist.data.messages.some(m => m.body === 'gone soon'));
});

test('scheduled messages are delivered by the server timer', { timeout: 15000 }, async () => {
  const a = await registerUser('scA');
  const b = await registerUser('scB');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const r = await req('POST', `/api/conversations/${convId}/messages`, {
    token: a.token, body: { body: 'from the future', scheduledAt: Date.now() + 1200 },
  });
  assert.equal(r.status, 201);
  let hist = await req('GET', `/api/conversations/${convId}/messages`, { token: b.token });
  assert.ok(!hist.data.messages.some(m => m.body === 'from the future'));
  await sleep(2200);
  hist = await req('GET', `/api/conversations/${convId}/messages`, { token: b.token });
  assert.ok(hist.data.messages.some(m => m.body === 'from the future'));
});

/* ------------------------------------------------------------- groups */
test('group admin rules: non-admin rename is rejected with 403', async () => {
  const a = await registerUser('grA');
  const b = await registerUser('grB');
  const g = await req('POST', '/api/conversations/groups', { token: a.token, body: { title: 'Team', memberIds: [b.user.id] } });
  assert.equal(g.status, 201);
  const gid = g.data.conversation.id;
  const memberRename = await req('PATCH', `/api/conversations/${gid}`, { token: b.token, body: { title: 'Hijacked' } });
  assert.equal(memberRename.status, 403);
  const adminRename = await req('PATCH', `/api/conversations/${gid}`, { token: a.token, body: { title: 'Team Two' } });
  assert.equal(adminRename.status, 200);
  assert.equal(adminRename.data.conversation.title, 'Team Two');
});

test('invite link lets a new user join the group', async () => {
  const a = await registerUser('inA');
  const c = await registerUser('inC');
  const g = await req('POST', '/api/conversations/groups', { token: a.token, body: { title: 'InviteOnly', memberIds: [] } });
  const inv = await req('POST', `/api/conversations/${g.data.conversation.id}/invite`, { token: a.token });
  assert.equal(inv.status, 200);
  const joined = await req('POST', `/api/join/${inv.data.inviteToken}`, { token: c.token });
  assert.equal(joined.status, 200);
  assert.ok(joined.data.conversation.participants.some(p => p.id === c.user.id));
});

test('temporary group auto-archives at expiry and becomes read-only', { timeout: 15000 }, async () => {
  const a = await registerUser('tmA');
  const g = await req('POST', '/api/conversations/groups', {
    token: a.token, body: { title: 'Short lived', memberIds: [], temporaryHours: 0.0005 }, // ≈1.8s
  });
  const gid = g.data.conversation.id;
  await sleep(3000);
  const after = await req('GET', `/api/conversations/${gid}`, { token: a.token });
  assert.equal(after.data.conversation.archived, true);
  const post = await req('POST', `/api/conversations/${gid}/messages`, { token: a.token, body: { body: 'too late' } });
  assert.equal(post.status, 403);
});

test('poll: create, vote, and counts are correct', async () => {
  const a = await registerUser('poA');
  const b = await registerUser('poB');
  const g = await req('POST', '/api/conversations/groups', { token: a.token, body: { title: 'PollGroup', memberIds: [b.user.id] } });
  const gid = g.data.conversation.id;
  const poll = await req('POST', `/api/conversations/${gid}/polls`, {
    token: a.token, body: { question: 'Lunch?', options: ['Pizza', 'Salad'] },
  });
  assert.equal(poll.status, 201);
  const pollData = poll.data.message.poll;
  const pizza = pollData.options.find(o => o.text === 'Pizza');
  const salad = pollData.options.find(o => o.text === 'Salad');
  await req('POST', `/api/polls/${pollData.id}/vote`, { token: a.token, body: { optionId: pizza.id } });
  const v2 = await req('POST', `/api/polls/${pollData.id}/vote`, { token: b.token, body: { optionId: salad.id } });
  assert.equal(v2.data.poll.totalVotes, 2);
  assert.equal(v2.data.poll.options.find(o => o.text === 'Pizza').votes, 1);
  assert.equal(v2.data.poll.options.find(o => o.text === 'Salad').votes, 1);
});

/* -------------------------------------------------- communities/calls */
test('broadcast channel: members cannot post, admins can', async () => {
  const a = await registerUser('bcA');
  const b = await registerUser('bcB');
  const com = await req('POST', '/api/communities', { token: a.token, body: { name: 'Announce Hub', description: 'x' } });
  assert.equal(com.status, 201);
  const comId = com.data.community.id;
  await req('POST', `/api/communities/${comId}/join`, { token: b.token });
  const ch = await req('POST', `/api/communities/${comId}/channels`, { token: a.token, body: { name: 'announce', broadcast: true } });
  assert.equal(ch.status, 201);
  const memberPost = await req('POST', `/api/conversations/${ch.data.channelId}/messages`, { token: b.token, body: { body: 'member spam' } });
  assert.equal(memberPost.status, 403);
  const adminPost = await req('POST', `/api/conversations/${ch.data.channelId}/messages`, { token: a.token, body: { body: 'official announcement' } });
  assert.equal(adminPost.status, 201);
});

test('WebRTC signaling is relayed only to the other DM participant', async () => {
  const a = await registerUser('sgA');
  const b = await registerUser('sgB');
  const c = await registerUser('sgC');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  const wsA = await connectWs(a.token);
  const wsB = await connectWs(b.token);
  const wsC = await connectWs(c.token);
  try {
    wsA.send({ type: 'signal', conversationId: convId, payload: { kind: 'offer', sdp: { type: 'offer', sdp: 'fake-sdp-123' } } });
    const got = await wsB.waitFor(m => m.type === 'signal');
    assert.equal(got.fromUserId, a.user.id);
    assert.equal(got.payload.sdp.sdp, 'fake-sdp-123');
    await sleep(600);
    assert.ok(!wsC.events.some(m => m.type === 'signal'), 'third user must receive no signaling');
  } finally { wsA.close(); wsB.close(); wsC.close(); }
});

test('group call signaling is honestly rejected', async () => {
  const a = await registerUser('gcA');
  const b = await registerUser('gcB');
  const g = await req('POST', '/api/conversations/groups', { token: a.token, body: { title: 'NoCalls', memberIds: [b.user.id] } });
  const wsA = await connectWs(a.token);
  try {
    wsA.send({ type: 'signal', conversationId: g.data.conversation.id, payload: { kind: 'offer', sdp: {} } });
    const err = await wsA.waitFor(m => m.type === 'error');
    assert.match(err.message, /Group calls are not available/);
  } finally { wsA.close(); }
});

/* ----------------------------------------------------------- attachments */
test('attachments: image ok, .exe rejected, non-participant download 403', async () => {
  const a = await registerUser('atA');
  const b = await registerUser('atB');
  const c = await registerUser('atC');
  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('conversationId', String(convId));
  fd.append('file', new Blob([png], { type: 'image/png' }), 'pic.png');
  const up = await fetch(BASE + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: fd });
  const upData = await up.json();
  assert.equal(up.status, 201, JSON.stringify(upData));
  const attId = upData.attachment.id;

  const fdBad = new FormData();
  fdBad.append('conversationId', String(convId));
  fdBad.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'evil.exe');
  const upBad = await fetch(BASE + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: fdBad });
  assert.equal(upBad.status, 400);

  const sent = await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: '', attachmentId: attId } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.type, 'image');

  const dlB = await fetch(`${BASE}/api/attachments/${attId}/download`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal(dlB.status, 200);
  const dlC = await fetch(`${BASE}/api/attachments/${attId}/download`, { headers: { Authorization: `Bearer ${c.token}` } });
  assert.equal(dlC.status, 403);
});

/* ------------------------------------------------------ blocks & privacy */
test('blocking stops DM creation and messages in an existing DM', async () => {
  const e = await registerUser('blE');
  const f = await registerUser('blF');
  await req('POST', `/api/users/${e.user.id}/block`, { token: f.token });
  const dmTry = await req('POST', '/api/conversations/dm', { token: e.token, body: { userId: f.user.id } });
  assert.equal(dmTry.status, 403);

  const g = await registerUser('blG');
  const h = await registerUser('blH');
  const dm = await req('POST', '/api/conversations/dm', { token: g.token, body: { userId: h.user.id } });
  await req('POST', `/api/users/${g.user.id}/block`, { token: h.token });
  const send = await req('POST', `/api/conversations/${dm.data.conversation.id}/messages`, { token: g.token, body: { body: 'should fail' } });
  assert.equal(send.status, 403);
});

test('privacy: last-seen and online are hidden when set to nobody', async () => {
  const a = await registerUser('pvA');
  const b = await registerUser('pvB');
  const put = await req('PUT', '/api/settings', { token: b.token, body: { last_seen_visibility: 'nobody', photo_visibility: 'nobody' } });
  assert.equal(put.status, 200);
  const view = await req('GET', `/api/users/${b.user.id}`, { token: a.token });
  assert.equal(view.data.user.lastSeenAt, null);
  assert.equal(view.data.user.online, false);
  assert.equal(view.data.user.avatarUrl, null);
});

test('data export contains only my own data', async () => {
  const a = await registerUser('exA');
  const b = await registerUser('exB');
  const dm = await req('POST', '/api/conversations/dm', { token: b.token, body: { userId: a.user.id } });
  const convId = dm.data.conversation.id;
  await req('POST', `/api/conversations/${convId}/messages`, { token: b.token, body: { body: 'b-private-marker-987' } });
  await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'a-own-marker-123' } });
  const exp = await req('GET', '/api/users/me/export', { token: a.token });
  assert.equal(exp.status, 200);
  assert.equal(exp.data.profile.id, a.user.id);
  const raw = JSON.stringify(exp.data);
  assert.ok(raw.includes('a-own-marker-123'));
  assert.ok(!raw.includes('b-private-marker-987'), 'export must not include other users’ messages');
});

/* ------------------------------------------------------------------ AI */
test('built-in assistant: translates phrases and summarizes on request', async () => {
  const a = await registerUser('aiA');
  const b = await registerUser('aiB');
  const chat = await req('POST', '/api/ai/chat', { token: a.token, body: { message: 'translate: thank you' } });
  assert.equal(chat.status, 200);
  assert.ok(chat.data.reply.includes('धन्यवाद'));
  assert.equal(chat.data.source, 'built-in');

  const dm = await req('POST', '/api/conversations/dm', { token: a.token, body: { userId: b.user.id } });
  const convId = dm.data.conversation.id;
  await req('POST', `/api/conversations/${convId}/messages`, { token: a.token, body: { body: 'Please send the report by tomorrow, the deadline is close.' } });
  await req('POST', `/api/conversations/${convId}/messages`, { token: b.token, body: { body: 'Sure, I will send it tonight. Can we also book the meeting room?' } });
  const sum = await req('POST', '/api/ai/summarize', { token: a.token, body: { conversationId: convId } });
  assert.equal(sum.status, 200);
  assert.match(sum.data.summary, /Summary of/);
  const outsider = await registerUser('aiC');
  const forbidden = await req('POST', '/api/ai/summarize', { token: outsider.token, body: { conversationId: convId } });
  assert.equal(forbidden.status, 403);
});
