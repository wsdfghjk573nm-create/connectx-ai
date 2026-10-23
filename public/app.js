'use strict';
/* ConnectX AI — single-page client. Talks to the REST API + WebSocket on the
   same origin. No framework: the API/WS protocol is framework-agnostic, so a
   React/Next.js or React Native client can be built on the same backend. */

/* ------------------------------------------------------------ state */
const state = {
  token: localStorage.getItem('cx_token') || null,
  me: null,
  ws: null,
  conversations: [],
  activeConv: null,       // serialized conversation
  messages: [],           // currently rendered messages (asc)
  hasMore: false,
  replyTo: null,
  category: 'All',
  communities: [],
  activeCommunity: null,
  settings: {},
  typingTimers: {},
  searchTimer: null,
};
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------ helpers */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(text, ms = 3200) {
  const t = $('#toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) { return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'; }
function fmtTime(ts) {
  const d = new Date(ts); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function fmtClock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function avatarHtml(user, cls = '') {
  if (user && user.avatarUrl) return `<div class="avatar ${cls}" style="background-image:url('${user.avatarUrl}');color:transparent">${initials(user.name)}</div>`;
  return `<div class="avatar ${cls}">${initials(user ? user.name : '?')}</div>`;
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'dark';
  $('#landingThemeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
}

/* ------------------------------------------------------------ modals */
function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') closeModal(); });
function pickList(title, items) {
  // items: [{label, sub, action}] — resolves with chosen item or null
  return new Promise(resolve => {
    openModal(`<h3>${esc(title)}</h3>` + items.map((it, i) =>
      `<button class="btn wide" data-pick="${i}">${esc(it.label)}${it.sub ? ` <span class="small muted">${esc(it.sub)}</span>` : ''}</button>`).join('') +
      `<button class="btn wide ghost" data-pick="-1">Cancel</button>`);
    $('#modalBox').onclick = e => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      const idx = Number(b.dataset.pick); closeModal(); resolve(idx >= 0 ? items[idx] : null);
    };
  });
}

/* ------------------------------------------------------------ auth */
function showAuth(mode) {
  $('#authCard').scrollIntoView({ behavior: 'smooth' });
  $('#tabLogin').classList.toggle('active', mode === 'login');
  $('#tabRegister').classList.toggle('active', mode === 'register');
  $('#loginForm').classList.toggle('hidden', mode !== 'login');
  $('#registerForm').classList.toggle('hidden', mode !== 'register');
  $('#forgotForm').classList.add('hidden');
}
$$('[data-show-auth]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.showAuth)));
$('#tabLogin').addEventListener('click', () => showAuth('login'));
$('#tabRegister').addEventListener('click', () => showAuth('register'));
$('#forgotLink').addEventListener('click', e => {
  e.preventDefault();
  $('#loginForm').classList.add('hidden'); $('#registerForm').classList.add('hidden'); $('#forgotForm').classList.remove('hidden');
});
$('#backToLogin').addEventListener('click', e => { e.preventDefault(); showAuth('login'); });

function deviceLabel() { return navigator.userAgent.slice(0, 90); }

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target); const msg = $('#loginMsg'); msg.classList.remove('error'); msg.textContent = '';
  try {
    const { token, user } = await api('POST', '/api/auth/login', {
      identifier: fd.get('identifier'), password: fd.get('password'), deviceLabel: deviceLabel(),
    });
    state.token = token; state.me = user; localStorage.setItem('cx_token', token);
    enterApp();
  } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
});
$('#registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target); const msg = $('#registerMsg'); msg.classList.remove('error'); msg.textContent = '';
  try {
    const { token, user } = await api('POST', '/api/auth/register', {
      name: fd.get('name'), identifier: fd.get('identifier'), password: fd.get('password'), deviceLabel: deviceLabel(),
    });
    state.token = token; state.me = user; localStorage.setItem('cx_token', token);
    toast(`Welcome to ConnectX AI, ${user.name}!`);
    enterApp();
  } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
});
$('#forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target); const msg = $('#forgotMsg'); msg.classList.remove('error');
  try {
    const out = await api('POST', '/api/auth/forgot-password', { identifier: fd.get('identifier') });
    msg.textContent = out.message;
    if (out.resetToken) {
      $('#resetBox').classList.remove('hidden');
      $('#forgotForm').querySelector('[name=token]').value = out.resetToken;
    } else {
      msg.textContent += ' (In this build the token is printed in the server console — email/SMS sending is not configured.)';
    }
  } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
});
$('#resetBtn').addEventListener('click', async () => {
  const msg = $('#resetMsg'); msg.classList.remove('error');
  try {
    await api('POST', '/api/auth/reset-password', {
      token: $('#forgotForm').querySelector('[name=token]').value,
      newPassword: $('#forgotForm').querySelector('[name=newPassword]').value,
    });
    msg.textContent = 'Password updated — please log in.'; showAuth('login');
  } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
});
$('#landingThemeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ------------------------------------------------------------ websocket */
function wsSend(obj) { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj)); }
function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };
  ws.onclose = () => { if (state.token) setTimeout(() => { if (state.token) connectWs(); }, 2500); };
}
function handleWs(msg) {
  if (msg.type === 'message') {
    const conv = state.conversations.find(c => c.id === msg.conversationId);
    if (state.activeConv && state.activeConv.id === msg.conversationId) {
      if (msg.message.senderId !== state.me.id) {
        appendMessage(msg.message);
        api('POST', `/api/conversations/${msg.conversationId}/read`, {}).catch(() => {});
      } else {
        appendMessage(msg.message);
      }
    } else if (msg.message.senderId !== state.me.id) {
      const muted = conv && conv.mutedUntil > Date.now();
      if (!muted) toast(`💬 ${msg.message.senderName}: ${String(msg.message.body || msg.message.type).slice(0, 60)}`);
    }
    refreshConversations();
  }
  if (msg.type === 'message-updated') {
    if (state.activeConv && state.activeConv.id === msg.conversationId) patchMessage(msg.message);
    refreshConversations();
  }
  if (msg.type === 'typing') {
    if (state.activeConv && state.activeConv.id === msg.conversationId) {
      const bar = $('#typingBar');
      if (msg.typing) {
        const who = state.activeConv.kind === 'dm' ? '' : (nameOfUser(msg.userId) + ' is typing…');
        bar.textContent = who || 'typing…'; bar.classList.remove('hidden');
        clearTimeout(state.typingTimers[msg.conversationId]);
        state.typingTimers[msg.conversationId] = setTimeout(() => bar.classList.add('hidden'), 3200);
      } else bar.classList.add('hidden');
    }
  }
  if (msg.type === 'receipt') {
    if (state.activeConv && state.activeConv.id === msg.conversationId && msg.userId !== state.me.id) patchDelivery();
    refreshConversations();
  }
  if (msg.type === 'presence') {
    if (state.activeConv && state.activeConv.otherUser && state.activeConv.otherUser.id === msg.userId) {
      state.activeConv.otherUser.online = msg.online; state.activeConv.otherUser.lastSeenAt = msg.lastSeenAt;
      renderChatStatus();
    }
    refreshConversations();
  }
  if (msg.type === 'notification') { bumpNotifBadge(); refreshNotifications(); }
  if (msg.type === 'conversation-updated') {
    refreshConversations();
    if (state.activeConv && state.activeConv.id === msg.conversationId) openConversation(msg.conversationId, false);
  }
  if (msg.type === 'signal' || msg.type === 'call-event') handleCallSignal(msg);
  if (msg.type === 'error') toast(msg.message);
}
function nameOfUser(id) {
  const c = state.conversations.find(c => c.otherUser && c.otherUser.id === id);
  return c ? c.otherUser.name : 'Someone';
}

