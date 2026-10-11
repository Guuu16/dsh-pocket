/**
 * Knowledge of the local dsh installation: home layout, the browser-session
 * signing secret, the cookie dsh itself would mint, and the port its web
 * server listens on.
 *
 * dsh authenticates its browser surface with a signed cookie whose name and
 * payload are bound to the request authority. The signing secret is durable
 * (`$DSH_HOME/.credentials.yaml`), so the gateway can mint a valid cookie for
 * the loopback authority without ever seeing the process launch token. That is
 * what lets a phone reach the GUI: the gateway rewrites Host to the loopback
 * authority and presents a cookie that authority trusts.
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

/** Absolute path of the dsh home directory. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Session-log root, one directory per working directory. */
export function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** Credential store holding the browser-session signing secret. */
export function credentialsPath() {
  return join(dshHome(), ".credentials.yaml");
}

function base64UrlToBuffer(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function bufferToBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * Read the durable browser-session signing secret.
 *
 * @returns {Buffer} 32 raw secret bytes.
 * @throws {Error} when no browser session has ever been established.
 */
export function readAuthSecret() {
  let raw;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${credentialsPath()}: ${error.message}. Start the dsh web surface once so it creates the browser-session credential.`,
    );
  }
  const body = raw.match(
    /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u,
  );
  if (body === null) {
    throw new Error(
      `${credentialsPath()} has no client-connection/browser-session secret; start the dsh web surface once, then retry.`,
    );
  }
  const secret = base64UrlToBuffer(body[1]);
  if (secret.byteLength !== 32) {
    throw new Error("dsh browser-session secret is not 32 bytes; refusing to sign with it.");
  }
  return secret;
}

/** Cookie name dsh derives for one request authority. */
export function cookieNameFor(authority) {
  return "dsh-auth-" + bufferToBase64Url(createHash("sha256").update(authority).digest());
}

/**
 * Mint the cookie dsh accepts for one authority.
 *
 * @param {string} authority - canonical `host:port` the request will carry.
 * @param {Buffer} secret - durable signing secret.
 * @param {{days?: number}} [options] - absolute cookie lifetime.
 * @returns {string} `name=value`, ready for a Cookie header.
 */
export function signSessionCookie(authority, secret, options = {}) {
  const days = options.days ?? 30;
  const now = Date.now();
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + days * 86_400_000,
  };
  const body = bufferToBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = bufferToBase64Url(createHmac("sha256", secret).update(body).digest());
  return `${cookieNameFor(authority)}=v1.${body}.${signature}`;
}

function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Find the dsh web server and prove it answers the minted cookie.
 *
 * @param {{candidates?: number[], explicitPort?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{port: number, authority: string, baseUrl: string, cookie: string}>}
 * @throws {Error} when no candidate serves the dsh browser surface.
 */
export async function resolveDshWeb(options = {}) {
  const secret = readAuthSecret();
  const candidates = [
    ...(options.explicitPort === undefined ? [] : [options.explicitPort]),
    ...(options.candidates ?? [19387, 3080, 3000, 8000, 8080]),
  ];
  const seen = new Set();
  const tried = [];

  for (const port of candidates) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (!(await probePort(port, options.timeoutMs))) continue;
    const authority = `127.0.0.1:${port}`;
    const cookie = signSessionCookie(authority, secret);
    let response;
    try {
      response = await fetch(`http://${authority}/`, {
        headers: { cookie, accept: "text/html" },
        redirect: "manual",
      });
    } catch {
      tried.push(`${port} (unreachable)`);
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    if (response.status === 200 && type.includes("text/html")) {
      return { port, authority, baseUrl: `http://${authority}`, cookie };
    }
    tried.push(`${port} (HTTP ${response.status} ${type || "no content-type"})`);
  }

  throw new Error(
    `no dsh web server found on 127.0.0.1. Probed: ${tried.join(", ") || "none listening"}. ` +
      "Open the dsh desktop app, then retry.",
  );
}

/** Every non-internal IPv4 address that a phone could plausibly reach. */
export function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      // Skip link-local and the RFC 2544 benchmarking range that VPN clients
      // such as Tailscale/utun devices publish; they are not reachable peers.
      if (iface.address.startsWith("169.254.")) continue;
      if (iface.address.startsWith("198.18.") || iface.address.startsWith("198.19.")) continue;
      out.push(iface.address);
    }
  }
  return out;
}
