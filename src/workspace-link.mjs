/**
 * Register discovered projects with the dsh GUI's workspace store.
 *
 * The GUI lists only workspaces it has opened before, so a project whose
 * sessions were created from a terminal never appears there. This module
 * merges the projects found under `~/.dsh/sessions` into
 * `~/.dsh/storages/workspace.json`, additively and idempotently, behind a
 * timestamped backup.
 *
 * The store is read once at startup by a running dsh process and is not
 * watched, so the write takes effect the next time dsh boots.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dshHome } from "./dsh.mjs";

/** Absolute path of the GUI workspace store. */
export function workspaceStorePath() {
  return join(dshHome(), "storages", "workspace.json");
}

function readStore() {
  const path = workspaceStorePath();
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || typeof parsed.tables !== "object") {
    throw new Error(`${path} is not a dsh workspace store`);
  }
  if (parsed.tables.workspaces === undefined) parsed.tables.workspaces = {};
  if (parsed.global === undefined) parsed.global = {};
  if (!Array.isArray(parsed.global.workspaceIds)) parsed.global.workspaceIds = [];
  return parsed;
}

/**
 * Compute what linking would add, without writing anything.
 *
 * @param {Array<{path: string, name: string, sessions: object[]}>} projects
 * @returns {{add: object[], extend: object[], store: object}}
 */
export function planLink(projects) {
  const store = readStore();
  const existing = Object.values(store.tables.workspaces);
  const byPath = new Map(existing.map((workspace) => [workspace.path, workspace]));

  const add = [];
  const extend = [];

  for (const project of projects) {
    const sessionIds = project.sessions.map((session) => session.sessionId);
    const current = byPath.get(project.path);
    if (current === undefined) {
      add.push({ path: project.path, title: project.name, sessionIds });
      continue;
    }
    const known = new Set(Array.isArray(current.sessionIds) ? current.sessionIds : []);
    const missing = sessionIds.filter((id) => known.has(id) === false);
    if (missing.length > 0) extend.push({ path: project.path, title: current.title ?? project.name, missing });
  }

  return { add, extend, store };
}

/**
 * Merge the plan into the workspace store.
 *
 * @param {ReturnType<typeof planLink>} plan
 * @returns {{backup: string, added: number, extended: number}}
 */
export function applyLink(plan) {
  const path = workspaceStorePath();
  const before = statSync(path);
  const store = plan.store;
  const now = new Date().toISOString();

  for (const entry of plan.add) {
    const id = randomUUID();
    store.tables.workspaces[id] = {
      path: entry.path,
      title: entry.title,
      sessionIds: entry.sessionIds,
      createdAt: now,
      updatedAt: now,
    };
    store.global.workspaceIds.push(id);
  }

  for (const entry of plan.extend) {
    const workspace = Object.values(store.tables.workspaces)
      .find((candidate) => candidate.path === entry.path);
    if (workspace === undefined) continue;
    workspace.sessionIds = [...(workspace.sessionIds ?? []), ...entry.missing];
    workspace.updatedAt = now;
  }

  // Refuse to clobber a store another writer touched since the plan was built.
  const after = statSync(path);
  if (after.mtimeMs !== before.mtimeMs) {
    throw new Error("workspace store changed while planning; run the link again");
  }

  const backup = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backup);
  if (existsSync(backup) === false) throw new Error(`could not write backup ${backup}`);
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");

  return { backup, added: plan.add.length, extended: plan.extend.length };
}

/** How many discovered projects the GUI does not know about yet. */
export function countUnlinked(projects) {
  try {
    const store = readStore();
    const known = new Set(Object.values(store.tables.workspaces).map((workspace) => workspace.path));
    return projects.filter((project) => known.has(project.path) === false).length;
  } catch {
    return 0;
  }
}

/** Human-readable summary of the store's current contents. */
export function describeStore() {
  try {
    const store = readStore();
    return Object.values(store.tables.workspaces).map((workspace) => ({
      path: workspace.path,
      title: workspace.title ?? basename(workspace.path),
      sessions: (workspace.sessionIds ?? []).length,
    }));
  } catch {
    return [];
  }
}