/* ------------------------------------------------------------ navigation */
function switchView(name) {
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  for (const v of ['chats', 'communities', 'discover', 'assistant', 'calls', 'notifications', 'settings']) {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  }
  document.body.classList.remove('in-chat');
  $('#chatView').classList.add('hidden'); $('#communityView').classList.add('hidden');
  $('#assistantView').classList.add('hidden'); $('#contentView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  if (name === 'communities') loadCommunities();
  if (name === 'calls') loadCalls();
  if (name === 'notifications') refreshNotifications();
  if (name === 'settings') loadSettings();
  if (name === 'assistant') { $('#emptyState').classList.add('hidden'); $('#assistantView').classList.remove('hidden'); document.body.classList.add('in-chat'); }
}
$$('.rail-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.nav)));
$('#railAvatar').addEventListener('click', () => switchView('settings'));
for (const id of ['backBtn', 'backBtn2', 'backBtn3', 'backBtn4']) {
  $('#' + id).addEventListener('click', () => { document.body.classList.remove('in-chat'); });
}
function showMain(section) {
  $('#emptyState').classList.add('hidden');
  $('#chatView').classList.toggle('hidden', section !== 'chat');
  $('#communityView').classList.toggle('hidden', section !== 'community');
  $('#assistantView').classList.toggle('hidden', section !== 'assistant');
  $('#contentView').classList.toggle('hidden', section !== 'content');
  document.body.classList.add('in-chat');
}

/* -------------------------------------------------- conversation list */
async function refreshConversations() {
  try {
    const { conversations } = await api('GET', '/api/conversations');
    state.conversations = conversations;
    renderConversationList();
  } catch {}
}
function renderConversationList() {
  const q = ($('#chatSearch').value || '').toLowerCase();
  const list = state.conversations.filter(c => {
    if (state.category !== 'All' && c.kind !== 'channel' && c.category !== state.category) return false;
    if (state.category === 'Community' && c.kind === 'channel') return true;
    if (state.category !== 'All' && state.category !== 'Community' && c.kind === 'channel') return false;
    if (q && !(c.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
  $('#convList').innerHTML = list.length ? list.map(c => {
    const lm = c.lastMessage;
    const preview = !lm ? 'No messages yet'
      : lm.deleted ? '🚫 Message deleted'
      : lm.type === 'text' ? (lm.senderId === state.me.id ? 'You: ' : '') + lm.body
      : lm.type === 'poll' ? '📊 Poll: ' + lm.body
      : lm.type === 'system' ? lm.body
      : '📎 ' + (lm.attachment ? lm.attachment.name : lm.type);
    const av = c.kind === 'dm' && c.otherUser ? avatarHtml(c.otherUser)
      : `<div class="avatar">${c.kind === 'channel' ? '#' : '👥'}</div>`;
    return `<div class="conv-item ${state.activeConv && state.activeConv.id === c.id ? 'active' : ''}" data-open-conv="${c.id}">
      ${av}
      <div class="meta"><div class="name">${esc(c.title || 'Chat')} ${c.archived ? '🗄️' : ''}</div>
      <div class="preview">${esc(String(preview).slice(0, 60))}</div></div>
      <div class="side"><div class="time">${lm ? fmtTime(lm.createdAt) : ''}</div>
      ${c.mutedUntil > Date.now() ? '<span class="mute-ico">🔕</span>' : ''}
      ${c.unread ? `<span class="unread-count">${c.unread}</span>` : ''}</div>
    </div>`;
  }).join('') : '<p class="pad muted">No conversations yet — find people in Discover 🔍</p>';
  $$('#convList [data-open-conv]').forEach(el =>
    el.addEventListener('click', () => openConversation(Number(el.dataset.openConv))));
}
$('#chatSearch').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(async () => {
    const q = $('#chatSearch').value.trim();
    if (q.length < 2) { renderConversationList(); return; }
    try {
      const { messages } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      $('#convList').innerHTML = `<p class="sub-head">${messages.length} message(s) matching “${esc(q)}”</p>` +
        messages.slice(0, 30).map(m => `<div class="conv-item" data-open-conv="${m.conversationId}">
          <div class="avatar">${initials(m.senderName)}</div>
          <div class="meta"><div class="name">${esc(m.senderName)}</div>
          <div class="preview">${esc(m.body.slice(0, 70))}</div></div>
          <div class="side"><div class="time">${fmtTime(m.createdAt)}</div></div></div>`).join('');
      $$('#convList [data-open-conv]').forEach(el =>
        el.addEventListener('click', () => openConversation(Number(el.dataset.openConv))));
    } catch (e) { toast(e.message); }
  }, 350);
});
$('#inboxTabs').addEventListener('click', e => {
  const chip = e.target.closest('[data-cat]'); if (!chip) return;
  state.category = chip.dataset.cat;
  $$('#inboxTabs .chip').forEach(c => c.classList.toggle('active', c === chip));
  renderConversationList();
});

/* -------------------------------------------------- chat view */
async function openConversation(id, scrollBottom = true) {
  try {
    const { conversation } = await api('GET', `/api/conversations/${id}`);
    state.activeConv = conversation;
    state.replyTo = null; $('#replyBar').classList.add('hidden');
    showMain('chat');
    renderChatHeader();
    const { messages, hasMore } = await api('GET', `/api/conversations/${id}/messages?limit=60`);
    state.messages = messages; state.hasMore = hasMore;
    renderMessages();
    if (scrollBottom) scrollMsgs();
    loadPins();
    api('POST', `/api/conversations/${id}/read`, {}).catch(() => {});
    const draft = localStorage.getItem('cx_draft_' + id);
    $('#msgInput').value = draft || '';
    refreshConversations();
  } catch (e) { toast(e.message); }
}
function renderChatHeader() {
  const c = state.activeConv;
  $('#chatName').textContent = c.title || 'Chat';
  const av = $('#chatAvatar');
  if (c.kind === 'dm' && c.otherUser && c.otherUser.avatarUrl) {
    av.style.backgroundImage = `url('${c.otherUser.avatarUrl}')`; av.textContent = ''; av.style.color = 'transparent';
  } else {
    av.style.backgroundImage = ''; av.style.color = '';
    av.textContent = c.kind === 'channel' ? '#' : c.kind === 'group' ? '👥' : initials(c.title);
  }
  renderChatStatus();
  const canCall = c.kind === 'dm';
  $('#voiceCallBtn').title = canCall ? 'Voice call' : 'Group calls are not available in this version — 1-to-1 calls work.';
  $('#videoCallBtn').title = canCall ? 'Video call' : 'Group calls are not available in this version — 1-to-1 calls work.';
  applyWallpaper();
}
function renderChatStatus() {
  const c = state.activeConv; if (!c) return;
  const el = $('#chatStatus');
  if (c.archived) { el.textContent = 'Archived (read-only)'; return; }
  if (c.kind === 'dm' && c.otherUser) {
    el.textContent = c.otherUser.online ? 'online'
      : c.otherUser.lastSeenAt ? 'last seen ' + new Date(c.otherUser.lastSeenAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      : 'last seen hidden';
    return;
  }
  el.textContent = `${c.participants.length} members${c.broadcast ? ' · broadcast channel' : ''}${c.disappearingSeconds ? ' · disappearing messages on' : ''}`;
}
function applyWallpaper() {
  const area = $('#msgArea');
  area.className = '';
  if (state.activeConv && state.activeConv.wallpaper) area.classList.add(state.activeConv.wallpaper);
}
function scrollMsgs() { const a = $('#msgArea'); a.scrollTop = a.scrollHeight; }
$('#msgArea').addEventListener('scroll', async () => {
  const a = $('#msgArea');
  if (a.scrollTop < 40 && state.hasMore && state.messages.length && !a._loading) {
    a._loading = true;
    const before = state.messages[0].id;
    const oldH = a.scrollHeight;
    try {
      const { messages, hasMore } = await api('GET', `/api/conversations/${state.activeConv.id}/messages?limit=60&before=${before}`);
      state.hasMore = hasMore;
      state.messages = [...messages, ...state.messages];
      renderMessages();
      a.scrollTop = a.scrollHeight - oldH;
    } catch {}
    a._loading = false;
  }
});

function ticksHtml(m) {
  if (!m.delivery) return '';
  if (m.delivery === 'read') return '<span class="ticks read">✓✓</span>';
  if (m.delivery === 'delivered') return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}
function attachmentHtml(m) {
  const a = m.attachment; if (!a) return '';
  const low = state.settings.low_data;
  if (m.type === 'image') {
    if (low) return `<div>🖼️ <a href="#" data-load-img="${a.id}">Image: ${esc(a.name)} (tap to load — low-data mode)</a></div>`;
    return `<img class="att" src="${a.url}" alt="${esc(a.name)}" loading="lazy">`;
  }
  if (m.type === 'video') {
    if (low) return `<div>🎬 <a class="doc-link" href="${a.url}">Video: ${esc(a.name)} (${Math.round(a.size / 1024)} KB)</a></div>`;
    return `<video class="att" src="${a.url}" controls preload="metadata"></video>`;
  }
  if (m.type === 'voice') return `<audio src="${a.url}" controls></audio>`;
  return `<div>📄 <a class="doc-link" href="${a.url}" download>${esc(a.name)}</a> <span class="small muted">(${Math.round(a.size / 1024)} KB)</span></div>`;
}
function pollHtml(m) {
  const p = m.poll; if (!p) return '';
  return `<div class="poll-box"><b>📊 ${esc(p.question)}</b>` +
    p.options.map(o => {
      const pct = p.totalVotes ? Math.round(o.votes / p.totalVotes * 100) : 0;
      return `<button class="poll-opt ${o.mine ? 'mine' : ''}" data-vote="${p.id}:${o.id}">${esc(o.text)}
        <span class="small muted">· ${o.votes} vote(s) · ${pct}%</span><div class="poll-bar" style="width:${pct}%"></div></button>`;
    }).join('') + `<div class="small muted">${p.totalVotes} vote(s) — tap to vote or change your vote</div></div>`;
}
function messageHtml(m) {
  const mine = m.senderId === state.me.id;
  if (m.type === 'system') return `<div class="msg system" data-mid="${m.id}">${esc(m.body)}</div>`;
  const reactions = (m.reactions || []).map(r =>
    `<span data-react="${m.id}:${esc(r.emoji)}" class="${r.mine ? 'mine' : ''}" title="Tap to toggle">${esc(r.emoji)} ${r.count}</span>`).join('');
  return `<div class="msg ${mine ? 'out' : 'in'}" data-mid="${m.id}">
    ${!mine && state.activeConv.kind !== 'dm' ? `<div class="sender">${esc(m.senderName)}</div>` : ''}
    ${m.replyTo ? `<div class="reply-quote"><b>${esc(m.replyTo.senderName)}</b>: ${esc(m.replyTo.deleted ? '🚫 deleted message' : m.replyTo.body)}</div>` : ''}
    ${m.deleted ? '<span class="deleted">🚫 This message was deleted</span>'
      : m.type === 'poll' ? pollHtml(m)
      : `${attachmentHtml(m)}<span>${esc(m.body)}</span>`}
    <div class="meta-row">
      ${m.pinned ? '📌' : ''}${m.starred ? '⭐' : ''}
      ${m.scheduledAt ? '⏰ ' : ''}${m.editedAt ? 'edited ' : ''}${fmtClock(m.createdAt)} ${mine ? ticksHtml(m) : ''}
    </div>
    ${reactions ? `<div class="reactions">${reactions}</div>` : ''}
    <button class="icon-btn msg-menu" data-menu="${m.id}">▾</button>
  </div>`;
}
function renderMessages() {
  $('#msgArea').innerHTML = state.messages.map(messageHtml).join('') || '<p class="muted" style="text-align:center">No messages yet — say hello! 👋</p>';
  bindMessageEvents();
}
function appendMessage(m) {
  if (state.messages.some(x => x.id === m.id)) { patchMessage(m); return; }
  state.messages.push(m);
  const area = $('#msgArea');
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 220;
  const empty = area.querySelector('p.muted');
  if (empty) empty.remove();
  area.insertAdjacentHTML('beforeend', messageHtml(m));
  bindMessageEvents(area.lastElementChild);
  if (nearBottom || m.senderId === state.me.id) scrollMsgs();
}
function patchMessage(m) {
  const idx = state.messages.findIndex(x => x.id === m.id);
  if (idx >= 0) state.messages[idx] = m;
  const el = document.querySelector(`.msg[data-mid="${m.id}"]`);
  if (el) { const tmp = document.createElement('div'); tmp.innerHTML = messageHtml(m); const node = tmp.firstElementChild; el.replaceWith(node); bindMessageEvents(node); }
  loadPins();
}
async function patchDelivery() {
  if (!state.activeConv) return;
  try {
    const { messages } = await api('GET', `/api/conversations/${state.activeConv.id}/messages?limit=60`);
    for (const m of messages) {
      const idx = state.messages.findIndex(x => x.id === m.id);
      if (idx >= 0 && state.messages[idx].delivery !== m.delivery) { state.messages[idx] = m; patchMessage(m); }
    }
  } catch {}
}
function bindMessageEvents(scope) {
  const root = scope || $('#msgArea');
  root.querySelectorAll('[data-menu]').forEach(b => b.onclick = e => { e.stopPropagation(); messageMenu(Number(b.dataset.menu)); });
  root.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    const [pollId, optionId] = b.dataset.vote.split(':');
    try { const { poll } = await api('POST', `/api/polls/${pollId}/vote`, { optionId: Number(optionId) });
      const m = state.messages.find(x => x.poll && x.poll.id === Number(pollId));
      if (m) { m.poll = poll; patchMessage(m); }
    } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-react]').forEach(s => s.onclick = async () => {
    const [mid, emoji] = s.dataset.react.split(':');
    const m = state.messages.find(x => x.id === Number(mid));
    const mine = m && (m.reactions || []).some(r => r.emoji === emoji && r.mine);
    try {
      const out = mine
        ? await api('DELETE', `/api/messages/${mid}/reactions?emoji=${encodeURIComponent(emoji)}`)
        : await api('POST', `/api/messages/${mid}/reactions`, { emoji });
      patchMessage(out.message);
    } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-load-img]').forEach(a => a.onclick = e => {
    e.preventDefault();
    const img = document.createElement('img'); img.className = 'att'; img.src = `/api/attachments/${a.dataset.loadImg}/download`;
    a.replaceWith(img);
  });
}

/* -------------------------------------------------- message actions */
async function messageMenu(id) {
  const m = state.messages.find(x => x.id === id); if (!m) return;
  const mine = m.senderId === state.me.id;
  const items = [];
  if (!m.deleted && m.type === 'text') items.push({ label: '↩️ Reply', run: () => setReply(m) });
  items.push({ label: '😀 React', run: async () => {
    const em = await pickList('React with…', ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥'].map(e2 => ({ label: e2 })));
    if (em) { try { patchMessage((await api('POST', `/api/messages/${id}/reactions`, { emoji: em.label })).message); } catch (e) { toast(e.message); } }
  }});
  if (!m.deleted) items.push({ label: m.pinned ? '📌 Unpin' : '📌 Pin', run: async () => {
    try { const out = await api('POST', `/api/conversations/${state.activeConv.id}/pins`, { messageId: id }); patchMessage(out.message); toast(out.pinned ? 'Pinned' : 'Unpinned'); } catch (e) { toast(e.message); }
  }});
  items.push({ label: m.starred ? '⭐ Unstar' : '⭐ Star', run: async () => {
    try { const out = await api('POST', `/api/messages/${id}/star`); if (out.message) patchMessage(out.message); toast(out.starred ? 'Starred' : 'Unstarred'); } catch (e) { toast(e.message); }
  }});
  if (!m.deleted && m.type === 'text') items.push({ label: '➡️ Forward', run: () => forwardMessage(m) });
  if (!m.deleted) items.push({ label: '📋 Copy text', run: () => { navigator.clipboard && navigator.clipboard.writeText(m.body || ''); toast('Copied'); } });
  if (mine && !m.deleted && m.type === 'text') items.push({ label: '✏️ Edit', run: () => editMessage(m) });
  if (mine) items.push({ label: '🗑️ Delete for everyone', run: async () => {
    if (!confirm('Delete this message for everyone?')) return;
    try { const out = await api('DELETE', `/api/messages/${id}`); if (out.message) patchMessage(out.message); toast('Deleted'); } catch (e) { toast(e.message); }
  }});
  if (!mine) items.push({ label: '🚩 Report message', run: async () => {
    try { await api('POST', '/api/reports', { messageId: id, targetUserId: m.senderId, reason: 'Reported from chat' }); toast('Report submitted'); } catch (e) { toast(e.message); }
  }});
  const choice = await pickList('Message options', items);
  if (choice) choice.run();
}
function setReply(m) {
  state.replyTo = m.id;
  $('#replyText').textContent = `Replying to ${m.senderName}: ${m.body.slice(0, 80)}`;
  $('#replyBar').classList.remove('hidden');
  $('#msgInput').focus();
}
$('#cancelReply').addEventListener('click', () => { state.replyTo = null; $('#replyBar').classList.add('hidden'); });
async function editMessage(m) {
  openModal(`<h3>Edit message</h3><label>Message<textarea id="editBody" rows="3">${esc(m.body)}</textarea></label>
    <button class="btn primary wide" id="saveEdit">Save</button><button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#saveEdit').onclick = async () => {
    try { patchMessage((await api('PATCH', `/api/messages/${m.id}`, { body: $('#editBody').value })).message); closeModal(); }
    catch (e) { toast(e.message); }
  };
}
async function forwardMessage(m) {
  const targets = state.conversations.filter(c => !c.archived && c.id !== state.activeConv.id);
  if (!targets.length) return toast('No other conversations to forward to.');
  const pick = await pickList('Forward to…', targets.map(c => ({ label: c.title || 'Chat', id: c.id })));
  if (!pick) return;
  try { await api('POST', `/api/conversations/${pick.id}/messages`, { body: m.body }); toast('Forwarded'); }
  catch (e) { toast(e.message); }
}

/* -------------------------------------------------- composer */
let typingState = false;
$('#msgInput').addEventListener('input', e => {
  const c = state.activeConv; if (!c) return;
  localStorage.setItem('cx_draft_' + c.id, e.target.value);
  if (!typingState) { typingState = true; wsSend({ type: 'typing', conversationId: c.id, typing: true }); }
  clearTimeout(state._tt);
  state._tt = setTimeout(() => { typingState = false; wsSend({ type: 'typing', conversationId: c.id, typing: false }); }, 1800);
  e.target.style.height = 'auto'; e.target.style.height = Math.min(110, e.target.scrollHeight) + 'px';
});
$('#msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
$('#sendBtn').addEventListener('click', sendCurrent);
async function sendCurrent(scheduledAt) {
  const c = state.activeConv; if (!c) return;
  const body = $('#msgInput').value.trim();
  if (!body) return;
  try {
    if (scheduledAt) {
      await api('POST', `/api/conversations/${c.id}/messages`, { body, replyTo: state.replyTo, scheduledAt });
      toast('⏰ Message scheduled for ' + new Date(scheduledAt).toLocaleString());
    } else {
      wsSend({ type: 'message', conversationId: c.id, body, replyTo: state.replyTo });
      // Fallback if the socket is down: REST post.
      setTimeout(() => {
        const sent = state.messages.some(m => m.body === body && m.senderId === state.me.id && Date.now() - m.createdAt < 4000);
        if (!sent && state.activeConv && state.activeConv.id === c.id) {
          api('POST', `/api/conversations/${c.id}/messages`, { body, replyTo: state.replyTo })
            .then(out => appendMessage(out.message)).catch(err => toast(err.message));
        }
      }, 1200);
    }
    $('#msgInput').value = ''; $('#msgInput').style.height = 'auto';
    localStorage.removeItem('cx_draft_' + c.id);
    state.replyTo = null; $('#replyBar').classList.add('hidden');
  } catch (e) { toast(e.message); }
}
$('#scheduleBtn').addEventListener('click', () => {
  if (!$('#msgInput').value.trim()) return toast('Type a message first, then schedule it.');
  openModal(`<h3>⏰ Schedule message</h3>
    <label>Send at<input type="datetime-local" id="schedTime"></label>
    <button class="btn primary wide" id="doSchedule">Schedule</button>
    <button class="btn wide ghost" id="viewScheduled">View scheduled in this chat</button>
    <button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#doSchedule').onclick = () => {
    const v = $('#schedTime').value;
    if (!v) return toast('Pick a date and time.');
    const ts = new Date(v).getTime();
    if (ts <= Date.now()) return toast('Pick a future time.');
    closeModal(); sendCurrent(ts);
  };
  $('#viewScheduled').onclick = async () => {
    try {
      const { messages } = await api('GET', `/api/conversations/${state.activeConv.id}/scheduled`);
      openModal('<h3>Scheduled messages</h3>' + (messages.length ? messages.map(m =>
        `<div class="session-row"><span>⏰ ${new Date(m.scheduledAt).toLocaleString()} — ${esc(m.body.slice(0, 60))}</span>
         <button class="btn danger" data-cancel-sched="${m.id}">Cancel</button></div>`).join('')
        : '<p class="muted">None scheduled.</p>') + '<button class="btn wide ghost" onclick="closeModal()">Close</button>');
      $$('#modalBox [data-cancel-sched]').forEach(b => b.onclick = async () => {
        await api('DELETE', `/api/messages/${b.dataset.cancelSched}`); toast('Scheduled message cancelled'); closeModal();
      });
    } catch (e) { toast(e.message); }
  };
});
$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !state.activeConv) return;
  const fd = new FormData();
  fd.append('file', file); fd.append('conversationId', state.activeConv.id);
  toast('Uploading ' + file.name + '…');
  try {
    const res = await fetch('/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const a = data.attachment;
    wsSend({ type: 'message', conversationId: state.activeConv.id, body: '', attachmentId: a.id, mediaType: a.mediaType });
    setTimeout(() => {
      const delivered = state.messages.some(m => m.attachment && m.attachment.id === a.id);
      if (!delivered) {
        api('POST', `/api/conversations/${state.activeConv.id}/messages`, { attachmentId: a.id, body: '' })
          .then(out => appendMessage(out.message)).catch(err => toast(err.message));
      }
    }, 1200);
  } catch (err) { toast(err.message); }
});

