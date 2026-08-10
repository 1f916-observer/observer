// Theme, applied before first paint.
//
// This is a separate, render-blocking script in <head> rather than part of
// app.js on purpose. app.js is a module, so it is deferred until after the
// document parses — a reader who chose dark would get a white flash on every
// navigation. Our CSP forbids inline script, so the fix cannot be a one-liner
// in the HTML; it has to be its own file served from 'self'.
//
// Kept deliberately tiny: everything this runs delays the first paint.
(function () {
  try {
    var choice = localStorage.getItem("observer-theme");
    if (choice === "light" || choice === "dark") {
      document.documentElement.setAttribute("data-theme", choice);
    }
  } catch (e) {
    // Private browsing and blocked storage both throw here. Following the
    // operating system is a perfectly good outcome, so there is nothing to
    // report and nothing to fall back to.
  }
})();
