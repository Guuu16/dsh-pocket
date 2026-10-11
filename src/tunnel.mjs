/**
 * Public reachability through an SSH reverse tunnel.
 *
 * A home machine behind NAT cannot be dialled from a phone on cellular: there
 * is no public address to dial. The fix is to invert the direction — the
 * machine dials *out* to a host that does have a public address, and asks it to
 * forward a port back down the connection it opened. That is exactly how the
 * WeChat/Feishu bridge shape works too: the reachable party is the relay, and
 * the local machine is always the one initiating.
 *
 * `ssh -R` is the cheapest relay there is: no daemon, no package, no cloud
 * account, just the client macOS already ships. This module keeps that tunnel
 * alive across network changes and remote restarts.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/** Delay before re-dialling after the tunnel drops, in milliseconds. */
const RETRY_MS = 5000;

function sshPath() {
  // Honour an explicit client (a Homebrew ssh, sshpass wrapper, or a test stub).
  if (typeof process.env.DSH_REMOTE_SSH === "string" && process.env.DSH_REMOTE_SSH !== "") {
    return process.env.DSH_REMOTE_SSH;
  }
  for (const candidate of ["/usr/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known location.
    }
  }
  return "ssh";
}

/**
 * Run a supervised reverse tunnel: `remotePort` on the relay forwards to
 * `127.0.0.1:localPort` here.
 *
 * @param {{
 *   target: string,
 *   remotePort: number,
 *   localPort: number,
 *   onStatus?: (event: {kind: string, detail?: string}) => void,
 *   retryMs?: number,
 * }} options
 * @returns {{stop: () => void, spec: string}}
 */
export function startTunnel(options) {
  const { target, remotePort, localPort } = options;
  const retryMs = options.retryMs ?? RETRY_MS;

  // `-N` no command, `-T` no tty, `ExitOnForwardFailure` so a refused port is
  // an error instead of a silently useless session, keepalives so a dead path
  // is noticed instead of hanging.
  const args = [
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new",
    "-R", `${remotePort}:127.0.0.1:${localPort}`,
    target,
  ];

  let child;
  let stopped = false;
  let timer;
  let settle;

  const launch = () => {
    if (stopped) return;
    child = spawn(sshPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    options.onStatus?.({ kind: "dialing", detail: `${target} → :${remotePort}` });

    // `ExitOnForwardFailure=yes` makes ssh exit immediately when the forward is
    // refused, so a session that is still alive after a moment has the port.
    // Without this, callers could only report "up" optimistically — a tunnel
    // that never came up would look identical to one that did.
    settle = setTimeout(() => {
      if (stopped || child === undefined) return;
      options.onStatus?.({ kind: "established", detail: `${remotePort} → 127.0.0.1:${localPort}` });
    }, 2500);
    settle.unref?.();

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
      const line = String(chunk).trim();
      if (line !== "") options.onStatus?.({ kind: "log", detail: line });
      if (/remote port forwarding failed|Address already in use/i.test(line)) {
        options.onStatus?.({ kind: "forward-refused", detail: line });
      }
    });

    child.on("error", (error) => {
      clearTimeout(settle);
      options.onStatus?.({ kind: "error", detail: error.message });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(settle);
      child = undefined;
      if (stopped) return;
      options.onStatus?.({
        kind: "dropped",
        detail: `ssh exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
      });
      timer = setTimeout(launch, retryMs);
      timer.unref?.();
    });
  };

  launch();

  return {
    spec: `${target}:${remotePort} → 127.0.0.1:${localPort}`,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      child?.kill("SIGTERM");
    },
  };
}

/**
 * Parse `[user@]host[:sshPort]`.
 *
 * @param {string} spec
 * @returns {{target: string, host: string} | undefined}
 */
export function parseTunnelSpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (trimmed === "") return undefined;
  const host = trimmed.includes("@") ? trimmed.slice(trimmed.indexOf("@") + 1) : trimmed;
  return { target: trimmed, host: host.split(":")[0] };
}
