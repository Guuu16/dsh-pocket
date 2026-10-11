/**
 * Public reachability through a Cloudflare quick tunnel.
 *
 * This is the answer to "any machine, any network, no setup": cloudflared opens
 * an *outbound* connection to Cloudflare's edge and receives a public HTTPS
 * hostname back. No port forwarding, no public IP, no security-group change,
 * no account — which is exactly why it works on a laptop behind home NAT.
 *
 * Cost: traffic is relayed by Cloudflare, and the assigned hostname is random
 * and changes whenever the tunnel restarts. The gateway's own access key stays
 * the authentication boundary.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Where a downloaded cloudflared is cached. */
export function cloudflaredHome() {
  return process.env.DSH_REMOTE_CF_HOME ?? join(homedir(), ".dsh-remote", "bin");
}

const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

function assetFor(platform, arch) {
  if (platform === "darwin") return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  if (platform === "linux") return arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
  if (platform === "win32") return "cloudflared-windows-amd64.exe";
  return undefined;
}

/** Resolve an existing cloudflared, or undefined. */
export function findCloudflared() {
  if (typeof process.env.DSH_REMOTE_CLOUDFLARED === "string" && process.env.DSH_REMOTE_CLOUDFLARED !== "") {
    return process.env.DSH_REMOTE_CLOUDFLARED;
  }
  const cached = join(cloudflaredHome(), process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(cached)) return cached;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, "cloudflared");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Download cloudflared once into the gateway's own directory.
 *
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<string>} absolute path to the binary.
 */
export async function ensureCloudflared(onProgress = () => {}) {
  const existing = findCloudflared();
  if (existing !== undefined) return existing;

  const asset = assetFor(process.platform, process.arch);
  if (asset === undefined) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`);

  const dir = cloudflaredHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const url = `${RELEASE_BASE}/${asset}`;
  onProgress(`downloading cloudflared (${asset}) …`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  if (asset.endsWith(".tgz")) {
    const staging = join(dir, "cloudflared.tgz");
    writeFileSync(staging, bytes);
    // `tar` ships with macOS and every mainstream Linux.
    execFileSync("tar", ["xzf", staging, "-C", dir], { stdio: "ignore" });
    unlinkSync(staging);
  } else {
    writeFileSync(target, bytes);
  }
  chmodSync(target, 0o755);
  onProgress(`cloudflared ready at ${target}`);
  return target;
}

/**
 * Run a supervised quick tunnel against the local gateway.
 *
 * @param {{
 *   localPort: number,
 *   binary?: string,
 *   onUrl?: (url: string) => void,
 *   onStatus?: (event: {kind: string, detail?: string}) => void,
 *   retryMs?: number,
 * }} options
 * @returns {{stop: () => void}}
 */
export function startQuickTunnel(options) {
  const { localPort } = options;
  const binary = options.binary ?? findCloudflared();
  if (binary === undefined) throw new Error("cloudflared is not available; run ensureCloudflared() first");

  const retryMs = options.retryMs ?? 5000;
  const args = ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"];
  let child;
  let stopped = false;
  let timer;
  let lastUrl;

  const launch = () => {
    if (stopped) return;
    child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    options.onStatus?.({ kind: "dialing", detail: "requesting a trycloudflare hostname" });

    let buffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
      if (match !== null && match[0] !== lastUrl) {
        lastUrl = match[0];
        options.onUrl?.(match[0]);
      }
      const tail = String(chunk).trim();
      if (/error|failed|unable/i.test(tail)) options.onStatus?.({ kind: "log", detail: tail.slice(-300) });
    });

    child.on("error", (error) => options.onStatus?.({ kind: "error", detail: error.message }));
    child.on("exit", (code) => {
      child = undefined;
      if (stopped) return;
      options.onStatus?.({ kind: "dropped", detail: `cloudflared exited (code ${code ?? "null"})` });
      timer = setTimeout(launch, retryMs);
      timer.unref?.();
    });
  };

  launch();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      child?.kill("SIGTERM");
    },
  };
}

/** Best-effort size report for the cached binary, used by --status output. */
export function cloudflaredInfo() {
  const binary = findCloudflared();
  if (binary === undefined) return undefined;
  try {
    return { path: binary, bytes: statSync(binary).size };
  } catch {
    return undefined;
  }
}

/** List cached downloads, for diagnostics. */
export function cachedArtifacts() {
  try {
    return readdirSync(cloudflaredHome());
  } catch {
    return [];
  }
}
