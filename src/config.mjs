/**
 * Gateway configuration and access control.
 *
 * The access key is the pairing secret: it is generated once, stored under
 * `~/.dsh-pocket/config.json`, and exchanged for an HttpOnly cookie on first
 * use so the key never rides along in page URLs afterwards. Loopback requests
 * are trusted without it, because a process on this machine already has full
 * filesystem access to the same data.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COOKIE = "dsh-pocket";

/** Directory holding gateway state, separate from the dsh home. */
export function pocketHome() {
  return process.env.DSH_POCKET_HOME ?? join(homedir(), ".dsh-pocket");
}

/** Absolute path of the gateway config file. */
export function configPath() {
  return join(pocketHome(), "config.json");
}

function randomKey() {
  return randomBytes(32).toString("base64url");
}

/**
 * Load config, creating it with a fresh access key on first run.
 *
 * @returns {{port: number, host: string, accessKey: string, cookieDays: number, dshPort?: number}}
 */
export function loadConfig() {
  const path = configPath();
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    stored = {};
  }

  const config = {
    port: Number(stored.port ?? 8787),
    host: stored.host ?? "0.0.0.0",
    accessKey: typeof stored.accessKey === "string" && stored.accessKey.length >= 16
      ? stored.accessKey
      : randomKey(),
    cookieDays: Number(stored.cookieDays ?? 30),
    ...(stored.dshPort === undefined ? {} : { dshPort: Number(stored.dshPort) }),
    // Persisted reverse-tunnel target, so a plain `./start.sh` reconnects it.
    ...(typeof stored.tunnel === "string" && stored.tunnel !== "" ? { tunnel: stored.tunnel } : {}),
    ...(stored.tunnelPort === undefined ? {} : { tunnelPort: Number(stored.tunnelPort) }),
  };

  try {
    mkdirSync(pocketHome(), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  } catch (error) {
    throw new Error(`cannot write ${path}: ${error.message}`);
  }

  return config;
}

function signature(secret, body) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * Mint the phone session cookie for one access key.
 *
 * @param {string} accessKey - pairing secret.
 * @param {number} days - cookie lifetime.
 * @returns {string} `name=value` pair without attributes.
 */
export function mintPocketCookie(accessKey, days) {
  const issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ v: 1, issuedAt, expiresAt: issuedAt + days * 86_400_000 })).toString("base64url");
  return `${COOKIE}=${body}.${signature(accessKey, body)}`;
}

/** Cookie attributes for the phone session. */
export function pocketCookieAttributes(days) {
  return `Max-Age=${days * 86_400}; Path=/; HttpOnly; SameSite=Lax`;
}

function cookieValue(header, name) {
  if (typeof header !== "string") return undefined;
  for (const segment of header.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Whether a Host header names an address on this machine's own network.
 *
 * This matters because every tunnel (cloudflared, ssh -R, a local reverse
 * proxy) connects from 127.0.0.1: without checking the Host too, tunnelled
 * traffic would inherit the loopback exemption and the public URL would be
 * open to anyone who has it.
 */
function isLocalAuthority(host) {
  if (typeof host !== "string" || host === "") return false;
  const name = host.replace(/^\[/u, "").split(/[:\]]/u)[0].toLowerCase();
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  if (/^127\./u.test(name)) return true;
  if (/^10\./u.test(name)) return true;
  if (/^192\.168\./u.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(name)) return true;
  return false;
}

/**
 * Verify an incoming request against the access key.
 *
 * @param {{headers: Record<string, unknown>, socket: {remoteAddress?: string}, url?: string}} request
 * @param {string} accessKey
 * @returns {{ok: boolean, via?: "loopback" | "cookie" | "key"}}
 */
export function authorize(request, accessKey) {
  const remote = request.socket?.remoteAddress ?? "";
  const host = request.headers?.host;
  const fromLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (fromLoopback && isLocalAuthority(host)) {
    return { ok: true, via: "loopback" };
  }

  const raw = cookieValue(request.headers?.cookie, COOKIE);
  if (typeof raw === "string") {
    const parts = raw.split(".");
    if (parts.length === 2) {
      const [body, mac] = parts;
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        decoded = undefined;
      }
      if (decoded !== undefined && typeof decoded.expiresAt === "number" && decoded.expiresAt > Date.now()) {
        const expected = signature(accessKey, body);
        const actual = Buffer.from(mac);
        const want = Buffer.from(expected);
        if (actual.byteLength === want.byteLength && timingSafeEqual(actual, want)) {
          return { ok: true, via: "cookie" };
        }
      }
    }
  }

  const query = new URL(request.url ?? "/", "http://pocket.invalid").searchParams.get("k");
  if (typeof query === "string" && query !== "") {
    const actual = Buffer.from(query);
    const want = Buffer.from(accessKey);
    if (actual.byteLength === want.byteLength && timingSafeEqual(actual, want)) {
      return { ok: true, via: "key" };
    }
  }

  return { ok: false };
}

/** Replace the stored access key, invalidating every paired phone. */
export function rotateAccessKey() {
  const config = loadConfig();
  const next = { ...config, accessKey: randomKey() };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/**
 * Remember a reverse-tunnel target so a later plain start reconnects it.
 *
 * @param {string | undefined} target - `[user@]host`, or empty to clear.
 * @param {number | undefined} remotePort - relay port, or undefined to reuse the gateway port.
 * @returns {object} the stored config.
 */
export function persistTunnel(target, remotePort) {
  const config = loadConfig();
  const next = { ...config };
  if (target === undefined || target === "") delete next.tunnel;
  else next.tunnel = target;
  if (remotePort === undefined || Number.isNaN(remotePort)) delete next.tunnelPort;
  else next.tunnelPort = Number(remotePort);
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}
