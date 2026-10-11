/**
 * HTML tap that mounts the mobile shell into the dsh GUI.
 *
 * The shell is inlined rather than referenced: a tap runs while a response is
 * being assembled, and inlining keeps it to a single rewrite with no extra
 * routes to register — which also means a tunnel in front of the gateway has
 * nothing else to fetch.
 *
 * It applies unconditionally. The stylesheet is width-gated, so a desktop
 * browser at 1280px gets the untouched desktop layout while a phone gets the
 * drawer-free comfort layer; no User-Agent sniffing is involved.
 */

import { readFileSync } from "node:fs";

function asset(name) {
  try {
    return readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
  } catch {
    return "";
  }
}

// Read once per process: these ship with the plugin and never change while it runs.
const MOBILE_CSS = asset("remote-mobile.css");
const MOBILE_JS = asset("remote-mobile.js");

const HEAD_SNIPPET =
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
  (MOBILE_CSS === "" ? "" : `<style data-dsh-remote="mobile">${MOBILE_CSS}</style>`);

const BODY_SNIPPET = MOBILE_JS === "" ? "" : `<script data-dsh-remote="mobile">${MOBILE_JS}</script>`;

/**
 * Insert the mobile shell into one HTML document.
 *
 * @param {string} html - the upstream document.
 * @returns {string} the document with the shell mounted, or the input unchanged.
 */
export function injectMobileShell(html) {
  if (html.includes('data-dsh-remote="mobile"')) return html;

  let out = html;
  if (out.includes("</head>")) {
    out = out.replace("</head>", HEAD_SNIPPET + "</head>");
  } else {
    out = HEAD_SNIPPET + out;
  }
  if (BODY_SNIPPET !== "") {
    if (out.includes("</body>")) out = out.replace("</body>", BODY_SNIPPET + "</body>");
    else out += BODY_SNIPPET;
  }
  return out;
}
