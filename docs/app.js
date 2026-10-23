/* ConnectX AI static showcase page.
   This page is static: it has no server, no accounts and no real chat.
   Real chat runs in the full ConnectX AI app (source in the GitHub repo).
   The only script on this page is the light/dark theme toggle. */
(function () {
  "use strict";

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
})();