/* voice notes */
let mediaRecorder = null, audioChunks = [];
$('#voiceBtn').addEventListener('click', async () => {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice recording is not supported in this browser.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = ev => audioChunks.push(ev.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('#recordBar').classList.add('hidden');
      if (!audioChunks.length || mediaRecorder._cancelled) return;
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const file = new File([blob], 'voice-note.webm', { type: blob.type });
      const fd = new FormData(); fd.append('file', file); fd.append('conversationId', state.activeConv.id);
      const res = await fetch('/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: fd });
      const data = await res.json();
      if (!res.ok) return toast(data.error || 'Voice upload failed');
      wsSend({ type: 'message', conversationId: state.activeConv.id, body: '', attachmentId: data.attachment.id, mediaType: 'voice' });
    };
    mediaRecorder.start();
    $('#recordBar').classList.remove('hidden');
  } catch { toast('Microphone access was denied.'); }
});
$('#stopRecordBtn').addEventListener('click', () => mediaRecorder && mediaRecorder.stop());
$('#cancelRecordBtn').addEventListener('click', () => { if (mediaRecorder) { mediaRecorder._cancelled = true; mediaRecorder.stop(); } });

/* -------------------------------------------------- pins & search in chat */
async function loadPins() {
  if (!state.activeConv) return;
  try {
    const { messages } = await api('GET', `/api/conversations/${state.activeConv.id}/pins`);
    const bar = $('#pinBar');
    if (!messages.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = `📌 ${messages.length} pinned: <b>${esc(messages[0].senderName)}</b>: ${esc(messages[0].body.slice(0, 70))}`;
    bar.onclick = () => {
      const el = document.querySelector(`.msg[data-mid="${messages[0].id}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      else toast('Pinned message is in older history — scroll up to load it.');
    };
  } catch {}
}
$('#chatSearchBtn').addEventListener('click', () => { $('#chatSearchBar').classList.toggle('hidden'); $('#inChatSearch').focus(); });
$('#closeChatSearch').addEventListener('click', () => $('#chatSearchBar').classList.add('hidden'));
$('#inChatSearch').addEventListener('input', async e => {
  const q = e.target.value.trim();
  if (q.length < 2) return;
  try {
    const { messages } = await api('GET', `/api/search?q=${encodeURIComponent(q)}&conversationId=${state.activeConv.id}`);
    if (!messages.length) return toast('No matches in this chat.');
    const target = messages[0];
    const el = document.querySelector(`.msg[data-mid="${target.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else toast(`${messages.length} match(es) — earliest matches may be in older history.`);
  } catch (err) { toast(err.message); }
});
$('#summarizeBtn').addEventListener('click', async () => {
  if (!state.activeConv) return;
  toast('Generating summary on the server…');
  try {
    const { summary } = await api('POST', '/api/ai/summarize', { conversationId: state.activeConv.id });
    openModal(`<h3>✨ Chat summary</h3><p style="white-space:pre-wrap">${esc(summary)}</p><button class="btn wide" onclick="closeModal()">Close</button>`);
    window.closeModal = closeModal;
  } catch (e) { toast(e.message); }
});

/* -------------------------------------------------- chat settings menu */
$('#chatMenuBtn').addEventListener('click', async () => {
  const c = state.activeConv; if (!c) return;
  const isAdmin = c.myRole === 'admin';
  const membersHtml = c.kind !== 'dm' ? `<h4>Members (${c.participants.length})</h4>` + c.participants.map(p =>
    `<div class="session-row"><span>${esc(p.name)} ${p.role === 'admin' ? '· 👑 admin' : ''} ${p.id === state.me.id ? '(you)' : ''}</span>
     ${isAdmin && p.id !== state.me.id ? `<button class="btn danger" data-remove-member="${p.id}">Remove</button>` : ''}</div>`).join('') : '';
  openModal(`<h3>Chat settings</h3>
    ${c.kind !== 'dm' ? `<label>Conversation name<input id="csTitle" value="${esc(c.title || '')}" ${isAdmin ? '' : 'disabled'}></label>
      ${isAdmin ? '<p class="small muted">Only admins can rename.</p>' : ''}` : ''}
    <label>Category (Smart Inbox)
      <select id="csCategory">${['Personal', 'Work', 'Family', 'Community'].map(x => `<option ${c.category === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Chat wallpaper
      <select id="csWallpaper">
        <option value="">Default</option>
        ${[1, 2, 3, 4, 5].map(n => `<option value="wp-${n}" ${c.wallpaper === 'wp-' + n ? 'selected' : ''}>Theme ${n}</option>`).join('')}
      </select></label>
    <label>Disappearing messages ${c.kind !== 'dm' && !isAdmin ? '(admins only)' : ''}
      <select id="csDisappear" ${c.kind !== 'dm' && !isAdmin ? 'disabled' : ''}>
        ${[[0, 'Off'], [3600, '1 hour'], [86400, '24 hours'], [604800, '7 days'], [60, '1 minute (demo)']].map(([v, l]) =>
          `<option value="${v}" ${c.disappearingSeconds === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label>🔕 Mute / Focus Mode until
      <input type="datetime-local" id="csMuteUntil" value="${c.mutedUntil ? new Date(c.mutedUntil - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}"></label>
    <button class="btn wide" id="csUnmute">Unmute now</button>
    ${c.kind !== 'dm' ? `<button class="btn wide" id="csInvite">🔗 Get invite link</button>
      ${isAdmin ? '<button class="btn wide" id="csAddMember">➕ Add member (admin)</button>' : ''}
      <button class="btn wide" id="csPoll">📊 Create poll</button>` : `
      <button class="btn wide danger" id="csBlock">🚫 Block ${esc(c.otherUser ? c.otherUser.name : 'user')}</button>
      <button class="btn wide" id="csReport">🚩 Report user</button>`}
    <button class="btn primary wide" id="csSave">Save settings</button>
    <button class="btn wide ghost" onclick="closeModal()">Close</button>
    ${membersHtml}`);
  window.closeModal = closeModal;
  $$('#modalBox [data-remove-member]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this member?')) return;
    try { await api('DELETE', `/api/conversations/${c.id}/members/${b.dataset.removeMember}`); closeModal(); openConversation(c.id, false); refreshConversations(); }
    catch (e) { toast(e.message); }
  });
  const inv = $('#csInvite');
  if (inv) inv.onclick = async () => {
    try {
      const { invitePath } = await api('POST', `/api/conversations/${c.id}/invite`);
      const link = location.origin + '/#' + invitePath;
      openModal(`<h3>Invite link</h3><p>Share this link — anyone with an account who opens it joins:</p>
        <input readonly value="${link}" onclick="this.select()">
        <button class="btn primary wide" onclick="navigator.clipboard&&navigator.clipboard.writeText('${link}');toast('Link copied')">Copy link</button>
        <button class="btn wide ghost" onclick="closeModal()">Close</button>`);
    } catch (e) { toast(e.message); }
  };
  const add = $('#csAddMember');
  if (add) add.onclick = async () => {
    const users = await searchUsersInteractive('Add member');
    if (!users) return;
    for (const u of users) {
      try { await api('POST', `/api/conversations/${c.id}/members`, { userId: u.id }); } catch (e) { toast(e.message); }
    }
    closeModal(); openConversation(c.id, false);
  };
  const poll = $('#csPoll');
  if (poll) poll.onclick = () => createPollModal(c.id);
  const block = $('#csBlock');
  if (block) block.onclick = async () => {
    if (!confirm('Block this user? They will no longer be able to message you.')) return;
    try { await api('POST', `/api/users/${c.otherUser.id}/block`); closeModal(); toast('User blocked'); } catch (e) { toast(e.message); }
  };
  const report = $('#csReport');
  if (report) report.onclick = async () => {
    try { await api('POST', '/api/reports', { targetUserId: c.otherUser.id, reason: 'Reported from chat menu' }); toast('Report submitted'); } catch (e) { toast(e.message); }
  };
  const unmute = $('#csUnmute');
  if (unmute) unmute.onclick = () => { $('#csMuteUntil').value = ''; };
  $('#csSave').onclick = async () => {
    try {
      if (c.kind !== 'dm' && isAdmin) {
        await api('PATCH', `/api/conversations/${c.id}`, { title: $('#csTitle').value, disappearingSeconds: Number($('#csDisappear').value) });
      } else if (c.kind === 'dm') {
        await api('PATCH', `/api/conversations/${c.id}`, { disappearingSeconds: Number($('#csDisappear').value) });
      }
      const muteV = $('#csMuteUntil').value;
      await api('PUT', `/api/conversations/${c.id}/prefs`, {
        category: $('#csCategory').value,
        wallpaper: $('#csWallpaper').value || null,
        mutedUntil: muteV ? new Date(muteV).getTime() : 0,
      });
      closeModal(); toast('Settings saved');
      openConversation(c.id, false); refreshConversations();
    } catch (e) { toast(e.message); }
  };
});
function createPollModal(convId) {
  openModal(`<h3>📊 Create poll</h3>
    <label>Question<input id="pollQ" placeholder="What's the plan?"></label>
    <label>Option 1<input class="pollOpt"></label>
    <label>Option 2<input class="pollOpt"></label>
    <label>Option 3 (optional)<input class="pollOpt"></label>
    <label>Option 4 (optional)<input class="pollOpt"></label>
    <button class="btn primary wide" id="doPoll">Post poll</button>
    <button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#doPoll').onclick = async () => {
    const options = $$('.pollOpt').map(i => i.value.trim()).filter(Boolean);
    try {
      const out = await api('POST', `/api/conversations/${convId}/polls`, { question: $('#pollQ').value, options });
      appendMessage(out.message); closeModal();
    } catch (e) { toast(e.message); }
  };
}

/* -------------------------------------------------- user picker */
async function searchUsersInteractive(title) {
  return new Promise(resolve => {
    openModal(`<h3>${esc(title)}</h3>
      <input id="pickSearch" placeholder="Search by name, email or phone…">
      <div class="member-pick" id="pickResults"><p class="muted">Type at least 2 characters.</p></div>
      <button class="btn primary wide" id="pickDone">Done</button>
      <button class="btn wide ghost" id="pickCancel">Cancel</button>`);
    const chosen = new Map();
    $('#pickSearch').addEventListener('input', async e => {
      const q = e.target.value.trim();
      if (q.length < 2) return;
      const { users } = await api('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
      $('#pickResults').innerHTML = users.map(u =>
        `<label><input type="checkbox" data-pick-user="${u.id}" ${chosen.has(u.id) ? 'checked' : ''}> ${esc(u.name)} <span class="small muted">${esc(u.identifierType)}</span></label>`).join('') || '<p class="muted">No users found.</p>';
      $$('#pickResults [data-pick-user]').forEach(cb => cb.onchange = () => {
        const u = users.find(x => x.id === Number(cb.dataset.pickUser));
        if (cb.checked) chosen.set(u.id, u); else chosen.delete(u.id);
      });
    });
    $('#pickDone').onclick = () => { closeModal(); resolve([...chosen.values()]); };
    $('#pickCancel').onclick = () => { closeModal(); resolve(null); };
  });
}

/* -------------------------------------------------- groups */
$('#newGroupBtn').addEventListener('click', async () => {
  const members = await searchUsersInteractive('New group — pick members');
  if (!members) return;
  openModal(`<h3>Create group</h3>
    <label>Group name<input id="grpName" placeholder="e.g. Weekend Plans"></label>
    <label><input type="checkbox" id="grpTemp" style="width:auto"> Temporary group — auto-archive after
      <select id="grpHours" style="width:auto"><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option></select></label>
    <p class="small muted">${members.length} member(s) selected. You will be the admin.</p>
    <button class="btn primary wide" id="doGroup">Create group</button>
    <button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#doGroup').onclick = async () => {
    try {
      const { conversation } = await api('POST', '/api/conversations/groups', {
        title: $('#grpName').value, memberIds: members.map(u => u.id),
        temporaryHours: $('#grpTemp').checked ? Number($('#grpHours').value) : undefined,
      });
      closeModal(); toast('Group created');
      refreshConversations(); openConversation(conversation.id);
    } catch (e) { toast(e.message); }
  };
});
$('#starredBtn').addEventListener('click', async () => {
  switchView('chats');
  try {
    const { messages } = await api('GET', '/api/starred');
    showContent('⭐ Starred messages', messages.length
      ? messages.map(m => `<div class="channel-row" data-open-conv="${m.conversationId}"><span><b>${esc(m.senderName)}</b>: ${esc(m.body.slice(0, 90))}</span><span class="small muted">${fmtTime(m.createdAt)}</span></div>`).join('')
      : '<p class="muted">No starred messages yet. Star a message from its ▾ menu.</p>');
    $$('#contentBody [data-open-conv]').forEach(el => el.onclick = () => openConversation(Number(el.dataset.openConv)));
  } catch (e) { toast(e.message); }
});
function showContent(title, html) {
  $('#contentTitle').textContent = title;
  $('#contentBody').innerHTML = html;
  showMain('content');
}

/* -------------------------------------------------- communities */
async function loadCommunities() {
  try {
    const { communities } = await api('GET', '/api/communities');
    state.communities = communities;
    $('#communityList').innerHTML = communities.length ? communities.map(c =>
      `<div class="conv-item" data-community="${c.id}">
        <div class="avatar">🏠</div>
        <div class="meta"><div class="name">${esc(c.name)}</div>
        <div class="preview">${c.memberCount} member(s) · ${c.channels.length} channel(s)${c.myRole ? ' · joined' : ''}</div></div>
      </div>`).join('') : '<p class="pad muted">No communities yet — create the first one with ＋</p>';
    $$('#communityList [data-community]').forEach(el => el.onclick = () => openCommunity(Number(el.dataset.community)));
  } catch (e) { toast(e.message); }
}
async function openCommunity(id) {
  try {
    const { community } = await api('GET', `/api/communities/${id}`);
    state.activeCommunity = community;
    showMain('community');
    $('#communityName').textContent = community.name;
    $('#communityMeta').textContent = `${community.memberCount} member(s) · your role: ${community.myRole || 'not a member'}`;
    $('#communityDesc').textContent = community.description || '';
    $('#joinCommunityBtn').textContent = community.myRole ? 'Joined ✓' : 'Join community';
    $('#joinCommunityBtn').disabled = Boolean(community.myRole);
    $('#channelList').innerHTML = community.channels.map(ch =>
      `<div class="channel-row" data-channel="${ch.id}">
        <span># ${esc(ch.title)} ${ch.broadcast ? '· 📢 broadcast (admins post)' : ''}</span>
        <span class="small muted">${ch.joined ? 'Open →' : 'Join community first'}</span>
      </div>`).join('') || '<p class="muted">No channels yet.</p>';
    $$('#channelList [data-channel]').forEach(el => el.onclick = () => {
      const ch = community.channels.find(x => x.id === Number(el.dataset.channel));
      if (ch.joined) openConversation(ch.id); else toast('Join the community to open its channels.');
    });
    $('#newChannelBtn').classList.toggle('hidden', community.myRole !== 'admin');
    $('#memberList').innerHTML = community.members.map(m =>
      `<div class="member-row"><span>${esc(m.name)} ${m.role === 'admin' ? '· 👑 admin' : ''}</span>
       ${community.myRole === 'admin' && m.id !== state.me.id
         ? `<button class="btn" data-role-toggle="${m.id}:${m.role}">${m.role === 'admin' ? 'Make member' : 'Make admin'}</button>` : ''}</div>`).join('');
    $$('#memberList [data-role-toggle]').forEach(b => b.onclick = async () => {
      const [uid, role] = b.dataset.roleToggle.split(':');
      try {
        await api('POST', `/api/communities/${id}/members/${uid}/role`, { role: role === 'admin' ? 'member' : 'admin' });
        openCommunity(id);
      } catch (e) { toast(e.message); }
    });
  } catch (e) { toast(e.message); }
}
$('#joinCommunityBtn').addEventListener('click', async () => {
  if (!state.activeCommunity) return;
  try {
    await api('POST', `/api/communities/${state.activeCommunity.id}/join`);
    toast('Welcome to the community!');
    openCommunity(state.activeCommunity.id); loadCommunities(); refreshConversations();
  } catch (e) { toast(e.message); }
});
$('#newCommunityBtn').addEventListener('click', () => {
  openModal(`<h3>Create community</h3>
    <label>Name<input id="comName" placeholder="e.g. Photography Club"></label>
    <label>Description<input id="comDesc" placeholder="What is this community about?"></label>
    <p class="small muted">A #general channel is created automatically. As admin you can add more channels, including broadcast channels where only admins post.</p>
    <button class="btn primary wide" id="doCommunity">Create</button>
    <button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#doCommunity').onclick = async () => {
    try {
      const { community } = await api('POST', '/api/communities', { name: $('#comName').value, description: $('#comDesc').value });
      closeModal(); toast('Community created'); loadCommunities(); openCommunity(community.id);
    } catch (e) { toast(e.message); }
  };
});
$('#newChannelBtn').addEventListener('click', () => {
  const c = state.activeCommunity; if (!c) return;
  openModal(`<h3>New channel in ${esc(c.name)}</h3>
    <label>Channel name<input id="chName" placeholder="e.g. announcements"></label>
    <label><input type="checkbox" id="chBroadcast" style="width:auto"> Broadcast channel — only admins can post</label>
    <button class="btn primary wide" id="doChannel">Create channel</button>
    <button class="btn wide ghost" onclick="closeModal()">Cancel</button>`);
  window.closeModal = closeModal;
  $('#doChannel').onclick = async () => {
    try {
      await api('POST', `/api/communities/${c.id}/channels`, { name: $('#chName').value, broadcast: $('#chBroadcast').checked });
      closeModal(); toast('Channel created'); openCommunity(c.id); refreshConversations();
    } catch (e) { toast(e.message); }
  };
});

/* -------------------------------------------------- discover */
let userSearchTimer = null;
$('#userSearch').addEventListener('input', e => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(async () => {
    const q = e.target.value.trim();
    if (q.length < 2) { $('#userResults').innerHTML = ''; return; }
    try {
      const { users } = await api('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
      $('#userResults').innerHTML = users.map(u =>
        `<div class="conv-item">${avatarHtml(u)}
          <div class="meta"><div class="name">${esc(u.name)}</div><div class="preview">${esc(u.bio || '')} ${u.online ? '· online' : ''}</div></div>
          <button class="btn" data-msg-user="${u.id}">Message</button>
          <button class="btn danger" data-block-user="${u.id}">Block</button>
        </div>`).join('') || '<p class="pad muted">No users found.</p>';
      $$('#userResults [data-msg-user]').forEach(b => b.onclick = async () => {
        try {
          const { conversation } = await api('POST', '/api/conversations/dm', { userId: Number(b.dataset.msgUser) });
          switchView('chats'); openConversation(conversation.id);
        } catch (err) { toast(err.message); }
      });
      $$('#userResults [data-block-user]').forEach(b => b.onclick = async () => {
        try { await api('POST', `/api/users/${b.dataset.blockUser}/block`); toast('User blocked'); loadBlocks(); }
        catch (err) { toast(err.message); }
      });
    } catch (err) { toast(err.message); }
  }, 300);
});
async function loadBlocks() {
  try {
    const { users } = await api('GET', '/api/users/me/blocks');
    $('#blockList').innerHTML = users.map(u =>
      `<div class="conv-item">${avatarHtml(u)}<div class="meta"><div class="name">${esc(u.name)}</div></div>
       <button class="btn" data-unblock="${u.id}">Unblock</button></div>`).join('') || '<p class="pad muted small">Nobody blocked.</p>';
    $$('#blockList [data-unblock]').forEach(b => b.onclick = async () => {
      await api('DELETE', `/api/users/${b.dataset.unblock}/block`); toast('Unblocked'); loadBlocks();
    });
  } catch {}
}

/* -------------------------------------------------- assistant */
function pushAssistant(text, mine) {
  const area = $('#assistantMsgs');
  area.insertAdjacentHTML('beforeend', `<div class="msg ${mine ? 'out' : 'in'}"><span>${esc(text)}</span></div>`);
  area.scrollTop = area.scrollHeight;
}
async function askAssistant() {
  const input = $('#assistantInput');
  const text = input.value.trim(); if (!text) return;
  pushAssistant(text, true); input.value = '';
  try {
    const { reply, source } = await api('POST', '/api/ai/chat', { message: text });
    pushAssistant(reply + (source === 'external-provider' ? '\n(answered by the configured AI provider)' : ''), false);
  } catch (e) { pushAssistant('Sorry — ' + e.message, false); }
}
$('#assistantSend').addEventListener('click', askAssistant);
$('#assistantInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAssistant(); } });

/* -------------------------------------------------- notifications */
async function refreshNotifications() {
  try {
    const { notifications, unread } = await api('GET', '/api/notifications');
    const badge = $('#notifBadge');
    badge.textContent = unread; badge.classList.toggle('hidden', !unread);
    $('#notifList').innerHTML = notifications.map(n =>
      `<div class="conv-item" data-notif="${n.conversationId || ''}">
        <div class="avatar">🔔</div>
        <div class="meta"><div class="preview" style="${n.read ? '' : 'font-weight:700;color:var(--text)'}">${esc(n.text)}</div>
        <div class="time">${fmtTime(n.createdAt)}</div></div></div>`).join('') || '<p class="pad muted">No notifications.</p>';
    $$('#notifList [data-notif]').forEach(el => el.onclick = () => {
      const cid = Number(el.dataset.notif);
      if (cid) { switchView('chats'); openConversation(cid); }
    });
  } catch {}
}
function bumpNotifBadge() {
  const badge = $('#notifBadge');
  const n = (parseInt(badge.textContent) || 0) + 1;
  badge.textContent = n; badge.classList.remove('hidden');
}
$('#notifReadAll').addEventListener('click', async () => {
  await api('POST', '/api/notifications/read-all'); refreshNotifications();
});

/* -------------------------------------------------- calls (WebRTC, 1:1) */
const rtc = { pc: null, localStream: null, call: null, timer: null, iceQueue: [] };
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function loadCalls() {
  try {
    const { calls } = await api('GET', '/api/calls');
    $('#callList').innerHTML = calls.map(c => {
      const other = c.direction === 'outgoing' ? c.calleeName : c.callerName;
      const icon = c.kind === 'video' ? '🎥' : '📞';
      const arrow = c.direction === 'outgoing' ? '↗' : '↙';
      const dur = c.answeredAt && c.endedAt ? ` · ${Math.max(1, Math.round((c.endedAt - c.answeredAt) / 1000))}s` : '';
      return `<div class="conv-item"><div class="avatar">${icon}</div>
        <div class="meta"><div class="name">${esc(other)}</div>
        <div class="preview">${arrow} ${c.status}${dur}</div></div>
        <div class="side"><div class="time">${fmtTime(c.startedAt)}</div></div></div>`;
    }).join('') || '<p class="pad muted">No calls yet. Open a 1:1 chat and tap 📞 or 🎥.</p>';
  } catch {}
}
function showCallOverlay(name, stateText) {
  $('#callOverlay').classList.remove('hidden');
  $('#callName').textContent = name;
  $('#callState').textContent = stateText;
}
function hideCallOverlay() {
  $('#callOverlay').classList.add('hidden');
  clearInterval(rtc.timer);
  if (rtc.pc) { try { rtc.pc.close(); } catch {} rtc.pc = null; }
  if (rtc.localStream) { rtc.localStream.getTracks().forEach(t => t.stop()); rtc.localStream = null; }
  $('#remoteVideo').srcObject = null; $('#localVideo').srcObject = null;
  rtc.call = null; rtc.iceQueue = [];
}
async function setupPeer(isCaller, kind) {
  rtc.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
  $('#localVideo').srcObject = rtc.localStream;
  $('#localVideo').style.display = kind === 'video' ? '' : 'none';
  const pc = new RTCPeerConnection(RTC_CONFIG);
  rtc.pc = pc;
  rtc.localStream.getTracks().forEach(t => pc.addTrack(t, rtc.localStream));
  pc.onicecandidate = e => {
    if (e.candidate && rtc.call) wsSend({ type: 'signal', conversationId: rtc.call.conversationId, callId: rtc.call.id, payload: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = e => { $('#remoteVideo').srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    $('#callQuality').textContent = `Connection quality: basic indicator — peer connection state: ${pc.connectionState}`;
    if (pc.connectionState === 'connected') {
      let secs = 0;
      $('#callState').textContent = 'Connected · 0:00';
      clearInterval(rtc.timer);
      rtc.timer = setInterval(() => { secs++; $('#callState').textContent = `Connected · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`; }, 1000);
    }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && rtc.call) {
      $('#callState').textContent = 'Connection ' + pc.connectionState;
    }
  };
  return pc;
}
async function startCall(kind) {
  const c = state.activeConv;
  if (!c) return;
  if (c.kind !== 'dm') return toast('Group calls are not available in this version — 1-to-1 calls work.');
  if (!navigator.mediaDevices || !window.RTCPeerConnection) return toast('Calls are not supported in this browser.');
  try {
    const { call, conversationId } = await api('POST', '/api/calls', { calleeId: c.otherUser.id, kind });
    rtc.call = { id: call.id, conversationId, peerId: c.otherUser.id, kind, isCaller: true };
    await setupPeer(true, kind);
    showCallOverlay(c.otherUser.name, `Calling (${kind})…`);
    wsSend({ type: 'call-event', conversationId, callId: call.id, event: 'invite', kind });
  } catch (e) { toast('Could not start call: ' + e.message); hideCallOverlay(); }
}
$('#voiceCallBtn').addEventListener('click', () => startCall('voice'));
$('#videoCallBtn').addEventListener('click', () => startCall('video'));

async function handleCallSignal(msg) {
  const fromId = msg.fromUserId;
  if (msg.type === 'call-event') {
    if (msg.event === 'invite') {
      rtc.call = { id: msg.callId, conversationId: msg.conversationId, peerId: fromId, kind: msg.kind || 'voice', isCaller: false };
      $('#incomingText').textContent = `${nameOfUser(fromId)} is calling (${rtc.call.kind})…`;
      $('#incomingAvatar').textContent = initials(nameOfUser(fromId));
      $('#incomingCall').classList.remove('hidden');
    }
    if (msg.event === 'accept' && rtc.call && rtc.call.isCaller) {
      try {
        const offer = await rtc.pc.createOffer();
        await rtc.pc.setLocalDescription(offer);
        wsSend({ type: 'signal', conversationId: rtc.call.conversationId, callId: rtc.call.id, payload: { kind: 'offer', sdp: offer } });
        $('#callState').textContent = 'Connecting…';
        // flush queued ICE
        for (const cand of rtc.iceQueue) wsSend({ type: 'signal', conversationId: rtc.call.conversationId, callId: rtc.call.id, payload: { kind: 'ice', candidate: cand } });
        rtc.iceQueue = [];
      } catch (e) { toast('Call setup failed: ' + e.message); }
    }
    if ((msg.event === 'decline' || msg.event === 'end') && rtc.call) {
      toast(msg.event === 'decline' ? 'Call declined' : 'Call ended');
      hideCallOverlay(); $('#incomingCall').classList.add('hidden');
      loadCalls();
    }
    return;
  }
  // msg.type === 'signal'
  const p = msg.payload; if (!p || !rtc.call) return;
  try {
    if (p.kind === 'offer') {
      await rtc.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      const answer = await rtc.pc.createAnswer();
      await rtc.pc.setLocalDescription(answer);
      wsSend({ type: 'signal', conversationId: rtc.call.conversationId, callId: rtc.call.id, payload: { kind: 'answer', sdp: answer } });
    } else if (p.kind === 'answer') {
      await rtc.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
    } else if (p.kind === 'ice' && p.candidate) {
      if (rtc.pc && rtc.pc.remoteDescription) await rtc.pc.addIceCandidate(new RTCIceCandidate(p.candidate));
      else rtc.iceQueue.push(p.candidate);
    }
  } catch (e) { console.warn('signal error', e); }
}
$('#acceptCallBtn').addEventListener('click', async () => {
  if (!rtc.call) return;
  $('#incomingCall').classList.add('hidden');
  try {
    await api('POST', `/api/calls/${rtc.call.id}/respond`, { accept: true });
    await setupPeer(false, rtc.call.kind);
    showCallOverlay(nameOfUser(rtc.call.peerId), 'Connecting…');
    wsSend({ type: 'call-event', conversationId: rtc.call.conversationId, callId: rtc.call.id, event: 'accept' });
  } catch (e) { toast('Could not answer: ' + e.message); hideCallOverlay(); }
});
$('#declineCallBtn').addEventListener('click', async () => {
  if (!rtc.call) return;
  $('#incomingCall').classList.add('hidden');
  try { await api('POST', `/api/calls/${rtc.call.id}/respond`, { accept: false }); } catch {}
  wsSend({ type: 'call-event', conversationId: rtc.call.conversationId, callId: rtc.call.id, event: 'decline' });
  rtc.call = null; loadCalls();
});
$('#endCallBtn').addEventListener('click', async () => {
  if (!rtc.call) return hideCallOverlay();
  const { id, conversationId } = rtc.call;
  wsSend({ type: 'call-event', conversationId, callId: id, event: 'end' });
  try { await api('POST', `/api/calls/${id}/end`); } catch {}
  hideCallOverlay(); loadCalls();
});
$('#muteMicBtn').addEventListener('click', e => {
  if (!rtc.localStream) return;
  const t = rtc.localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled);
  e.currentTarget.textContent = t.enabled ? '🎤' : '🔇';
});
$('#muteCamBtn').addEventListener('click', e => {
  if (!rtc.localStream) return;
  const t = rtc.localStream.getVideoTracks()[0];
  if (!t) return toast('No camera in this call.');
  t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled);
  e.currentTarget.textContent = t.enabled ? '🎥' : '🚫';
});
$('#speakerBtn').addEventListener('click', async e => {
  const v = $('#remoteVideo');
  if (typeof v.setSinkId !== 'function') return toast('Speaker switching is not supported in this browser.');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    if (outputs.length < 2) return toast('No alternate speaker found on this device.');
    const current = v.sinkId || '';
    const next = outputs.find(d => d.deviceId !== current) || outputs[0];
    await v.setSinkId(next.deviceId);
    toast('Speaker: ' + (next.label || 'device'));
    e.currentTarget.classList.toggle('off');
  } catch { toast('Could not switch speaker.'); }
});
$('#shareScreenBtn').addEventListener('click', async () => {
  if (!rtc.pc) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('Screen sharing is not supported on this device/browser.');
  }
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = screen.getVideoTracks()[0];
    const sender = rtc.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(track);
    else rtc.pc.addTrack(track, screen);
    $('#localVideo').srcObject = screen;
    track.onended = () => toast('Screen sharing stopped.');
    toast('You are sharing your screen');
  } catch { toast('Screen sharing was cancelled or denied.'); }
});

/* -------------------------------------------------- settings */
async function loadSettings() {
  try {
    const [{ user }, { settings }] = await Promise.all([api('GET', '/api/users/me'), api('GET', '/api/settings')]);
    state.me = user; state.settings = settings;
    $('#profileName').textContent = user.name;
    $('#profileIdentifier').textContent = user.identifier || '';
    $('#editName').value = user.name; $('#editBio').value = user.bio || '';
    const av = $('#profileAvatar');
    if (user.avatarUrl) { av.style.backgroundImage = `url('${user.avatarUrl}')`; av.textContent = ''; av.style.color = 'transparent'; }
    else { av.style.backgroundImage = ''; av.style.color = ''; av.textContent = initials(user.name); }
    const rail = $('#railAvatar');
    if (user.avatarUrl) { rail.style.backgroundImage = `url('${user.avatarUrl}')`; rail.textContent = ''; }
    else { rail.style.backgroundImage = ''; rail.textContent = initials(user.name); }
    $('#themeSelect').value = settings.theme || 'dark';
    $('#lowDataToggle').checked = Boolean(settings.low_data);
    $('#photoVis').value = settings.photo_visibility || 'everyone';
    $('#lastSeenVis').value = settings.last_seen_visibility || 'everyone';
    loadBlocks();
  } catch (e) { toast(e.message); }
}
$('#saveProfileBtn').addEventListener('click', async () => {
  try {
    const { user } = await api('PATCH', '/api/users/me', { name: $('#editName').value, bio: $('#editBio').value });
    state.me = user; $('#settingsMsg').textContent = 'Profile saved.'; loadSettings();
  } catch (e) { $('#settingsMsg').textContent = e.message; }
});
$('#avatarInput').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('avatar', file);
  try {
    const res = await fetch('/api/users/me/avatar', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast('Profile photo updated'); loadSettings();
  } catch (err) { toast(err.message); }
});
async function pushSettings() {
  state.settings = (await api('PUT', '/api/settings', {
    theme: $('#themeSelect').value, low_data: $('#lowDataToggle').checked,
    photo_visibility: $('#photoVis').value, last_seen_visibility: $('#lastSeenVis').value,
  })).settings;
  applyTheme(state.settings.theme);
}
$('#themeSelect').addEventListener('change', pushSettings);
$('#lowDataToggle').addEventListener('change', pushSettings);
$('#photoVis').addEventListener('change', pushSettings);
$('#lastSeenVis').addEventListener('change', pushSettings);
$('#sessionsBtn').addEventListener('click', async () => {
  try {
    const { sessions } = await api('GET', '/api/auth/sessions');
    $('#sessionList').innerHTML = sessions.map(s =>
      `<div class="session-row"><span>🖥️ ${esc(s.deviceLabel.slice(0, 42))}<br><span class="muted">Last used ${new Date(s.lastUsedAt).toLocaleString()} ${s.current ? '· this device' : ''}</span></span>
       ${s.current ? '' : `<button class="btn danger" data-revoke="${s.id}">Revoke</button>`}</div>`).join('');
    $$('#sessionList [data-revoke]').forEach(b => b.onclick = async () => {
      await api('DELETE', `/api/auth/sessions/${b.dataset.revoke}`); toast('Session revoked'); $('#sessionsBtn').click();
    });
  } catch (e) { toast(e.message); }
});
$('#changePassBtn').addEventListener('click', async () => {
  const msg = $('#settingsMsg'); msg.classList.remove('error');
  try {
    await api('POST', '/api/auth/change-password', { currentPassword: $('#curPass').value, newPassword: $('#newPass').value });
    msg.textContent = 'Password changed.'; $('#curPass').value = ''; $('#newPass').value = '';
  } catch (e) { msg.textContent = e.message; msg.classList.add('error'); }
});
$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/users/me/export', { headers: { Authorization: `Bearer ${state.token}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'connectx-data-export.json'; a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast(e.message); }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch {}
  state.token = null; state.me = null; localStorage.removeItem('cx_token');
  if (state.ws) try { state.ws.close(); } catch {}
  location.reload();
});
$('#deleteAccountBtn').addEventListener('click', async () => {
  if (!confirm('Delete your account permanently? Your profile, messages you sent, and sessions will be removed. This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/users/me');
    localStorage.removeItem('cx_token'); location.reload();
  } catch (e) { toast(e.message); }
});

/* -------------------------------------------------- legal & help */
const LEGAL = {
  terms: { title: 'Terms of Service', body: `
    <h3>ConnectX AI — Terms of Service</h3>
    <p>By creating an account you agree to these terms.</p>
    <h4>1. The service</h4><p>ConnectX AI provides real-time messaging, groups, communities, 1-to-1 calls and related tools. Core messaging is free. Features may change or be withdrawn with reasonable notice.</p>
    <h4>2. Your account</h4><p>You are responsible for your password and activity on your account. You must provide accurate sign-up information and be old enough to use messaging services in your country.</p>
    <h4>3. Acceptable use</h4><p>Do not send spam, harass or impersonate others, share illegal content, or attempt to break the security of the service. Accounts may be suspended for abuse. Blocking and reporting tools are provided in the app.</p>
    <h4>4. Your content</h4><p>You keep ownership of the messages and files you send. You grant us only the permission needed to deliver and store them so the service works.</p>
    <h4>5. No advertising on private content</h4><p>We do not sell private message content and do not use private conversations for targeted advertising.</p>
    <h4>6. Liability</h4><p>The service is provided "as is". Messaging depends on networks and devices outside our control; we are not liable for indirect losses arising from use of the service.</p>` },
  privacy: { title: 'Privacy Policy', body: `
    <h3>ConnectX AI — Privacy Policy</h3>
    <h4>What we store</h4><p>Your account details (name, email or phone number, hashed password), your profile, the conversations you take part in, messages and files you send, your settings, and your signed-in sessions. We collect the minimum needed to run a messaging service.</p>
    <h4>Encryption — the honest version</h4><p>Traffic is protected in transit when the site is served over HTTPS/WSS. <b>End-to-end encryption is NOT implemented in this version</b>: messages are stored on the server so they can sync across your devices, and the server can technically access them. Do not use this version for highly sensitive communications.</p>
    <h4>AI features</h4><p>The built-in assistant runs locally. It never receives your private conversations automatically. Chat summaries are generated on the server only when you press the Summarize button in that conversation. If an external AI provider is configured by the operator, only the dedicated assistant chat is sent to it — never your user-to-user chats.</p>
    <h4>Your controls</h4><p>You can hide your profile photo and last-seen status, block and report users, revoke any signed-in device, export all of your data as JSON, and delete your account at any time from Settings.</p>
    <h4>Retention & deletion</h4><p>Deleting your account removes your profile, your sessions, and the messages you sent. Disappearing messages are deleted automatically when their timer expires. Scheduled messages are stored until delivered or cancelled.</p>
    <h4>Sharing</h4><p>We do not sell personal data. Data is shared only as needed to operate the service or where the law requires it.</p>` },
};
const HELP_BODY = `
  <h3>Help & Support</h3>
  <h4>How do I start a chat?</h4><p>Use Discover (🔍) to find people by name, email or phone, then tap Message.</p>
  <h4>How do group admin controls work?</h4><p>The group creator is the admin. Only admins can rename a group, change its disappearing-message timer, add or remove members, and create invite links.</p>
  <h4>What is Focus Mode?</h4><p>In chat settings (⋮), set "Mute / Focus Mode until" a time of your choice — you will not get pop-up alerts from that chat until then, and a 🔕 icon shows in your list.</p>
  <h4>Calls</h4><p>Voice and video calls work 1-to-1 using WebRTC. Group calls are not available in this version. Screen sharing works on browsers that support it (mainly desktop Chrome/Edge).</p>
  <h4>Is ConnectX end-to-end encrypted?</h4><p>No — not in this version. See the Privacy Policy for the honest details.</p>
  <h4>Backups</h4><p>Your chats live on the server, so signing in on a new device restores them automatically. You can also export your data as JSON from Settings.</p>
  <h4>Still stuck?</h4><p>Ask the built-in AI Assistant (🤖) how any feature works.</p>`;
$$('[data-legal]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  const doc = LEGAL[a.dataset.legal];
  if (state.token) { showContent(doc.title, doc.body); switchSettingsInterlude(); }
  else {
    openModal(doc.body + '<button class="btn wide" onclick="closeModal()">Close</button>');
    window.closeModal = closeModal;
  }
}));
function switchSettingsInterlude() { document.body.classList.add('in-chat'); }
$('#helpBtn') && $('#helpBtn').addEventListener('click', () => showContent('Help & Support', HELP_BODY));

