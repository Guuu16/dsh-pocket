/**
 * One-time SSH provisioning for the relay host.
 *
 * "Type a username and password and it just works" means the plugin must be
 * able to reach a relay that has never seen this machine's key. The portable
 * way to do that without adding a dependency is `ssh-copy-id` driven by
 * `expect`, which ships with macOS and is one `apt` away on Linux. After that
 * first deployment the password is never needed again — the tunnel runs on the
 * key, which is also why the stored password can be cleared afterwards.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Public keys to try, in preference order. */
function candidateKeys() {
  const ssh = join(homedir(), ".ssh");
  return ["id_ed25519.pub", "id_rsa.pub"].map((name) => join(ssh, name)).filter((path) => existsSync(path));
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    // expect has its own 45s timeout, but it can still wedge (no tty, a prompt
    // that never matches). Bound the whole call so the settings request returns.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: -1, out, err: (err || out) + "\n[timed out after 90s]" });
    }, 90_000);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => done({ code: -1, out, err: error.message }));
    child.on("close", (code) => done({ code, out, err }));
  });
}

/**
 * Wrap a value for Tcl in `spawn`.
 *
 * The relay host, user and key path come from user input and land inside an
 * expect script; a `"` or `[` there would change what expect executes.
 * Braces make Tcl treat the whole thing as one literal word.
 */
function tclWord(value) {
  return `{${String(value).replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}")}}`;
}

function sshArgs(target, sshPort) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
  if (Number.isFinite(sshPort) && sshPort !== 22) args.push("-p", String(sshPort));
  args.push(target);
  return args;
}

/**
 * Whether key-based login already works.
 *
 * @param {string} target - `user@host`.
 * @param {number} sshPort
 * @returns {Promise<boolean>}
 */
export async function canLoginWithKey(target, sshPort = 22) {
  const result = await run("ssh", [...sshArgs(target, sshPort), "true"]);
  return result.code === 0;
}

/**
 * Install this machine's public key on the relay using its password once.
 *
 * @param {{target: string, sshPort?: number, password: string}} options
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function deployPublicKey(options) {
  const { target, password } = options;
  const sshPort = options.sshPort ?? 22;
  const key = candidateKeys()[0];
  if (key === undefined) {
    return { ok: false, detail: "no public key found in ~/.ssh (expected id_ed25519.pub or id_rsa.pub)" };
  }
  if (typeof password !== "string" || password === "") {
    return { ok: false, detail: "no password supplied and key login failed" };
  }

  const script = `
set timeout 45
spawn ssh-copy-id -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 ${sshPort === 22 ? "" : `-p ${Number(sshPort)} `}-i ${tclWord(key)} ${tclWord(target)}
expect {
  -re "(?i)password:" { send "$env(DSH_REMOTE_SSH_PASSWORD)\\r"; exp_continue }
  -re "(?i)yes/no" { send "yes\\r"; exp_continue }
  eof
}
`;

  const result = await run("/usr/bin/expect", ["-c", script], {
    env: { ...process.env, DSH_REMOTE_SSH_PASSWORD: password },
  });

  if (result.code !== 0) {
    const detail = (result.err || result.out).trim().split("\n").slice(-2).join(" ");
    return { ok: false, detail: detail === "" ? `expect exited ${result.code}` : detail };
  }

  // ssh-copy-id succeeding does not prove the key is usable for a non-interactive
  // session (permissions, ForceCommand); verify before reporting success.
  const verified = await canLoginWithKey(target, sshPort);
  return verified
    ? { ok: true, detail: `installed ${key} on ${target}` }
    : { ok: false, detail: "key installed but a key-only login still fails (check ~/.ssh permissions or ForceCommand)" };
}

/**
 * Make key-only login work, deploying the key when a password is available.
 *
 * @param {{target: string, sshPort?: number, password?: string}} options
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function ensureKeyLogin(options) {
  if (await canLoginWithKey(options.target, options.sshPort)) {
    return { ok: true, detail: "existing key accepted" };
  }
  return deployPublicKey({
    target: options.target,
    sshPort: options.sshPort,
    password: options.password ?? "",
  });
}
