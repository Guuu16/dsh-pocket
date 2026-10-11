/**
 * dsh-pocket's own settings, stored beside the dsh home.
 *
 * Kept out of the Cordis row config on purpose: the user edits these from the
 * plugin's own page while the process is running, so they must be readable and
 * writable at runtime rather than frozen into the composed profile.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding the plugin's durable state. */
export function storeHome() {
  return process.env.DSH_POCKET_HOME ?? join(homedir(), ".dsh-pocket");
}

/** Absolute path of the settings file. */
export function storePath() {
  return join(storeHome(), "config.json");
}

/** Shape written on first use. */
function defaults() {
  return {
    enabled: true,
    host: "0.0.0.0",
    port: 8787,
    accessKey: randomBytes(32).toString("base64url"),
    cookieDays: 30,
    relay: {
      mode: "off",
      host: "",
      user: "",
      sshPort: 22,
      remotePort: 8787,
      password: "",
    },
  };
}

/** Read settings, filling in anything absent. */
export function readStore() {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    stored = {};
  }
  const base = defaults();
  const merged = {
    ...base,
    ...stored,
    relay: { ...base.relay, ...(stored.relay ?? {}) },
  };
  if (typeof merged.accessKey !== "string" || merged.accessKey.length < 16) {
    merged.accessKey = base.accessKey;
  }
  return merged;
}

/**
 * Merge a change into the settings file.
 *
 * @param {object} patch - top-level fields to merge; `relay` merges one level deep.
 * @returns {object} the stored settings after the write.
 */
export function writeStore(patch) {
  const current = readStore();
  const next = {
    ...current,
    ...patch,
    relay: { ...current.relay, ...(patch.relay ?? {}) },
  };
  mkdirSync(storeHome(), { recursive: true, mode: 0o700 });
  writeFileSync(storePath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** Issue a fresh access key, unpairing every device. */
export function rotateAccessKey() {
  return writeStore({ accessKey: randomBytes(32).toString("base64url") });
}
