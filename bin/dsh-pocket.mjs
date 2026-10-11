#!/usr/bin/env node
/**
 * dsh-pocket — a phone gateway for the local DeepSeek Harness runtime.
 *
 * It does three things:
 *   1. binds 0.0.0.0 so a phone on the same network can reach the runtime at all
 *      (dsh itself refuses `--host 0.0.0.0` and binds loopback only);
 *   2. reverse-proxies the full dsh web GUI, rewriting Host/Origin and minting
 *      the signed browser cookie dsh expects, so the GUI is fully usable;
 *   3. serves a mobile-first index over `~/.dsh/sessions`, which is the only
 *      place every project and every historical session is recorded.
 *
 * Usage:
 *   node bin/dsh-pocket.mjs [--port 8787] [--host 0.0.0.0] [--dsh-port 19387]
 *                           [--print-access-url] [--rotate-key]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  authorize,
  configPath,
  loadConfig,
  mintPocketCookie,
  persistTunnel,
  pocketCookieAttributes,
  rotateAccessKey,
} from "../src/config.mjs";
import { lanAddresses, readAuthSecret, resolveDshWeb, signSessionCookie } from "../src/dsh.mjs";
import { createProxy } from "../src/proxy.mjs";
import { parseTunnelSpec, startTunnel } from "../src/tunnel.mjs";
import { ensureCloudflared, startQuickTunnel } from "../src/cloudflare.mjs";
import { injectMobileShell } from "../src/inject.mjs";
import { findSession, listProjects, projectTimeline, readLog } from "../src/session-store.mjs";
import { applyLink, countUnlinked, describeStore, planLink, workspaceStorePath } from "../src/workspace-link.mjs";
import {
  renderFault,
  renderHome,
  renderLink,
  renderLinkDone,
  renderProject,
  renderSession,
  renderUnlock,
} from "../src/ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const VERSION = "0.1.0";

/** Static files this gateway serves itself, with their content types. */
const ASSET_TYPES = {
  "pocket.css": "text/css; charset=utf-8",
  "pocket.js": "text/javascript; charset=utf-8",
  "pocket.svg": "image/svg+xml",
  "pocket.webmanifest": "application/manifest+json",
  "pocket-mobile.css": "text/css; charset=utf-8",
  "pocket-mobile.js": "text/javascript; charset=utf-8",
};
const STOCK_ASSETS = new Set(Object.keys(ASSET_TYPES).map((name) => `/${name}`));

/** Transcript entries rendered per page before the "load earlier" link. */
const TAIL_ENTRIES = 250;

