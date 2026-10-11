/* dsh-remote client behaviour: list filtering plus a small transcript aid.
   Deliberately tiny — the pages are server-rendered and work without this file. */

(function () {
  "use strict";

  var filter = document.getElementById("filter");
  if (filter) {
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-search]"));
    filter.addEventListener("input", function () {
      var needle = filter.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (item) {
        var haystack = (item.getAttribute("data-search") || "").toLowerCase();
        var match = needle === "" || haystack.indexOf(needle) !== -1;
        item.style.display = match ? "" : "none";
        if (match) shown += 1;
      });
      var label = document.querySelector(".section-label");
      if (label) {
        var base = label.getAttribute("data-base");
        if (!base) {
          base = label.textContent;
          label.setAttribute("data-base", base);
        }
        label.textContent = needle === "" ? base : base + " · " + shown + " match" + (shown === 1 ? "" : "es");
      }
    });
  }

  // Long tool output: keep the newest expansion reachable without a scroll hunt.
  document.addEventListener("toggle", function (event) {
    var details = event.target;
    if (details instanceof HTMLDetailsElement && details.open) {
      var inner = details.querySelector(".inner");
      if (inner) inner.scrollTop = 0;
    }
  }, true);
})();
