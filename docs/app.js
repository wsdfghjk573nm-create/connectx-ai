/* ConnectX AI showcase page.
   The "Add Real Chat" button opens the ConnectX AI chat interface on this
   page (chat list + conversation + message box). The chats shown are
   samples and everything typed stays in the browser — this static page has
   no server. Real chatting between real accounts runs in the full app. */
(function () {
  "use strict";

  /* ---------- Theme toggle ---------- */
  var themeBtn = document.getElementById("themeToggle");
  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function paintThemeBtn() {
    if (themeBtn) themeBtn.textContent = currentTheme() === "dark" ? "☀️ Light" : "🌙 Dark";
  }
  if (themeBtn) {
    paintThemeBtn();
    themeBtn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      paintThemeBtn();
    });
  }

  /* ---------- Open the chat interface ---------- */
  var chatBox = document.getElementById("chatInterface");
  var shell = document.getElementById("waShell");
  var input = document.getElementById("waInput");
  function openChat() {
    if (chatBox) chatBox.hidden = false;
    var target = document.getElementById("real-chat");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(function () { if (input) input.focus({ preventScroll: true }); }, 450);
  }
  var openers = document.querySelectorAll("[data-open-chat]");
  openers.forEach(function (el) {
    el.addEventListener("click", function () { openChat(); });
  });

  /* ---------- Sample chats (labelled SAMPLE in the UI) ---------- */
  function nowTime() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  var conversations = [
    {
      id: "priya", name: "Priya Sharma", initial: "P", status: "online", unread: 2,
      messages: [
        { from: "them", sender: "Priya Sharma", text: "Hi! Welcome to ConnectX AI 👋", time: "9:41 AM" },
        { from: "them", sender: "Priya Sharma", text: "This is how a chat looks in the app — groups, polls and calls are all in the full version.", time: "9:42 AM" },
        { from: "me", text: "Nice, it feels just like my usual messaging app.", time: "9:44 AM", status: "read" }
      ],
      replies: [
        "Exactly — and in the full app this chat would be saved on the server, on all your devices.",
        "You can also make groups, send photos and files up to 25 MB, and do 1:1 voice and video calls."
      ]
    },
    {
      id: "family", name: "Family Group", initial: "F", status: "4 members", unread: 0,
      messages: [
        { from: "them", sender: "Mum", text: "Sunday lunch at our place this week? 🍲", time: "8:15 AM" },
        { from: "them", sender: "Aarav", text: "Yes! I will bring dessert.", time: "8:17 AM" },
        { from: "me", text: "Count me in. I can reach by 12:30.", time: "8:20 AM", status: "read" }
      ],
      replies: [
        "Lovely — see everyone on Sunday!",
        "In the full app, a group poll here would settle the menu in one tap."
      ]
    },
    {
      id: "work", name: "Work Team", initial: "W", status: "6 members", unread: 1,
      messages: [
        { from: "them", sender: "Neha", text: "Stand-up notes are in the channel. Launch checklist is on track ✅", time: "10:02 AM" },
        { from: "me", text: "Great — I will review the checklist after lunch.", time: "10:05 AM", status: "read" },
        { from: "them", sender: "Rohan", text: "Reminder: call at 4 PM today.", time: "10:06 AM" }
      ],
      replies: [
        "Noted! In the full app you could also schedule this message for later.",
        "Copy that."
      ]
    },
    {
      id: "aarav", name: "Aarav", initial: "A", status: "last seen recently", unread: 0,
      messages: [
        { from: "them", sender: "Aarav", text: "That voice note feature is neat — hold, record, send.", time: "Yesterday" },
        { from: "me", text: "And files up to 25 MB in the full app.", time: "Yesterday", status: "read" }
      ],
      replies: [
        "True! In the full app we could also do a 1:1 voice or video call from here.",
        "Group calls are not in this version though — the app says that honestly."
      ]
    }
  ];

  var replyIndex = {};
  var activeId = conversations[0].id;

  var listEl = document.getElementById("waChatList");
  var searchEl = document.getElementById("waSearch");
  var paneAvatar = document.getElementById("waPaneAvatar");
  var paneName = document.getElementById("waPaneName");
  var paneStatus = document.getElementById("waPaneStatus");
  var msgEl = document.getElementById("waMessages");
  var typingRow = document.getElementById("waTyping");
  var typingText = document.getElementById("waTypingText");
  var form = document.getElementById("waComposer");
  var backBtn = document.getElementById("waBack");

  function getConv(id) {
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) return conversations[i];
    }
    return conversations[0];
  }
  function lastMsg(conv) { return conv.messages[conv.messages.length - 1]; }

  function renderList() {
    var q = (searchEl && searchEl.value || "").trim().toLowerCase();
    listEl.innerHTML = "";
    conversations.forEach(function (conv) {
      if (q && conv.name.toLowerCase().indexOf(q) < 0) return;
      var last = lastMsg(conv);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wa-item" + (conv.id === activeId ? " active" : "");
      btn.innerHTML =
        '<span class="wa-avatar" aria-hidden="true"></span>' +
        '<span class="wa-item-text">' +
          '<span class="wa-item-top"><span class="wa-item-name"></span><span class="wa-item-time"></span></span>' +
          '<span class="wa-item-preview"></span>' +
        "</span>" +
        (conv.unread > 0 ? '<span class="wa-unread"></span>' : "");
      btn.querySelector(".wa-avatar").textContent = conv.initial;
      btn.querySelector(".wa-item-name").textContent = conv.name;
      btn.querySelector(".wa-item-time").textContent = last ? last.time : "";
      btn.querySelector(".wa-item-preview").textContent = last ? (last.from === "me" ? "You: " : "") + last.text : "";
      var badge = btn.querySelector(".wa-unread");
      if (badge) badge.textContent = String(conv.unread);
      btn.addEventListener("click", function () { openConversation(conv.id); });
      listEl.appendChild(btn);
    });
  }

  function renderMessages() {
    var conv = getConv(activeId);
    msgEl.innerHTML = "";
    var divider = document.createElement("div");
    divider.className = "wa-divider";
    divider.textContent = "Today";
    msgEl.appendChild(divider);
    conv.messages.forEach(function (msg) {
      var row = document.createElement("div");
      row.className = "wa-row" + (msg.from === "me" ? " me" : "");
      var bubble = document.createElement("div");
      bubble.className = "wa-bubble";
      if (msg.from !== "me" && msg.sender && conv.status.indexOf("member") >= 0) {
        var s = document.createElement("div");
        s.className = "wa-sender";
        s.textContent = msg.sender;
        bubble.appendChild(s);
      }
      var p = document.createElement("p");
      p.textContent = msg.text;
      bubble.appendChild(p);
      var meta = document.createElement("div");
      meta.className = "wa-meta";
      var ticks = msg.from === "me"
        ? '<span class="wa-ticks' + (msg.status === "read" ? " read" : "") + '">' + (msg.status === "sent" ? "✓" : "✓✓") + "</span>"
        : "";
      meta.innerHTML = "<span></span>" + ticks;
      meta.querySelector("span").textContent = msg.time;
      bubble.appendChild(meta);
      row.appendChild(bubble);
      msgEl.appendChild(row);
    });
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function openConversation(id) {
    activeId = id;
    var conv = getConv(id);
    conv.unread = 0;
    paneAvatar.textContent = conv.initial;
    paneName.textContent = conv.name;
    paneStatus.textContent = conv.status;
    renderList();
    renderMessages();
    if (shell) shell.classList.add("show-pane");
  }

  if (backBtn) {
    backBtn.addEventListener("click", function () {
      if (shell) shell.classList.remove("show-pane");
    });
  }
  if (searchEl) {
    searchEl.addEventListener("input", renderList);
  }

  /* ---------- Sending + sample replies (on this page only) ---------- */
  function later(fn, ms) { setTimeout(fn, ms); }
  if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      var conv = getConv(activeId);
      var msg = { from: "me", text: text, time: nowTime(), status: "sent" };
      conv.messages.push(msg);
      input.value = "";
      renderList();
      renderMessages();
      later(function () { msg.status = "delivered"; renderMessages(); }, 450);
      later(function () { msg.status = "read"; renderMessages(); }, 1100);
      later(function () {
        typingText.textContent = conv.name + " is typing…";
        typingRow.hidden = false;
        msgEl.scrollTop = msgEl.scrollHeight;
      }, 1300);
      later(function () {
        typingRow.hidden = true;
        var pool = conv.replies && conv.replies.length ? conv.replies : ["Thanks!"];
        var i = replyIndex[conv.id] || 0;
        replyIndex[conv.id] = i + 1;
        conv.messages.push({ from: "them", sender: conv.name, text: pool[i % pool.length], time: nowTime() });
        renderList();
        renderMessages();
      }, 2600);
    });
  }

  /* ---------- Init ---------- */
  renderList();
  openConversation(activeId);
  if (shell) shell.classList.remove("show-pane");
})();
