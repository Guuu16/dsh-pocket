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

import { createProxy } from "./src/proxy.mjs";
import { injectMobileShell } from "./src/inject.mjs";
import { startTunnel } from "./src/tunnel.mjs";
import { ensureCloudflared, startQuickTunnel } from "./src/cloudflare.mjs";
import { readAuthSecret, signSessionCookie } from "./src/dsh.mjs";
import { authorize, mintRemoteCookie, remoteCookieAttributes } from "./src/config.mjs";
import { readStore, rotateAccessKey, writeStore } from "./src/store.mjs";
import { ensureKeyLogin } from "./src/ssh-setup.mjs";
import { renderConfigPage } from "./src/config-page.mjs";
import { renderUnlock } from "./src/ui.mjs";
import { configPath } from "./src/config.mjs";

/** Stable Cordis plugin name. */
export const name = "dsh-remote";

/** The GUI's own carrier must exist before this plugin can proxy to it. */
export const inject = ["webServer"];

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;
      if (iface.address.startsWith("198.18.") || iface.address.startsWith("198.19.")) continue;
      out.push(iface.address);
    }
  }
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
    return lanAddresses().map((address) => `http://${address}:${store.port}`);
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
    writeStore({ relay });
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
  async function apiConfig(req, res) {
    if (req.method === "GET") {
      json(res, 200, snapshot());
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
      json(res, 200, applySettings(parsed));
      return;
    }
    json(res, 405, { error: "method not allowed" });
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
    for (const address of lanAddresses()) {
      log(`  phone: http://${address}:${store0.port}/?k=${readStore().accessKey}`);
    }
    restartTunnel();
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
