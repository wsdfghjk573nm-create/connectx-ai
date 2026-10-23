/* ConnectX AI static showcase demo.
   Everything on this page runs locally in the browser.
   There is no server behind this demo and nothing is sent anywhere. */
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
    themeBtn.textContent = currentTheme() === "dark" ? "☀️ Light" : "🌙 Dark";
  }
  if (themeBtn) {
    paintThemeBtn();
    themeBtn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      paintThemeBtn();
    });
  }

  /* ---------- Sample data (labelled SAMPLE in the UI) ---------- */
  function nowTime() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  var conversations = [
    {
      id: "priya",
      name: "Priya Sharma",
      initial: "P",
      status: "online",
      kind: "1:1 chat · SAMPLE",
      unread: 2,
      messages: [
        { from: "them", sender: "Priya Sharma", text: "Hi! Did you try the new ConnectX demo page?", time: "9:41 AM", reactions: [] },
        { from: "them", sender: "Priya Sharma", text: "The group poll feature in the full app is really handy for planning.", time: "9:42 AM", reactions: ["👍"] },
        { from: "me", text: "Yes — this demo is just a preview though. The real chat runs in the full server app.", time: "9:44 AM", status: "read", reactions: [] }
      ],
      replies: [
        "Nice — in the full app this reply would arrive instantly from the other person.",
        "Exactly. And our whole history would be saved on the server, on every device.",
        "Try clicking a message — you can add a reaction, just like in the real app."
      ]
    },
    {
      id: "family",
      name: "Family Group",
      initial: "F",
      status: "4 members · SAMPLE",
      kind: "Group · SAMPLE",
      unread: 0,
      messages: [
        { from: "them", sender: "Mum", text: "Sunday lunch at our place this week? 🍲", time: "8:15 AM", reactions: ["❤️"] },
        { from: "them", sender: "Aarav", text: "Yes! I will bring dessert.", time: "8:17 AM", reactions: [] },
        { from: "me", text: "Count me in. I can reach by 12:30.", time: "8:20 AM", status: "read", reactions: [] }
      ],
      replies: [
        "Lovely — see everyone on Sunday! (Demo reply, generated on this page.)",
        "In the full app, a poll here would settle the menu in one tap."
      ]
    },
    {
      id: "work",
      name: "Work Team",
      initial: "W",
      status: "6 members · SAMPLE",
      kind: "Group · SAMPLE",
      unread: 1,
      messages: [
        { from: "them", sender: "Neha", text: "Stand-up notes are in the channel. Launch checklist is on track ✅", time: "10:02 AM", reactions: [] },
        { from: "me", text: "Great — I will review the checklist after lunch.", time: "10:05 AM", status: "read", reactions: [] },
        { from: "them", sender: "Rohan", text: "Reminder: demo call at 4 PM today.", time: "10:06 AM", reactions: [] }
      ],
      replies: [
        "Noted! In the full app you could also schedule this message for later.",
        "Copy that. (This is a local demo reply — no server is involved.)"
      ]
    },
    {
      id: "aarav",
      name: "Aarav",
      initial: "A",
      status: "last seen recently · SAMPLE",
      kind: "1:1 chat · SAMPLE",
      unread: 0,
      messages: [
        { from: "them", sender: "Aarav", text: "That voice note feature is neat — hold, record, send.", time: "Yesterday", reactions: [] },
        { from: "me", text: "And files up to 25 MB in the full app. This demo keeps everything on the page.", time: "Yesterday", status: "read", reactions: ["👍"] }
      ],
      replies: [
        "True! In the full app we could also do a 1:1 voice or video call from here.",
        "Group calls are not in this version though — the full app says that honestly."
      ]
    }
  ];

  var replyIndex = {};
  var activeId = conversations[0].id;

  var shell = document.getElementById("chatShell");
  var listEl = document.getElementById("chatList");
  var paneAvatar = document.getElementById("paneAvatar");
  var paneName = document.getElementById("paneName");
  var paneStatus = document.getElementById("paneStatus");
  var msgEl = document.getElementById("messageList");
  var typingRow = document.getElementById("typingRow");
  var typingText = document.getElementById("typingText");
  var form = document.getElementById("composer");
  var input = document.getElementById("composerInput");
  var backBtn = document.getElementById("backToList");

  function getConv(id) {
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) return conversations[i];
    }
    return conversations[0];
  }

  function lastPreview(conv) {
    if (!conv.messages.length) return conv.kind;
    var m = conv.messages[conv.messages.length - 1];
    return (m.from === "me" ? "You: " : "") + m.text;
  }

  function renderList() {
    listEl.innerHTML = "";
    conversations.forEach(function (conv) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-item" + (conv.id === activeId ? " active" : "");
      var last = conv.messages[conv.messages.length - 1];
      btn.innerHTML =
        '<span class="avatar" aria-hidden="true"></span>' +
        '<span class="chat-item-text">' +
          '<span class="chat-item-top"><span class="chat-item-name"></span><span class="chat-item-time"></span></span>' +
          '<span class="chat-item-preview"></span>' +
        "</span>" +
        (conv.unread > 0 ? '<span class="unread-badge"></span>' : "");
      btn.querySelector(".avatar").textContent = conv.initial;
      btn.querySelector(".chat-item-name").textContent = conv.name;
      btn.querySelector(".chat-item-time").textContent = last ? last.time : "";
      btn.querySelector(".chat-item-preview").textContent = lastPreview(conv);
      var badge = btn.querySelector(".unread-badge");
      if (badge) badge.textContent = String(conv.unread);
      btn.addEventListener("click", function () { openConversation(conv.id); });
      listEl.appendChild(btn);
    });
  }

  var REACTION_CHOICES = ["❤️", "👍", "😂", "🎉"];

  function renderMessages() {
    var conv = getConv(activeId);
    msgEl.innerHTML = "";
    var divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = "Today · Demo conversation";
    msgEl.appendChild(divider);

    conv.messages.forEach(function (msg, idx) {
      var row = document.createElement("div");
      row.className = "msg-row" + (msg.from === "me" ? " me" : "");

      var bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.title = "Click to react";

      if (msg.from !== "me" && msg.sender) {
        var s = document.createElement("div");
        s.className = "sender";
        s.textContent = msg.sender;
        bubble.appendChild(s);
      }
      var p = document.createElement("p");
      p.textContent = msg.text;
      bubble.appendChild(p);

      var reactions = document.createElement("div");
      reactions.className = "reactions";
      function paintReactions() {
        reactions.innerHTML = "";
        msg.reactions.forEach(function (r) {
          var chip = document.createElement("button");
          chip.type = "button";
          chip.className = "reaction-chip";
          chip.textContent = r;
          chip.title = "Remove reaction";
          chip.addEventListener("click", function (ev) {
            ev.stopPropagation();
            var i = msg.reactions.indexOf(r);
            if (i >= 0) msg.reactions.splice(i, 1);
            paintReactions();
          });
          reactions.appendChild(chip);
        });
      }
      paintReactions();
      bubble.appendChild(reactions);

      var picker = document.createElement("div");
      picker.className = "reaction-picker";
      picker.hidden = true;
      REACTION_CHOICES.forEach(function (r) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = r;
        b.setAttribute("aria-label", "React with " + r);
        b.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (msg.reactions.indexOf(r) < 0) msg.reactions.push(r);
          picker.hidden = true;
          paintReactions();
        });
        picker.appendChild(b);
      });
      bubble.appendChild(picker);

      bubble.addEventListener("click", function () {
        var all = msgEl.querySelectorAll(".reaction-picker");
        all.forEach(function (el) { if (el !== picker) el.hidden = true; });
        picker.hidden = !picker.hidden;
      });

      var meta = document.createElement("div");
      meta.className = "msg-meta";
      var ticks = msg.from === "me"
        ? '<span class="ticks' + (msg.status === "read" ? " read" : "") + '">' + (msg.status === "sent" ? "✓" : "✓✓") + "</span>"
        : "";
      meta.innerHTML = "<span></span>" + ticks;
      meta.querySelector("span").textContent = msg.time;
      bubble.appendChild(meta);

      row.appendChild(bubble);
      msgEl.appendChild(row);
      void idx;
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
    if (input) input.focus();
  }

  if (backBtn) {
    backBtn.addEventListener("click", function () {
      if (shell) shell.classList.remove("show-pane");
    });
  }

  /* ---------- Sending + local demo replies ---------- */
  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    var conv = getConv(activeId);
    var msg = { from: "me", text: text, time: nowTime(), status: "sent", reactions: [] };
    conv.messages.push(msg);
    input.value = "";
    renderList();
    renderMessages();

    /* Delivered tick, then read tick — purely visual, on this page only. */
    later(function () { msg.status = "delivered"; renderMessages(); }, 450);
    later(function () { msg.status = "read"; renderMessages(); }, 1100);

    /* Typing indicator, then a local demo reply. */
    later(function () {
      typingText.textContent = conv.name + " is typing…";
      typingRow.hidden = false;
      msgEl.scrollTop = msgEl.scrollHeight;
    }, 1300);
    later(function () {
      typingRow.hidden = true;
      var pool = conv.replies && conv.replies.length ? conv.replies : ["Thanks! This is a local demo reply."];
      var i = replyIndex[conv.id] || 0;
      var replyText = pool[i % pool.length];
      replyIndex[conv.id] = i + 1;
      conv.messages.push({
        from: "them",
        sender: conv.name,
        text: replyText,
        time: nowTime(),
        reactions: []
      });
      renderList();
      renderMessages();
    }, 2600);
  });

  /* ---------- Init ---------- */
  renderList();
  openConversation(activeId);
  if (shell) shell.classList.remove("show-pane");
})();
