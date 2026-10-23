/* ConnectX AI showcase page.
   Login is necessary: the "Add Real Chat" button opens a login panel.
   After login, chats are added by mobile number. Accounts, chats and
   messages on this static page are saved only in this browser, on this
   device (localStorage). Real accounts and chatting between phones run
   in the full ConnectX AI app. */
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

  /* ---------- Small storage helpers (device only) ---------- */
  function storeGet(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function storeDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }

  function digitsOnly(s) { return (s || "").replace(/\D/g, ""); }
  function validMobile(d) { return d.length >= 10 && d.length <= 15; }
  function nowTime() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }
  function initialOf(name) { return (name || "?").trim().charAt(0).toUpperCase() || "?"; }

  function hashPassword(pw) {
    if (window.crypto && crypto.subtle && window.isSecureContext) {
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode("connectx:" + pw)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ("0" + b.toString(16)).slice(-2);
        }).join("");
      });
    }
    var h = 0;
    for (var i = 0; i < pw.length; i++) { h = (h * 31 + pw.charCodeAt(i)) | 0; }
    return Promise.resolve("simple:" + h);
  }

  /* ---------- Elements ---------- */
  var chatBox = document.getElementById("chatInterface");
  var loginPanel = document.getElementById("loginPanel");
  var addPanel = document.getElementById("addChatPanel");
  var shell = document.getElementById("waShell");
  var tabLogin = document.getElementById("tabLogin");
  var tabCreate = document.getElementById("tabCreate");
  var authForm = document.getElementById("authForm");
  var nameField = document.getElementById("nameField");
  var authName = document.getElementById("authName");
  var authMobile = document.getElementById("authMobile");
  var authPassword = document.getElementById("authPassword");
  var authError = document.getElementById("authError");
  var authSubmit = document.getElementById("authSubmit");
  var addForm = document.getElementById("addChatForm");
  var addName = document.getElementById("addName");
  var addMobile = document.getElementById("addMobile");
  var addError = document.getElementById("addError");
  var addCancel = document.getElementById("addCancel");
  var meAvatar = document.getElementById("meAvatar");
  var meName = document.getElementById("meName");
  var meNumber = document.getElementById("meNumber");
  var addChatBtn = document.getElementById("addChatBtn");
  var logoutBtn = document.getElementById("logoutBtn");
  var searchEl = document.getElementById("waSearch");
  var listEl = document.getElementById("waChatList");
  var listEmpty = document.getElementById("listEmpty");
  var paneAvatar = document.getElementById("waPaneAvatar");
  var paneName = document.getElementById("waPaneName");
  var paneStatus = document.getElementById("waPaneStatus");
  var deleteBtn = document.getElementById("deleteChatBtn");
  var msgEl = document.getElementById("waMessages");
  var composer = document.getElementById("waComposer");
  var input = document.getElementById("waInput");
  var backBtn = document.getElementById("waBack");

  /* ---------- State ---------- */
  var authMode = "login"; /* or "create" */
  var session = storeGet("cx_session", null); /* mobile digits of the logged-in user */
  var activeId = null;

  function accounts() { return storeGet("cx_accounts", {}); }
  function myAccount() {
    if (!session) return null;
    return accounts()[session] || null;
  }
  function chatsKey() { return "cx_chats_" + session; }
  function myChats() { return session ? storeGet(chatsKey(), []) : []; }
  function saveChats(chats) { if (session) storeSet(chatsKey(), chats); }
  function getChat(id) {
    var chats = myChats();
    for (var i = 0; i < chats.length; i++) { if (chats[i].id === id) return chats[i]; }
    return null;
  }

  /* ---------- Panel switching ---------- */
  function showPanel(which) {
    loginPanel.hidden = which !== "login";
    addPanel.hidden = which !== "add";
    shell.hidden = which !== "shell" && which !== "add";
    if (which === "shell" || which === "add") renderAll();
  }
  function refresh() {
    if (!myAccount()) {
      session = null;
      showPanel("login");
    } else {
      showPanel("shell");
    }
  }
  function openInterface(withAddForm) {
    chatBox.hidden = false;
    refresh();
    if (withAddForm && myAccount()) showPanel("add");
    var target = document.getElementById("real-chat");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  var openers = document.querySelectorAll("[data-open-chat]");
  openers.forEach(function (el) {
    el.addEventListener("click", function () {
      openInterface(el.id === "openChatBtn");
    });
  });

  /* ---------- Auth ---------- */
  function setAuthMode(mode) {
    authMode = mode;
    tabLogin.classList.toggle("active", mode === "login");
    tabCreate.classList.toggle("active", mode === "create");
    nameField.hidden = mode !== "create";
    authSubmit.textContent = mode === "create" ? "Create Account" : "Log In";
    authError.hidden = true;
  }
  tabLogin.addEventListener("click", function () { setAuthMode("login"); });
  tabCreate.addEventListener("click", function () { setAuthMode("create"); });

  function authFail(msg) {
    authError.textContent = msg;
    authError.hidden = false;
  }

  authForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var mobile = digitsOnly(authMobile.value);
    var pw = authPassword.value || "";
    if (!validMobile(mobile)) { authFail("Please enter a valid mobile number (10 to 15 digits)."); return; }
    if (pw.length < 4) { authFail("Password must be at least 4 characters."); return; }
    var all = accounts();
    hashPassword(pw).then(function (hash) {
      if (authMode === "create") {
        var name = (authName.value || "").trim();
        if (!name) { authFail("Please enter your name."); return; }
        if (all[mobile]) { authFail("An account with this number already exists — please log in."); return; }
        all[mobile] = { name: name, passHash: hash };
        storeSet("cx_accounts", all);
        session = mobile;
        storeSet("cx_session", session);
        authPassword.value = "";
        refresh();
      } else {
        var acc = all[mobile];
        if (!acc) { authFail("No account with this number yet — tap Create Account first."); return; }
        if (acc.passHash !== hash) { authFail("Wrong password. Please try again."); return; }
        session = mobile;
        storeSet("cx_session", session);
        authPassword.value = "";
        refresh();
      }
    });
  });

  logoutBtn.addEventListener("click", function () {
    session = null;
    activeId = null;
    storeDel("cx_session");
    refresh();
  });

  /* ---------- Add chat by mobile number ---------- */
  addChatBtn.addEventListener("click", function () { showPanel("add"); });
  addCancel.addEventListener("click", function () { showPanel("shell"); });
  function addFail(msg) {
    addError.textContent = msg;
    addError.hidden = false;
  }
  addForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = (addName.value || "").trim();
    var mobile = digitsOnly(addMobile.value);
    if (!name) { addFail("Please enter the person's name."); return; }
    if (!validMobile(mobile)) { addFail("Please enter a valid mobile number (10 to 15 digits)."); return; }
    if (mobile === session) { addFail("That is your own number — enter the other person's number."); return; }
    var chats = myChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].mobile === mobile) {
        addFail("A chat with this number already exists — opening it.");
        activeId = chats[i].id;
        showPanel("shell");
        return;
      }
    }
    var chat = { id: "c" + Date.now(), name: name, mobile: mobile, messages: [] };
    chats.push(chat);
    saveChats(chats);
    addName.value = "";
    addMobile.value = "";
    addError.hidden = true;
    activeId = chat.id;
    showPanel("shell");
    if (input) input.focus();
  });

  /* ---------- Chat rendering ---------- */
  function renderAll() {
    var me = myAccount();
    if (!me) return;
    meAvatar.textContent = initialOf(me.name);
    meName.textContent = me.name;
    meNumber.textContent = "+" + session;
    renderList();
    renderPane();
  }

  function renderList() {
    var q = (searchEl.value || "").trim().toLowerCase();
    var chats = myChats();
    listEl.innerHTML = "";
    var shown = 0;
    chats.forEach(function (chat) {
      if (q && chat.name.toLowerCase().indexOf(q) < 0 && chat.mobile.indexOf(q) < 0) return;
      shown++;
      var last = chat.messages[chat.messages.length - 1];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wa-item" + (chat.id === activeId ? " active" : "");
      btn.innerHTML =
        '<span class="wa-avatar" aria-hidden="true"></span>' +
        '<span class="wa-item-text">' +
          '<span class="wa-item-top"><span class="wa-item-name"></span><span class="wa-item-time"></span></span>' +
          '<span class="wa-item-preview"></span>' +
        "</span>";
      btn.querySelector(".wa-avatar").textContent = initialOf(chat.name);
      btn.querySelector(".wa-item-name").textContent = chat.name;
      btn.querySelector(".wa-item-time").textContent = last ? last.time : "";
      btn.querySelector(".wa-item-preview").textContent = last ? last.text : chat.mobile;
      btn.addEventListener("click", function () {
        activeId = chat.id;
        renderAll();
        shell.classList.add("show-pane");
      });
      listEl.appendChild(btn);
    });
    listEmpty.hidden = chats.length !== 0;
    listEmpty.textContent = chats.length === 0
      ? "No chats yet. Tap ＋ to add a chat by mobile number."
      : "";
  }

  function renderPane() {
    var chat = activeId ? getChat(activeId) : null;
    if (!chat) {
      paneAvatar.textContent = "?";
      paneName.textContent = "No chat selected";
      paneStatus.textContent = "Add a chat by mobile number";
      deleteBtn.hidden = true;
      input.disabled = true;
      input.placeholder = "Select a chat first";
      msgEl.innerHTML = "";
      var ph = document.createElement("div");
      ph.className = "wa-empty";
      ph.textContent = "Your chats live here. Tap ＋ above to add a chat by mobile number.";
      msgEl.appendChild(ph);
      return;
    }
    paneAvatar.textContent = initialOf(chat.name);
    paneName.textContent = chat.name;
    paneStatus.textContent = "+" + chat.mobile;
    deleteBtn.hidden = false;
    input.disabled = false;
    input.placeholder = "Type a message";
    msgEl.innerHTML = "";
    var divider = document.createElement("div");
    divider.className = "wa-divider";
    divider.textContent = "Chat with " + chat.name + " · " + chat.mobile;
    msgEl.appendChild(divider);
    chat.messages.forEach(function (msg) {
      var row = document.createElement("div");
      row.className = "wa-row me";
      var bubble = document.createElement("div");
      bubble.className = "wa-bubble";
      var p = document.createElement("p");
      p.textContent = msg.text;
      bubble.appendChild(p);
      var meta = document.createElement("div");
      meta.className = "wa-meta";
      var t = document.createElement("span");
      t.textContent = msg.time;
      meta.appendChild(t);
      bubble.appendChild(meta);
      row.appendChild(bubble);
      msgEl.appendChild(row);
    });
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  if (searchEl) searchEl.addEventListener("input", renderList);
  if (backBtn) backBtn.addEventListener("click", function () { shell.classList.remove("show-pane"); });

  deleteBtn.addEventListener("click", function () {
    var chat = activeId ? getChat(activeId) : null;
    if (!chat) return;
    if (!window.confirm("Delete the chat with " + chat.name + "?")) return;
    var chats = myChats().filter(function (c) { return c.id !== chat.id; });
    saveChats(chats);
    activeId = null;
    shell.classList.remove("show-pane");
    renderAll();
  });

  /* ---------- Sending (saved on this device) ---------- */
  composer.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var chat = activeId ? getChat(activeId) : null;
    var text = (input.value || "").trim();
    if (!chat || !text) return;
    var chats = myChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].id === chat.id) {
        chats[i].messages.push({ text: text, time: nowTime() });
      }
    }
    saveChats(chats);
    input.value = "";
    renderAll();
  });

  /* ---------- Init ---------- */
  setAuthMode("login");
  if (session && myAccount()) {
    chatBox.hidden = false;
    showPanel("shell");
  }
})();
