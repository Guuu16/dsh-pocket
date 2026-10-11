/**
 * dsh-remote's own settings, stored beside the dsh home.
 *
 * Kept out of the Cordis row config on purpose: the user edits these from the
 * plugin's own page while the process is running, so they must be readable and
 * writable at runtime rather than frozen into the composed profile.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory holding the plugin's durable state.
 *
 * The plugin used to be called dsh-pocket and kept its state in
 * `~/.dsh-pocket`. That directory is adopted once when the new one does not
 * exist yet, so a rename never costs the user their configured relay.
 */
export function storeHome() {
  if (typeof process.env.DSH_REMOTE_HOME === "string" && process.env.DSH_REMOTE_HOME !== "") {
    return process.env.DSH_REMOTE_HOME;
  }
  const current = join(homedir(), ".dsh-remote");
  const legacy = join(homedir(), ".dsh-pocket");
  if (existsSync(current)) return current;
  if (existsSync(legacy)) {
    try {
      renameSync(legacy, current);
      return current;
    } catch {
      // A rename can fail across devices or on permissions; fall back to
      // reading the legacy directory in place rather than starting empty.
      return legacy;
    }
  }
  return current;
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
    // Persist it now. `defaults()` mints a fresh key on every call, so a store
    // read without a key would hand each request a different secret and no
    // device could ever pair.
    try {
      mkdirSync(storeHome(), { recursive: true, mode: 0o700 });
      writeFileSync(storePath(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
    } catch {
      // Read-only home: keep the in-memory key and let authorization fail loudly.
    }
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