/* -------------------------------------------------- boot */
async function enterApp() {
  $('#landingView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  try {
    const { user } = await api('GET', '/api/users/me');
    state.me = user;
  } catch { /* token may be stale; guarded below */ }
  if (!state.me) { localStorage.removeItem('cx_token'); location.reload(); return; }
  const { settings } = await api('GET', '/api/settings').catch(() => ({ settings: {} }));
  state.settings = settings;
  applyTheme(settings.theme || 'dark');
  const rail = $('#railAvatar');
  rail.textContent = initials(state.me.name);
  connectWs();
  refreshConversations();
  refreshNotifications();
  loadBlocks();
  // Invite link handling: /#/join/<token>
  const m = location.hash.match(/#\/join\/([a-zA-Z0-9]+)/);
  if (m) {
    try {
      const { conversation } = await api('POST', `/api/join/${m[1]}`);
      toast('You joined: ' + (conversation.title || 'chat'));
      history.replaceState(null, '', location.pathname);
      openConversation(conversation.id);
    } catch (e) { toast(e.message); }
  }
}
(async function boot() {
  applyTheme(localStorage.getItem('cx_theme') || 'dark');
  if (state.token) {
    try { await enterApp(); return; } catch { localStorage.removeItem('cx_token'); }
  }
})();
$('#themeSelect') && $('#themeSelect').addEventListener('change', e => localStorage.setItem('cx_theme', e.target.value));
