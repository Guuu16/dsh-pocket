/**
 * Index of every dsh project and session on this machine, plus transcript
 * projection for one session log.
 *
 * The index is built from `$DSH_HOME/sessions`, which is the only place dsh
 * records history: one directory per working directory, one directory per
 * session inside it. The authoritative working directory is the `cwd` field of
 * the session header, never the (lossy) encoded directory name.
 *
 * Summaries are read from the head of each log only, so listing stays cheap
 * even with hundreds of sessions; the full transcript is decoded on demand.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseJsonLines, readFrames } from "./zstd-frames.mjs";
import { sessionsRoot } from "./dsh.mjs";

/** Bytes of each log read while summarizing. */
const SUMMARY_HEAD_BYTES = 1 << 20;
/** A session touched within this window is reported as live. */
const LIVE_WINDOW_MS = 120_000;

function logFilesIn(sessionDir) {
  let names;
  try {
    names = readdirSync(sessionDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("session.") && name.includes(".jsonl"))
    .map((name) => join(sessionDir, name));
}

function readHead(path, bytes) {
  const handle = readFileSync(path);
  const slice = handle.byteLength > bytes ? handle.subarray(0, bytes) : handle;
  if (path.endsWith(".zstd")) {
    return readFrames(slice, { maxBytes: bytes }).text;
  }
  return slice.toString("utf8");
}

function firstText(content) {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") return block.text;
  }
  return "";
}

/**
 * Summarize one session directory.
 *
 * @param {string} sessionDir - absolute session directory.
 * @returns {object | undefined} summary, or undefined when the log is unreadable.
 */
export function summarizeSession(sessionDir) {
  const logs = logFilesIn(sessionDir);
  if (logs.length === 0) return undefined;
  const logPath = logs.sort().at(-1);

  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return undefined;
  }

  let records;
  try {
    records = parseJsonLines(readHead(logPath, SUMMARY_HEAD_BYTES));
  } catch {
    return undefined;
  }

  const header = records.find((row) => row?.type === "session");
  if (header === undefined) return undefined;

  let title;
  let preview;
  let model;
  let userTurns = 0;
  let lastTime = header.createdAt ?? stat.mtimeMs;

  for (const row of records) {
    if (typeof row?.time === "number") lastTime = row.time;
    if (row?.type === "session/title" && typeof row.data?.title === "string" && row.data.title !== "") {
      title = row.data.title;
    }
    if (preview === undefined && row?.type === "user/message") {
      const text = firstText(row.data?.content).trim();
      if (text !== "") preview = text;
    }
    if (row?.type === "user/message") userTurns += 1;
    if (model === undefined && row?.type === "request/context" && typeof row.data?.model === "string") {
      model = row.data.model;
    }
  }

  return {
    sessionId: header.id,
    sessionDir,
    logPath,
    cwd: header.cwd,
    agentPreset: header.agentPreset,
    origin: header.origin,
    parentSession: header.parentSession,
    createdAt: header.createdAt ?? stat.birthtimeMs,
    updatedAt: stat.mtimeMs,
    bytes: stat.size,
    title,
    preview,
    userTurns,
    model,
    lastEventTime: lastTime,
    live: Date.now() - stat.mtimeMs < LIVE_WINDOW_MS,
    truncated: stat.size > SUMMARY_HEAD_BYTES,
  };
}

/**
 * List every project that has recorded history, newest activity first.
 *
 * @param {{includeSubagent?: boolean}} [options]
 * @returns {Array<{key: string, path: string, name: string, sessions: object[], updatedAt: number}>}
 */
export function listProjects(options = {}) {
  const root = sessionsRoot();
  let projectDirs;
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }

  const byPath = new Map();

  for (const projectDir of projectDirs) {
    let sessionDirs;
    try {
      sessionDirs = readdirSync(projectDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projectDir, entry.name));
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const summary = summarizeSession(sessionDir);
      if (summary === undefined) continue;
      if (summary.cwd === undefined) continue;
      if (summary.origin === "subagent" && options.includeSubagent !== true) continue;
      const path = summary.cwd;
      if (byPath.has(path) === false) {
        byPath.set(path, {
          key: encodeURIComponent(path),
          path,
          name: basename(path) || path,
          sessions: [],
          updatedAt: 0,
        });
      }
      const project = byPath.get(path);
      project.sessions.push(summary);
      project.updatedAt = Math.max(project.updatedAt, summary.updatedAt);
    }
  }

  const projects = [...byPath.values()];
  for (const project of projects) {
    project.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }
  projects.sort((left, right) => right.updatedAt - left.updatedAt);
  return projects;
}

