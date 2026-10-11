/*
 * Mobile comfort layer for the dsh web GUI, injected by the dsh remote gateway.
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
   * Give the icon rail's controls a finger-sized height.
   *
   * Height only, and that is not a detail: this used to set `minWidth` too,
   * which measured 35px-wide sidebar rows being stretched to 44 inside their
   * own 35px lane (clientWidth 35 / scrollWidth 44 on logoRow, panelList and
   * sectionHeader), so the frame grew to 780px inside a 390px viewport. The
   * `x <= 80` guard below does not exclude the sidebar — it opens at the left
   * edge — so every one of those rows got the inline style.
   *
   * An inline style also outranks the stylesheet, so fixing the CSS alone
   * changed nothing.
   */
  function enlargeRailTargets() {
    var nodes = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el.dataset.dshrSized === "1") continue;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.height >= MIN_TARGET) {
        el.dataset.dshrSized = "1";
        continue;
      }
      el.style.minHeight = MIN_TARGET + "px";
      el.dataset.dshrSized = "1";
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
