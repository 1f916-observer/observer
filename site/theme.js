// The Observer follows the reader's OS/browser colour preference and offers no
// in-page toggle. This one-time cleanup drops any theme a previous version had
// stored, so everyone reverts to Auto (prefers-color-scheme). Kept as its own
// tiny file because the CSP forbids inline script.
(function () {
  try { localStorage.removeItem("observer-theme"); } catch (e) { /* storage blocked; auto already applies */ }
})();