/** Find one session by id across every project. */
export function findSession(sessionId) {
  for (const project of listProjects()) {
    const hit = project.sessions.find((session) => session.sessionId === sessionId);
    if (hit !== undefined) return { project, session: hit };
  }
  return undefined;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function thinkingOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && block.type === "thinking")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Read one full session log.
 *
 * @param {string} logPath - absolute log path.
 * @param {{maxBytes?: number}} [options]
 * @returns {{header: object | undefined, records: unknown[], truncated: boolean}}
 */
export function readLog(logPath, options = {}) {
  const bytes = readFileSync(logPath);
  const decoded = logPath.endsWith(".zstd")
    ? readFrames(bytes, { maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY })
    : { text: bytes.toString("utf8"), truncated: false };
  const records = parseJsonLines(decoded.text);
  return {
    header: records.find((row) => row?.type === "session"),
    records,
    truncated: decoded.truncated === true,
  };
}

/** Runtime-injected context that dsh stores as a user-role message. */
const INJECTED_PREFIXES = [
  "<system-reminder>",
  "<available_skills>",
  "<project_instructions>",
  "Current runtime context",
  "Current DSH file policy",
  "Approval requests are auto-granted",
];

function isInjectedContext(text) {
  return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Project a session event log into a compact, renderable timeline.
 *
 * Tool results are folded back into the call they answer, so one entry carries
 * both sides of every tool use. Harness-injected context blocks are flagged so
 * the reader can collapse them instead of scrolling past boilerplate.
 *
 * @param {unknown[]} records - parsed session records in seq order.
 * @returns {Array<object>} timeline entries.
 */
export function projectTimeline(records) {
  const entries = [];
  const pendingCalls = new Map();
  let title;

  for (const row of records) {
    if (row === null || typeof row !== "object") continue;
    const type = row.type;

    if (type === "session/title") {
      if (typeof row.data?.title === "string") title = row.data.title;
      continue;
    }

    if (type === "user/message") {
      const text = textOfContent(row.data?.content).trim();
      if (text === "") continue;
      entries.push({ kind: "user", time: row.time, text, injected: isInjectedContext(text) });
      continue;
    }

    if (type === "assistant/message") {
      const text = textOfContent(row.data?.message?.content).trim();
      const thinking = thinkingOfContent(row.data?.message?.content).trim();
      if (text === "" && thinking === "") continue;
      entries.push({
        kind: "assistant",
        time: row.time,
        text,
        thinking,
        model: row.data?.message?.source?.model,
        usage: row.data?.usage,
      });
      continue;
    }

    if (type === "tool/call") {
      let parsedArguments = row.data?.arguments;
      try {
        parsedArguments = JSON.parse(row.data?.arguments ?? "{}");
      } catch {
        // Non-JSON arguments are kept verbatim.
      }
      const entry = {
        kind: "tool",
        time: row.time,
        callId: row.data?.callId,
        name: row.data?.name,
        arguments: parsedArguments,
        result: undefined,
        isError: false,
      };
      entries.push(entry);
      if (typeof entry.callId === "string") pendingCalls.set(entry.callId, entry);
      continue;
    }

    if (type === "tool/result") {
      const callId = row.data?.toolCallId;
      const target = typeof callId === "string" ? pendingCalls.get(callId) : undefined;
      const text = textOfContent(row.data?.message?.content).trim();
      if (target !== undefined) {
        target.result = text;
        target.isError = row.data?.message?.isError === true;
      } else {
        entries.push({
          kind: "tool",
          time: row.time,
          name: "result",
          arguments: undefined,
          result: text,
          isError: row.data?.message?.isError === true,
        });
      }
      continue;
    }

    if (type === "system/message") {
      const text = textOfContent(row.data?.message?.content).trim();
      if (text !== "") entries.push({ kind: "system", time: row.time, text });
      continue;
    }

    if (type === "turn/end" && row.data?.reason?.kind && row.data.reason.kind !== "completed") {
      entries.push({ kind: "note", time: row.time, text: `turn ${row.data.reason.kind}` });
    }
  }

  return { title, entries };
}