function parseArgs(argv) {
  const options = {
    port: undefined,
    host: undefined,
    dshPort: undefined,
    tunnel: undefined,
    tunnelPort: undefined,
    noTunnel: false,
    public: false,
    noPublic: false,
    printAccessUrl: false,
    rotateKey: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--host") options.host = argv[++index];
    else if (arg === "--dsh-port") options.dshPort = Number(argv[++index]);
    else if (arg === "--tunnel") options.tunnel = argv[++index];
    else if (arg === "--tunnel-port") options.tunnelPort = Number(argv[++index]);
    else if (arg === "--no-tunnel") options.noTunnel = true;
    else if (arg === "--public") options.public = true;
    else if (arg === "--no-public") options.noPublic = true;
    else if (arg === "--print-access-url") options.printAccessUrl = true;
    else if (arg === "--rotate-key") options.rotateKey = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

const HELP = `dsh-pocket ${VERSION} — reach the local DeepSeek Harness runtime from a phone

  --port <n>             gateway port (default 8787)
  --host <addr>          gateway bind address (default 0.0.0.0)
  --dsh-port <n>         dsh web port to proxy (default: auto-detect)
  --tunnel <[user@]host> keep an ssh -R reverse tunnel to this relay, so the
                         gateway is reachable from any network (persisted)
  --tunnel-port <n>      port to ask the relay for (default: the gateway port)
  --no-tunnel            ignore a persisted tunnel for this run
  --public               expose the gateway on a public Cloudflare HTTPS URL
                         (outbound only: survives NAT, no ports, no account)
  --no-public            do not start the Cloudflare tunnel this run
  --print-access-url     print the paired URL and exit
  --rotate-key           issue a new access key and exit (unpairs every phone)
  -h, --help             this text
`;

/**
 * `no-transform` matters: edge proxies in front of a tunnel (Cloudflare in
 * particular) otherwise inject scripts into HTML — email obfuscation, Rocket
 * Loader — and a rewritten script tag breaks the ES-module boot sequence, so
 * the GUI hangs on "Loading plugins…".
 */
function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-transform",
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store, no-transform" });
  res.end(body);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.rotateKey) {
    const next = rotateAccessKey();
    process.stdout.write(`dsh-pocket: new access key issued in ${configPath()}\n`);
    for (const address of [ "127.0.0.1", ...lanAddresses() ]) {
      process.stdout.write(`  http://${address}:${next.port}/?k=${next.accessKey}\n`);
    }
    return;
  }

  const config = loadConfig();
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  const dshPort = options.dshPort ?? config.dshPort;

  if (options.printAccessUrl) {
    for (const address of [ "127.0.0.1", ...lanAddresses() ]) {
      process.stdout.write(`http://${address}:${port}/?k=${config.accessKey}\n`);
    }
    return;
  }

  let dsh;
  try {
    dsh = await resolveDshWeb({ explicitPort: dshPort });
  } catch (error) {
    process.stderr.write(`dsh-pocket: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  /** Supervised reverse tunnel, when one is configured. */
  let tunnel;
  /** Supervised Cloudflare quick tunnel, when --public is on. */
  let publicTunnel;

  const secret = readAuthSecret();
  const proxy = createProxy({
    port: dsh.port,
    authority: dsh.authority,
    cookie: () => signSessionCookie(dsh.authority, secret, { days: config.cookieDays }),
    tapHtml: injectMobileShell,
    onUpgradeError: (error) => {
      process.stderr.write(`dsh-pocket: websocket relay error: ${error.message}\n`);
    },
  });

  /** Strip the /gui mount prefix so dsh sees the paths it owns. */
  function stripGui(url) {
    const path = url ?? "/";
    if (path === "/gui") return "/";
    if (path.startsWith("/gui/")) return path.slice("/gui".length);
    return path;
  }

  const isGuiPath = (url = "/") => url === "/gui" || url.startsWith("/gui/") || url.startsWith("/api/") ||
    url.startsWith("/plugins/") || url.startsWith("/assets/");

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "pocket.invalid"}`);
      const path = url.pathname;

      const decision = authorize(request, config.accessKey);
      if (decision.ok === false) {
        if (path === "/" || path === "/index.html") {
          html(response, 401, renderUnlock({ days: config.cookieDays, configPath: configPath() }));
          return;
        }
        text(response, 401, "dsh-pocket: unauthorized. Open the URL printed by dsh-pocket, or add ?k=<access-key>.\n");
        return;
      }

      if (decision.via === "key") {
        // Exchange the URL key for a cookie and clean the address bar.
        response.writeHead(303, {
          location: path,
          "set-cookie": `${mintPocketCookie(config.accessKey, config.cookieDays)}; ${pocketCookieAttributes(config.cookieDays)}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }

      if (STOCK_ASSETS.has(path)) {
        const name = path.slice(1);
        const body = await readFile(join(PUBLIC_DIR, name));
        text(response, 200, body, ASSET_TYPES[name] ?? "application/octet-stream");
        return;
      }

      if (path === "/healthz") {
        text(response, 200, JSON.stringify({ ok: true, version: VERSION, dsh: dsh.authority }), "application/json");
        return;
      }

      // The root IS the dsh GUI: same runtime, same workspaces, same transcript
      // as the desktop app. The index lives at /pocket as a supplement for
      // projects and sessions the GUI has never opened.
      if (path === "/" || path === "/index.html") {
        response.writeHead(302, { location: "/gui/", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (path === "/pocket" || path === "/pocket/") {
        const projects = listProjects();
        html(response, 200, renderHome({
          projects,
          dsh,
          unlinked: countUnlinked(projects),
        }));
        return;
      }

      if (path === "/link") {
        const projects = listProjects();
        if (request.method === "POST") {
          request.resume(); // drain the (empty) form body so keep-alive stays sane
          const plan = planLink(projects);
          const result = applyLink(plan);
          html(response, 200, renderLinkDone(result));
          return;
        }
        html(response, 200, renderLink({
          plan: planLink(projects),
          known: describeStore(),
          storePath: workspaceStorePath(),
        }));
        return;
      }

      if (path.startsWith("/p/")) {
        const wanted = decodeURIComponent(path.slice(3));
        const project = listProjects().find((candidate) => candidate.key === path.slice(3) || candidate.path === wanted);
        if (project === undefined) {
          html(response, 404, renderFault({ message: `No project at ${wanted}.` }));
          return;
        }
        html(response, 200, renderProject({ project }));
        return;
      }

      if (path.startsWith("/s/")) {
        const sessionId = decodeURIComponent(path.slice(3));
        const found = findSession(sessionId);
        if (found === undefined) {
          html(response, 404, renderFault({ message: `No session ${sessionId}.` }));
          return;
        }
        const read = readLog(found.session.logPath);
        const projected = projectTimeline(read.records);
        // A 1.5 MB log renders to 1000+ entries; show the tail by default so a
        // phone paints quickly, and let ?full=1 pull the whole transcript.
        const full = url.searchParams.get("full") === "1";
        const omitted = full ? 0 : Math.max(0, projected.entries.length - TAIL_ENTRIES);
        html(response, 200, renderSession({
          session: found.session,
          project: found.project,
          omitted,
          timeline: {
            entries: omitted === 0 ? projected.entries : projected.entries.slice(-TAIL_ENTRIES),
            truncated: read.truncated,
          },
        }));
        return;
      }

      if (path === "/gui") {
        response.writeHead(303, { location: "/gui/", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (path.startsWith("/gui/")) {
        request.url = stripGui(path) + url.search;
        proxy.handleHttp(request, response);
        return;
      }

      if (isGuiPath(path)) {
        proxy.handleHttp(request, response);
        return;
      }

      // Anything unknown may still be a dsh asset resolved relative to /gui/.
      proxy.handleHttp(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`dsh-pocket: request failed: ${message}\n`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      html(response, 500, renderFault({ message }));
    }
  });

  // A gateway must survive its clients: phones change networks, background tabs
  // drop sockets, and WebSocket carriers reset mid-handshake. Every socket gets
  // an error handler so a reset can never escalate into an uncaught exception.
  server.on("connection", (socket) => {
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
        process.stderr.write(`dsh-pocket: socket error: ${error.message}\n`);
      }
    });
  });

  server.on("clientError", (error, socket) => {
    if (error.code !== "ECONNRESET" && error.code !== "HPE_INVALID_EOF_STATE") {
      process.stderr.write(`dsh-pocket: client error: ${error.message}\n`);
    }
    socket.destroy();
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      // The RPC mux carries full runtime control, so it is gated exactly like
      // the HTTP surface: loopback, a paired cookie, or the access key.
      if (authorize(request, config.accessKey).ok === false) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "pocket.invalid"}`);
      if (url.pathname === "/gui" || url.pathname.startsWith("/gui/")) {
        request.url = stripGui(url.pathname) + url.search;
      }
      proxy.handleUpgrade(request, socket, head);
    } catch (error) {
      process.stderr.write(`dsh-pocket: upgrade failed: ${error.message}\n`);
      socket.destroy();
    }
  });

  server.listen(port, host, () => {
    const local = `http://127.0.0.1:${port}/?k=${config.accessKey}`;
    process.stdout.write(`dsh-pocket ${VERSION}\n`);
    process.stdout.write(`  dsh web   ${dsh.baseUrl} (authenticated by gateway)\n`);
    process.stdout.write(`  local     ${local}\n`);
    for (const address of lanAddresses()) {
      process.stdout.write(`  phone     http://${address}:${port}/?k=${config.accessKey}\n`);
    }
    process.stdout.write(`  key file  ${configPath()}\n`);

    const tunnelSpec = options.noTunnel
      ? undefined
      : parseTunnelSpec(options.tunnel ?? config.tunnel ?? "");
    if (tunnelSpec !== undefined) {
      const remotePort = options.tunnelPort ?? config.tunnelPort ?? port;
      tunnel = startTunnel({
        target: tunnelSpec.target,
        remotePort,
        localPort: port,
        onStatus: (event) => {
          if (event.kind === "dialing") {
            process.stdout.write(`  tunnel    dialing ${event.detail}\n`);
            return;
          }
          if (event.kind === "dropped" || event.kind === "error" || event.kind === "forward-refused") {
            process.stderr.write(`dsh-pocket: tunnel ${event.kind}: ${event.detail}\n`);
            return;
          }
          if (event.kind === "log" && /Permission denied|Could not resolve|Connection refused/i.test(event.detail)) {
            process.stderr.write(`dsh-pocket: ssh: ${event.detail}\n`);
          }
        },
      });
      process.stdout.write(`  anywhere  http://${tunnelSpec.host}:${remotePort}/?k=${config.accessKey}\n`);
      persistTunnel(options.tunnel ?? config.tunnel, options.tunnelPort ?? config.tunnelPort);
    }

    if (options.public && !options.noPublic) {
      ensureCloudflared((message) => process.stdout.write(`  public    ${message}\n`))
        .then((binary) => {
          publicTunnel = startQuickTunnel({
            localPort: port,
            binary,
            onUrl: (url) => process.stdout.write(`  public    ${url}/?k=${config.accessKey}\n`),
            onStatus: (event) => {
              if (event.kind === "dialing") process.stdout.write("  public    opening an outbound tunnel\n");
              else if (event.kind === "dropped" || event.kind === "error") {
                process.stderr.write(`dsh-pocket: cloudflare ${event.kind}: ${event.detail}\n`);
              }
            },
          });
        })
        .catch((error) => process.stderr.write(`dsh-pocket: public tunnel unavailable: ${error.message}\n`));
    }
  });

  const shutdown = () => {
    tunnel?.stop();
    publicTunnel?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`dsh-pocket: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
