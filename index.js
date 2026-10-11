/**
 * dsh-remote — the remote-access surface for this machine.
 *
 * What it adds to a running dsh:
 *
 *   1. A LAN/public listener that serves the same GUI this process already
 *      serves on loopback, so a phone sees the identical workspaces and
 *      transcripts rather than a second, thinner view of them.
 *   2. The mobile shell mounted into that GUI (via `webServer.tapIndex`, so the
 *      local GUI benefits too).
 *   3. An outbound tunnel to a relay the user configures from the settings page,
 *      which is what makes the machine reachable from outside its network.
 *   4. An access key that gates every request; without it — and without this
 *      plugin — there is no entry point at all.
 *
 * The listener is a second HTTP server on `0.0.0.0`, not a modification of
 * dsh's own: that one deliberately binds loopback and refuses `--host 0.0.0.0`.
 */

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";

import { createProxy } from "./src/proxy.mjs";
import { injectMobileShell } from "./src/inject.mjs";
import { startTunnel } from "./src/tunnel.mjs";
import { ensureCloudflared, startQuickTunnel } from "./src/cloudflare.mjs";
import { readAuthSecret, signSessionCookie } from "./src/dsh.mjs";
import { authorize, mintRemoteCookie, remoteCookieAttributes } from "./src/config.mjs";
import { readStore, rotateAccessKey, writeStore } from "./src/store.mjs";
import { ensureKeyLogin } from "./src/ssh-setup.mjs";
import { renderConfigPage } from "./src/config-page.mjs";
import QRCode from "qrcode";
import { renderUnlock } from "./src/ui.mjs";
import { configPath } from "./src/config.mjs";

/** Stable Cordis plugin name. */
export const name = "dsh-remote";

/**
 * The GUI's own carrier must exist before this plugin can proxy to it, and the
 * two query services drive project discovery: every session records its `cwd`,
 * and a workspace owns every session whose canonical directory matches. Listing
 * both is what closes the gap between what the GUI shows and what has history.
 */
export const inject = ["webServer", "sessionQuery", "workspaceRegistry"];

/**
 * Interface name prefixes that never reach a phone on the same network.
 *
 * A VPN tunnel or a container bridge has an IPv4 address too, and it is
 * usually enumerated before the Wi-Fi one — which is how a QR code ends up
 * encoding an address that only exists inside this machine.
 */
const VIRTUAL_INTERFACE = /^(utun|ipsec|bridge|awdl|llw|vmenet|docker|veth|tap|tun|gif|stf|ap\d|p2p|anpi)/iu;

/** Rank a real interface ahead of an unknown one: en0 is Wi-Fi or Ethernet. */
function interfaceRank(name) {
  if (/^en\d+$/u.test(name)) return 0;
  if (/^(eth|wlan)\d+$/u.test(name)) return 1;
  return 2;
}

function lanAddresses() {
  const out = [];
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const iface of ifaces ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;
      if (iface.address.startsWith("198.18.") || iface.address.startsWith("198.19.")) continue;
      out.push({ name, address: iface.address });
    }
  }
  // Real adapters first, so a phone gets the address it can actually reach.
  out.sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name) || a.name.localeCompare(b.name));
  return out;
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-transform",
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/**
 * Static files shipped with the plugin, served by the host.
 *
 * This half runs inside dsh, whose own web server knows nothing about these
 * paths — without explicit routes the manifest and the icons answer 404 and
 * the installed app has no name and no icon on the home screen.
 */
const ASSETS = new Map([
  ["/remote.webmanifest", "remote.webmanifest"],
  ["/remote.svg", "remote.svg"],
  ["/remote-icon-180.png", "remote-icon-180.png"],
  ["/remote-icon-192.png", "remote-icon-192.png"],
  ["/remote-icon-512.png", "remote-icon-512.png"],
]);

const ASSET_TYPES = new Map([
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
]);

/** Read once per process: these ship with the plugin and never change while it runs. */
const ASSET_CACHE = new Map();

function serveAsset(res, file) {
  let body = ASSET_CACHE.get(file);
  if (body === undefined) {
    try {
      body = readFileSync(new URL(`./public/${file}`, import.meta.url));
    } catch {
      body = null;
    }
    ASSET_CACHE.set(file, body);
  }
  if (body === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("dsh-remote: asset missing\n");
    return;
  }
  res.writeHead(200, {
    "content-type": ASSET_TYPES.get(extname(file)) ?? "application/octet-stream",
    "cache-control": "no-cache",
    "content-length": String(body.byteLength),
  });
  res.end(body);
}

function readFormBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        // Settle before destroying: the handler must not stay pending forever.
        done("");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(""));
    req.on("close", () => done(""));
  });
}

/**
 * Mount the remote-access surface.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const log = (message) => ctx.logger?.info?.(`dsh-remote: ${message}`);

  /** @type {{stop: () => void} | undefined} */
  let tunnel;
  /** @type {{stop: () => void} | undefined} */
  let publicTunnel;
  let tunnelGeneration = 0;

  /** The signing secret is durable; read it once per process, not per request. */
  let cachedSecret;
  const authSecret = () => {
    if (cachedSecret === undefined) cachedSecret = readAuthSecret();
    return cachedSecret;
  };

  /** Live runtime state reported on the settings page. */
  const status = {
    gateway: "未启动",
    tunnel: "未启动",
    publicUrl: undefined,
    error: undefined,
  };

  /** The GUI port is only known after the web server binds. */
  const guiPort = () => ctx.webServer?.port;
  const guiAuthority = () => {
    const port = guiPort();
    return port === undefined ? "127.0.0.1" : `127.0.0.1:${port}`;
  };

  const proxy = createProxy({
    port: guiPort,
    authority: guiAuthority,
    cookie: () => {
      const port = guiPort();
      if (port === undefined) return undefined;
      return signSessionCookie(`127.0.0.1:${port}`, authSecret(), { days: readStore().cookieDays });
    },
    tapHtml: injectMobileShell,
    onUpgradeError: (error) => log(`websocket relay error: ${error.message}`),
  });

  /** Settings page, shared by the local GUI and the public listener. */
  async function settingsPage(req, res) {
    if (req.method === "POST") {
      const form = new URLSearchParams(await readFormBody(req));
      applySettings({
        mode: form.get("mode"),
        host: form.get("host"),
        user: form.get("user"),
        password: form.get("password"),
        sshPort: form.get("sshPort"),
        remotePort: form.get("remotePort"),
      });
    }
    html(res, 200, renderConfigPage({ store: readStore(), status: { ...status, lanUrls: lanUrls() } }));
  }

  function lanUrls() {
    const store = readStore();
    return lanAddresses().map((iface) => `http://${iface.address}:${store.port}`);
  }

  /**
   * Directories that have session history but no workspace entry.
   *
   * The GUI sidebar lists workspaces, not directories with history, so a
   * project the registry never learned about is invisible on the phone even
   * though its transcripts are there. Both sides come from the same source:
   * every session header carries its `cwd`.
   */
  async function discoverProjects() {
    const records = await ctx.sessionQuery.listSessions();
    const counts = new Map();
    for (const record of records) {
      const cwd = record.header?.cwd;
      if (typeof cwd !== "string" || cwd === "") continue;
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }

    const workspaces = ctx.workspaceRegistry.list();
    const owned = new Set(workspaces.map((workspace) => workspace.path));

    // `sessionIds` is already filtered by the canonical-cwd index, so this is
    // the count the sidebar shows, not a count we derived ourselves.
    const registered = [];
    for (const workspace of workspaces) {
      let present = true;
      try {
        present = (await workspace.status()) === "ok";
      } catch {
        // A registry read must never be the reason this whole endpoint fails.
        present = true;
      }
      registered.push({
        path: workspace.path,
        title: workspace.title,
        sessions: workspace.sessionIds.length,
        present,
      });
    }
    registered.sort((a, b) => b.sessions - a.sessions);

    const missing = [];
    for (const [cwd, sessions] of counts) {
      if (owned.has(cwd)) continue;
      missing.push({ path: cwd, title: basename(cwd), sessions });
    }
    missing.sort((a, b) => b.sessions - a.sessions);

    return {
      total: counts.size,
      registered,
      missing,
      orphaned: registered.filter((item) => item.present === false).length,
    };
  }

  /**
   * Register every discovered directory as a workspace.
   *
   * `workspaceRegistry.create` canonicalizes through `fs.realpath` and is
   * idempotent, so a path that already has a workspace is a no-op and a path
   * whose directory is gone rejects on its own. Sessions attach automatically:
   * `Workspace.sessionIds` is filtered by the canonical-cwd index, so the
   * transcripts appear without an explicit attach call.
   */
  async function syncProjects() {
    const { missing } = await discoverProjects();
    const added = [];
    const failed = [];
    for (const item of missing) {
      try {
        await ctx.workspaceRegistry.create(item.path, item.title);
        added.push(item.title);
      } catch (error) {
        failed.push(`${item.title}: ${error.message}`);
      }
    }
    return { added, failed };
  }

  /**
   * The LAN addresses paired with the adapter they came from.
   *
   * A machine with a VPN or a container runtime has several IPv4 addresses and
   * only one of them is reachable from a phone, so the name is what lets the
   * user tell which code to scan.
   */
  function lanInterfaces() {
    const store = readStore();
    return lanAddresses().map((iface) => ({ name: iface.name, url: `http://${iface.address}:${store.port}` }));
  }

  /** The shape the settings page and the in-GUI settings section both read. */
  function snapshot() {
    const store = readStore();
    return {
      port: store.port,
      accessKey: store.accessKey,
      relay: { ...store.relay, password: store.relay.password === "" ? "" : "***" },
      status: { ...status },
      lanUrls: lanUrls(),
      lanInterfaces: lanInterfaces(),
      autoSyncProjects: readStore().autoSyncProjects === true,
    };
  }

  /**
   * Apply one settings payload from either surface.
   *
   * @param {Record<string, unknown>} input - `mode`, `host`, `user`, `password`,
   *   `sshPort`, `remotePort`. An empty `password` keeps the stored one, which is
   *   what makes the form safe to re-submit after the password has been cleared.
   */
  function applySettings(input) {
    const store = readStore();
    const text = (value) => (typeof value === "string" ? value.trim() : "");
    const port = (value, fallback) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
    };
    const relay = {
      mode: ["off", "ssh", "cloudflare"].includes(input.mode) ? input.mode : "off",
      host: text(input.host),
      user: text(input.user),
      sshPort: port(input.sshPort, 22),
      remotePort: port(input.remotePort, store.port),
    };
    const password = text(input.password);
    if (password !== "") relay.password = password;
    const patch = { relay };
    if (typeof input.autoSyncProjects === "boolean") patch.autoSyncProjects = input.autoSyncProjects;
    writeStore(patch);
    restartTunnel();
    return snapshot();
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  // ── the mobile shell, mounted into dsh's own index ────────────────────────
  ctx.effect(
    () => ctx.webServer.tapIndex(injectMobileShell),
    "dsh-remote: mobile shell",
  );

  // ── settings, reachable from the local GUI ────────────────────────────────
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote/config", handler: settingsPage }),
    "dsh-remote: settings route",
  );

  // The same settings as JSON, for the in-GUI settings section. Both surfaces
  // go through `applySettings`, so a change made in either one is identical.
  /**
   * Render one QR code as SVG.
   *
   * The phone has to open a URL containing a 43-character access key. Typing
   * that is the worst part of pairing, so the server draws the code and the
   * client only has to display it. Rendering here rather than in the browser
   * is deliberate: the client half is served as plain JavaScript by the
   * module loader and cannot import a package, while the host can.
   */
  async function apiQr(req, res) {
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://dsh-remote.invalid");
    const value = url.searchParams.get("text") ?? "";
    if (value === "" || value.length > 2048) {
      text(res, 400, "text query parameter required (1..2048 chars)\n");
      return;
    }
    try {
      const svg = await QRCode.toString(value, {
        type: "svg",
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
        color: { light: "#ffffff", dark: "#000000" },
      });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      res.end(svg);
    } catch (error) {
      text(res, 500, `qr: ${error.message}\n`);
    }
  }

  /** Attach project discovery without letting a failure break the whole reply. */
  async function withProjects(payload) {
    try {
      payload.projects = await discoverProjects();
    } catch (error) {
      payload.projects = { total: 0, missing: [], error: error.message };
    }
    return payload;
  }

  async function apiConfig(req, res) {
    if (req.method === "GET") {
      json(res, 200, await withProjects(snapshot()));
      return;
    }
    if (req.method === "POST") {
      let parsed = {};
      try {
        parsed = JSON.parse(await readFormBody(req));
      } catch {
        json(res, 400, { error: "body must be JSON" });
        return;
      }
      json(res, 200, await withProjects(applySettings(parsed)));
      return;
    }
    json(res, 405, { error: "method not allowed" });
  }

  /**
   * Register every directory that has history but no workspace entry.
   *
   * Explicit and user-triggered on purpose: this writes the durable workspace
   * registry, which is the user's own state, so it should never happen as a
   * side effect of opening a settings page.
   */
  async function apiSync(req, res) {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    let result;
    try {
      result = await syncProjects();
    } catch (error) {
      json(res, 500, { error: error.message });
      return;
    }
    const payload = await withProjects(snapshot());
    payload.synced = result;
    json(res, 200, payload);
  }

  async function apiRotate(req, res) {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    rotateAccessKey();
    restartTunnel();
    json(res, 200, snapshot());
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote/api/config", handler: apiConfig }),
    "dsh-remote: config api",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote/api/rotate", handler: apiRotate }),
    "dsh-remote: rotate api",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote/api/sync", handler: apiSync }),
    "dsh-remote: project sync api",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote/api/qr", handler: apiQr }),
    "dsh-remote: qr api",
  );

  // The manifest and icons the PWA metadata points at. Without these routes the
  // browser gets dsh's GUI index for every one of them.
  for (const route of ASSETS.keys()) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: route,
        handler: (req, res) => serveAsset(res, ASSETS.get(route)),
      }),
      `dsh-remote: asset ${route}`,
    );
  }

  // ── the public listener ───────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    try {
      const store = readStore();
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "dsh-remote.invalid"}`);
      const path = url.pathname;

      const decision = authorize(req, store.accessKey);
      if (decision.ok === false) {
        if (path === "/" || path === "/index.html") {
          // Never render the settings page here: it embeds the access key, which
          // would hand the key to the very requests it is meant to reject.
          html(res, 401, renderUnlock({ days: store.cookieDays, configPath: configPath() }));
          return;
        }
        text(res, 401, "dsh-remote: unauthorized. Open the URL printed by the plugin, or add ?k=<access-key>.\n");
        return;
      }

      if (decision.via === "key") {
        res.writeHead(303, {
          location: path + url.search.replace(/[?&]k=[^&]*/u, "").replace(/^&/u, "?"),
          "set-cookie": `${mintRemoteCookie(store.accessKey, store.cookieDays)}; ${remoteCookieAttributes(store.cookieDays)}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end();
        return;
      }

      if (path === "/remote/config") {
        await settingsPage(req, res);
        return;
      }
      if (path === "/remote/api/config") {
        await apiConfig(req, res);
        return;
      }
      if (path === "/remote/api/rotate") {
        await apiRotate(req, res);
        return;
      }
      if (path === "/remote/api/sync") {
        await apiSync(req, res);
        return;
      }
      if (path === "/remote/api/qr") {
        await apiQr(req, res);
        return;
      }
      if (ASSETS.has(path)) {
        serveAsset(res, ASSETS.get(path));
        return;
      }
      if (path === "/remote/rotate") {
        if (req.method === "POST") {
          rotateAccessKey();
          restartTunnel();
        }
        res.writeHead(303, { location: "/remote/config", "cache-control": "no-store" });
        res.end();
        return;
      }
      if (path === "/remote/healthz") {
        text(res, 200, JSON.stringify({ ok: true, plugin: name, gui: guiAuthority(), ...status }));
        return;
      }

      // Everything else is the GUI: same runtime, same workspaces, same log.
      proxy.handleHttp(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      text(res, 500, `dsh-remote: ${error.message}\n`);
    }
  });

  server.on("connection", (socket) => {
    socket.on("error", () => {});
  });
  server.on("clientError", (error, socket) => {
    if (error.code !== "ECONNRESET") log(`client error: ${error.message}`);
    socket.destroy();
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (authorize(req, readStore().accessKey).ok === false) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        return;
      }
      proxy.handleUpgrade(req, socket, head);
    } catch (error) {
      log(`upgrade failed: ${error.message}`);
      socket.destroy();
    }
  });

  const store0 = readStore();
  server.listen(store0.port, store0.host, () => {
    status.gateway = "listening";
    status.error = undefined;
    log(`listening on ${store0.host}:${store0.port} → ${guiAuthority()}`);
    for (const iface of lanAddresses()) {
      log(`  phone: http://${iface.address}:${store0.port}/?k=${readStore().accessKey} (${iface.name})`);
    }
    restartTunnel();

    // Opt-in upkeep: a project added since the last run shows up without the
    // user remembering to press the button. A failure here is logged and
    // dropped — the page reports the same gap on its own.
    if (readStore().autoSyncProjects === true) {
      const timer = setTimeout(() => {
        syncProjects()
          .then((result) => {
            if (result.added.length > 0) log(`auto-synced projects: ${result.added.join(", ")}`);
          })
          .catch((error) => log(`auto-sync failed: ${error.message}`));
      }, 5000);
      timer.unref?.();
    }
  });
  server.on("error", (error) => {
    status.gateway = "failed";
    status.error = `端口 ${store0.port} 无法监听：${error.message}`;
    log(`listener failed: ${error.message}`);
  });

  ctx.effect(() => () => {
    tunnel?.stop();
    publicTunnel?.stop();
    server.close();
  }, "dsh-remote: listener");

  // ── the outbound relay ────────────────────────────────────────────────────
  function restartTunnel() {
    const generation = ++tunnelGeneration;
    tunnel?.stop();
    publicTunnel?.stop();
    tunnel = undefined;
    publicTunnel = undefined;
    status.publicUrl = undefined;

    const relay = readStore().relay;

    if (relay.mode === "cloudflare") {
      status.tunnel = "启动中";
      ensureCloudflared((message) => log(message))
        .then((binary) => {
          if (generation !== tunnelGeneration) return;
          publicTunnel = startQuickTunnel({
            localPort: readStore().port,
            binary,
            onUrl: (url) => {
              if (generation !== tunnelGeneration) return;
              status.tunnel = "up";
              status.error = undefined;
              status.publicUrl = url;
              log(`public: ${url}/?k=${readStore().accessKey}`);
            },
            onStatus: (event) => {
              if (generation !== tunnelGeneration) return;
              if (event.kind === "dialing") status.tunnel = "拨号中";
              if (event.kind === "dropped" || event.kind === "error") {
                status.tunnel = "断开，重试中";
                status.publicUrl = undefined;
              }
            },
          });
        })
        .catch((error) => {
          status.tunnel = "失败";
          status.error = `Cloudflare 隧道不可用：${error.message}`;
          log(`cloudflare unavailable: ${error.message}`);
        });
      return;
    }

    if (relay.mode === "ssh" && relay.host !== "") {
      const target = relay.user === "" ? relay.host : `${relay.user}@${relay.host}`;
      status.tunnel = "启动中";
      ensureKeyLogin({ target, sshPort: relay.sshPort, password: relay.password })
        .then((result) => {
          if (generation !== tunnelGeneration) return;
          if (!result.ok) {
            status.tunnel = "失败";
            status.error = `SSH 登录失败：${result.detail}`;
            log(`ssh provisioning failed: ${result.detail}`);
            return;
          }
          // The key works now; the password is no longer needed on disk.
          if (relay.password !== "") writeStore({ relay: { password: "" } });
          tunnel = startTunnel({
            target,
            remotePort: relay.remotePort,
            localPort: readStore().port,
            onStatus: (event) => {
              // Ignore callbacks from a tunnel this generation already replaced.
              if (generation !== tunnelGeneration) return;
              if (event.kind === "dialing") status.tunnel = "拨号中";
              if (event.kind === "established") {
                status.tunnel = "up";
                status.error = undefined;
                status.publicUrl = `http://${relay.host}:${relay.remotePort}`;
                log(`anywhere: ${status.publicUrl}/?k=${readStore().accessKey}`);
              }
              if (event.kind === "dropped") {
                // The forward is gone, so the published address is no longer
                // true — do not keep showing a URL that no longer answers.
                status.tunnel = "断开，重试中";
                status.publicUrl = undefined;
              }
              if (event.kind === "forward-refused") {
                status.tunnel = "端口被拒";
                status.publicUrl = undefined;
                status.error = `服务器拒绝转发 ${relay.remotePort}：（需要 GatewayPorts clientspecified，且安全组要放行该端口）`;
              }
            },
          });
        })
        .catch((error) => {
          status.tunnel = "失败";
          status.error = `SSH 隧道失败：${error.message}`;
        });
      return;
    }

    status.tunnel = "关闭";
    status.error = undefined;
  }

  log("mounted; settings at /remote/config");
}
