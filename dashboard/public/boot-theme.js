// Issue #17: was an inline <script> in index.html — kept as a file so the desktop
// CSP needs no inline scripts. Runs before React: matches the boot loader's
// background to the saved theme (no white flash for dark-mode users).
(function () {
  var dark = false;
  try {
    var t = localStorage.getItem("theme");
    dark = t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {}
  document.documentElement.style.background = dark ? "#0f172a" : "#f8fafc";
})();
