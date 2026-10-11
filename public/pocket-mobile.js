/*
 * Mobile comfort layer for the dsh web GUI, injected by the dsh pocket gateway.
 *
 * Scope is intentionally narrow. The GUI is already responsive: on a narrow
 * viewport its icon rail collapses the workspace sidebar, and "打开侧边栏"
 * brings it back. An earlier revision of this script tried to convert that
 * sidebar into a fixed overlay and measurably broke the conversation pane's
 * position (the pane ended up at x=320 with width=390), so the layout is left
 * to the GUI.
 *
 * What remains is what the GUI cannot know: touch target sizing for the icon
 * rail. Everything else lives in the stylesheet.
 */

(function () {
  "use strict";

  var MIN_TARGET = 44;

  /**
   * Grow the icon rail's controls to a finger-sized target.
   *
   * Only elements already pinned to the left edge and smaller than the target
   * are touched, so nothing in the conversation area is affected.
   */
  function enlargeRailTargets() {
    var nodes = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el.dataset.dshpSized === "1") continue;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.x > 80) continue; // not the rail
      if (r.width >= MIN_TARGET && r.height >= MIN_TARGET) continue;
      el.style.minWidth = MIN_TARGET + "px";
      el.style.minHeight = MIN_TARGET + "px";
      el.dataset.dshpSized = "1";
    }
  }

  function start() {
    enlargeRailTargets();

    var attempts = 0;
    var poll = setInterval(function () {
      attempts += 1;
      enlargeRailTargets();
      if (attempts > 40) clearInterval(poll);
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("resize", enlargeRailTargets);
})();
