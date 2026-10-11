/**
 * Server-rendered mobile pages.
 *
 * Every page is plain HTML with no client framework: the phone renders it on
 * first paint, and the only script is a list filter. Markdown from assistant
 * messages is rendered by a small allow-list renderer rather than a parser
 * dependency, so transcripts stay readable without pulling a bundle.
 */

import { homedir } from "node:os";
import { basename } from "node:path";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML text and attribute positions. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

/** Shorten an absolute path under the home directory to `~/…`. */
export function prettyPath(path) {
  const home = homedir();
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/gu, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/gu, '<a href="$2" rel="noreferrer">$1</a>');
}

/**
 * Render a conservative Markdown subset: fenced code, headings, lists,
 * quotes, and inline emphasis. Anything else stays literal text.
 *
 * @param {string} source - message text.
 * @returns {string} HTML.
 */
export function renderMarkdown(source) {
  const lines = String(source ?? "").split("\n");
  const out = [];
  let inFence = false;
  let listKind;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listKind !== undefined) {
      out.push(`</${listKind}>`);
      listKind = undefined;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```/u);
    if (fence !== null) {
      if (inFence) {
        out.push("</code></pre>");
        inFence = false;
      } else {
        flushParagraph();
        closeList();
        out.push("<pre><code>");
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      out.push(escapeHtml(line));
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/u);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/u);
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const want = bullet !== null ? "ul" : "ol";
      if (listKind !== want) {
        closeList();
        out.push(`<${want}>`);
        listKind = want;
      }
      out.push(`<li>${inline((bullet ?? ordered)[1])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/u);
    if (quote !== null) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  if (inFence) out.push("</code></pre>");
  return out.join("\n");
}

/** Human-readable relative time for list rows. */
export function relativeTime(milliseconds) {
  if (typeof milliseconds !== "number" || Number.isNaN(milliseconds)) return "";
  const delta = Date.now() - milliseconds;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** Absolute local timestamp for detail views. */
export function absoluteTime(milliseconds) {
  if (typeof milliseconds !== "number" || Number.isNaN(milliseconds)) return "";
  const date = new Date(milliseconds);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function page(options) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0c10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/pocket.webmanifest">
<link rel="icon" href="/pocket.svg" type="image/svg+xml">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="/pocket.css">
</head>
<body>
<div class="shell">
<header class="topbar">
${options.back === undefined ? "" : `<a class="iconbtn" href="${escapeHtml(options.back)}">‹</a>`}
<h1>${escapeHtml(options.heading)}${options.subheading === undefined ? "" : `<span class="sub">${escapeHtml(options.subheading)}</span>`}</h1>
${options.actions ?? ""}
</header>
${options.body}
</div>
<script src="/pocket.js" defer></script>
</body>
</html>`;
}

const GUI_BUTTON = '<a class="iconbtn primary" href="/gui/" target="_self">GUI</a>';

/**
 * Project index page.
 *
 * @param {{projects: object[], dsh: object, accessKey: string}} input
 */
export function renderHome(input) {
  const { projects, dsh } = input;
  const totalSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const live = projects.reduce(
    (sum, project) => sum + project.sessions.filter((session) => session.live).length,
    0,
  );

  const cards = projects
    .map((project) => {
      const newest = project.sessions[0];
      const running = project.sessions.filter((session) => session.live).length;
      return `<a class="card" href="/p/${project.key}" data-search="${escapeHtml(`${project.name} ${project.path}`)}">
  <div class="row1">
    <span class="name">${escapeHtml(project.name)}</span>
    <span class="when">${escapeHtml(relativeTime(project.updatedAt))}</span>
  </div>
  <div class="path">${escapeHtml(prettyPath(project.path))}</div>
  <div class="meta">
    <span class="chip">${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"}</span>
    ${running > 0 ? `<span class="chip live">● live</span>` : ""}
    ${newest?.model === undefined ? "" : `<span class="chip">${escapeHtml(newest.model)}</span>`}
  </div>
  ${newest?.title === undefined && newest?.preview === undefined ? "" : `<div class="preview">${escapeHtml(newest.title ?? newest.preview ?? "")}</div>`}
</a>`;
    })
    .join("\n");

  const body = `
<a class="card entry" href="/gui/">
  <div class="row1"><span class="name">Open the full dsh GUI →</span></div>
  <div class="preview">Live runtime: send prompts, run tools, open any workspace. Best on a tablet or landscape.</div>
</a>
${input.unlinked > 0 ? `<a class="card entry" href="/link"><div class="row1"><span class="name">Register ${input.unlinked} project${input.unlinked === 1 ? "" : "s"} in the GUI →</span></div><div class="preview">The GUI only lists workspaces it has opened before. This copies the missing ones into its workspace store (backed up first).</div></a>` : ""}
<input class="search" type="search" placeholder="Filter projects…" id="filter" autocomplete="off">
<div class="section-label" data-base="Projects · ${projects.length}">Projects · ${projects.length}</div>
${projects.length === 0 ? '<div class="empty">No dsh history found under <code>$DSH_HOME/sessions</code>.</div>' : cards}
<div class="footer">
  ${totalSessions} sessions · ${live} live · dsh web at <code>${escapeHtml(dsh.authority)}</code><br>
  History is read from <code>~/.dsh/sessions</code> · GUI reversed-proxied at <a href="/gui/">/gui/</a>
</div>`;

  return page({
    title: "dsh pocket",
    heading: "dsh pocket",
    subheading: `${projects.length} projects · ${totalSessions} sessions`,
    actions: GUI_BUTTON,
    body,
  });
}

/** One project's session list. */
export function renderProject(input) {
  const { project } = input;
  const rows = project.sessions
    .map((session) => {
      const label = session.title ?? session.preview ?? "(untitled session)";
      return `<a class="card" href="/s/${encodeURIComponent(session.sessionId)}" data-search="${escapeHtml(`${label} ${session.sessionId}`)}">
  <div class="row1">
    <span class="name">${escapeHtml(label.length > 90 ? label.slice(0, 90) + "…" : label)}</span>
    <span class="when">${escapeHtml(relativeTime(session.updatedAt))}</span>
  </div>
  <div class="meta">
    ${session.live ? '<span class="chip live">● live</span>' : ""}
    <span class="chip">${session.userTurns} prompt${session.userTurns === 1 ? "" : "s"}</span>
    ${session.model === undefined ? "" : `<span class="chip">${escapeHtml(session.model)}</span>`}
    ${session.agentPreset === undefined ? "" : `<span class="chip">${escapeHtml(session.agentPreset)}</span>`}
    <span class="chip">${escapeHtml(formatBytes(session.bytes))}</span>
    ${session.truncated ? '<span class="chip">indexed head</span>' : ""}
  </div>
  <div class="path">${escapeHtml(session.sessionId)}</div>
</a>`;
    })
    .join("\n");

  return page({
    title: project.name,
    heading: project.name,
    subheading: prettyPath(project.path),
    back: "/",
    actions: GUI_BUTTON,
    body: `
<input class="search" type="search" placeholder="Filter sessions…" id="filter" autocomplete="off">
<div class="section-label">Sessions · ${project.sessions.length}</div>
${rows}
<div class="footer">
  Started ${escapeHtml(absoluteTime(project.sessions.at(-1)?.createdAt ?? 0))} ·
  last activity ${escapeHtml(relativeTime(project.updatedAt))}<br>
  To keep working in this project, open the GUI or <code>cd ${escapeHtml(project.path)}</code> and resume the session.
</div>`,
  });
}

function timelineEntry(entry) {
  if (entry.kind === "user") {
    if (entry.injected === true) {
      return `<details class="injected"><summary>context injected by the harness · ${entry.text.length} chars</summary><div class="inner">${escapeHtml(entry.text)}</div></details>`;
    }
    return `<article class="turn user">
  <div class="who">You <span class="badge">${escapeHtml(absoluteTime(entry.time))}</span></div>
  <div class="body">${renderMarkdown(entry.text)}</div>
</article>`;
  }

  if (entry.kind === "assistant") {
    const thinking = entry.thinking === undefined || entry.thinking === ""
      ? ""
      : `<details class="think"><summary>thinking · ${entry.thinking.length} chars</summary><div class="inner">${escapeHtml(entry.thinking)}</div></details>`;
    return `<article class="turn assistant">
  <div class="who">${escapeHtml(entry.model ?? "agent")}${entry.usage === undefined ? "" : `<span class="badge">${entry.usage.inputTokens ?? 0} in / ${entry.usage.outputTokens ?? 0} out</span>`}</div>
  <div class="body">${renderMarkdown(entry.text)}</div>
  ${thinking}
</article>`;
  }

  if (entry.kind === "tool") {
    const args = entry.arguments === undefined ? "" : JSON.stringify(entry.arguments, null, 2);
    const result = entry.result ?? "(no output)";
    return `<article class="turn tool">
  <div class="who">${escapeHtml(entry.name ?? "tool")}${entry.isError ? ' <span class="badge" style="color:var(--err)">error</span>' : ""}</div>
  ${args === "" ? "" : `<details><summary>input</summary><div class="inner">${escapeHtml(args)}</div></details>`}
  <details${result.length < 400 ? " open" : ""}><summary>output · ${result.length} chars</summary><div class="inner">${escapeHtml(result)}</div></details>
</article>`;
  }

  if (entry.kind === "system") {
    return `<details><summary style="justify-content:center">system message</summary><div class="inner">${escapeHtml(entry.text)}</div></details>`;
  }

  return `<div class="note">${escapeHtml(entry.text)}</div>`;
}

/** One session transcript. */
export function renderSession(input) {
  const { session, project, timeline } = input;
  const heading = session.title ?? project.name;
  const omitted = input.omitted ?? 0;
  const body = timeline.entries.length === 0
    ? '<div class="empty">This session has no rendered messages yet.</div>'
    : timeline.entries.map(timelineEntry).join("\n");

  const older = omitted === 0
    ? ""
    : `<a class="card entry" href="/s/${encodeURIComponent(session.sessionId)}?full=1">
  <div class="row1"><span class="name">Load ${omitted} earlier entr${omitted === 1 ? "y" : "ies"} →</span></div>
  <div class="preview">This log is long; the newest entries are shown first.</div>
</a>`;

  return page({
    title: heading,
    heading,
    subheading: `${project.name} · ${timeline.entries.length + omitted} entries`,
    back: `/p/${project.key}`,
    actions: GUI_BUTTON,
    body: `
<div class="footer" style="margin-top:10px">
  <code>${escapeHtml(session.sessionId)}</code><br>
  started ${escapeHtml(absoluteTime(session.createdAt))} · last activity ${escapeHtml(relativeTime(session.updatedAt))} ·
  ${escapeHtml(formatBytes(session.bytes))}${timeline.truncated ? " · showing the head of a large log" : ""}
</div>
${older}
${body}
<div class="footer">Continue this session: open <a href="/gui/">the GUI</a>, or in a terminal
<code>cd ${escapeHtml(project.path)} &amp;&amp; dsh --profile desktop headless --session-id ${escapeHtml(session.sessionId)} "…"</code></div>`,
  });
}

/**
 * Confirmation page for registering discovered projects with the GUI.
 *
 * @param {{plan: {add: object[], extend: object[]}, known: object[], storePath: string}} input
 */
export function renderLink(input) {
  const { plan, known, storePath } = input;
  const rows = plan.add
    .map((entry) => `<div class="card"><div class="row1"><span class="name">${escapeHtml(basename(entry.path))}</span>
      <span class="when">${entry.sessionIds.length} session${entry.sessionIds.length === 1 ? "" : "s"}</span></div>
      <div class="path">${escapeHtml(prettyPath(entry.path))}</div></div>`)
    .join("\n");
  const extendRows = plan.extend
    .map((entry) => `<div class="card"><div class="row1"><span class="name">${escapeHtml(entry.title)}</span>
      <span class="when">+${entry.missing.length} session${entry.missing.length === 1 ? "" : "s"}</span></div>
      <div class="path">${escapeHtml(prettyPath(entry.path))}</div></div>`)
    .join("\n");

  const nothing = plan.add.length === 0 && plan.extend.length === 0;

  return page({
    title: "dsh pocket · register projects",
    heading: "Register projects",
    subheading: "into the GUI workspace store",
    back: "/",
    actions: "",
    body: `
<div class="section-label">Will be added · ${plan.add.length}</div>
${plan.add.length === 0 ? '<div class="empty">Every discovered project is already registered.</div>' : rows}
${plan.extend.length === 0 ? "" : `<div class="section-label">Will gain history · ${plan.extend.length}</div>${extendRows}`}
<div class="section-label">Already in the GUI · ${known.length}</div>
${known.map((entry) => `<div class="card"><div class="row1"><span class="name">${escapeHtml(entry.title)}</span><span class="when">${entry.sessions} session${entry.sessions === 1 ? "" : "s"}</span></div><div class="path">${escapeHtml(prettyPath(entry.path))}</div></div>`).join("\n")}
${nothing ? "" : `<form method="post" action="/link" style="margin-top:16px">
  <button class="iconbtn primary" type="submit" style="width:100%;height:48px;font-size:15px">Write ${plan.add.length + plan.extend.length} change${plan.add.length + plan.extend.length === 1 ? "" : "s"} (with backup)</button>
</form>`}
<div class="footer">
  Store: <code>${escapeHtml(storePath)}</code><br>
  A running dsh reads this file once at boot, so restart the dsh desktop app to see the projects in the GUI side panel.
  The file is backed up before every write and changes are additive.
</div>`,
  });
}

/** Result page for a completed link. */
export function renderLinkDone(input) {
  return page({
    title: "dsh pocket · registered",
    heading: "Projects registered",
    subheading: `${input.added} added · ${input.extended} extended`,
    back: "/",
    actions: '<a class="iconbtn primary" href="/gui/">GUI</a>',
    body: `
<div class="empty">
  Written to the workspace store.<br>
  Restart the dsh desktop app, then the side panel lists every project.<br><br>
  Backup: <code>${escapeHtml(input.backup)}</code>
</div>`,
  });
}

/** Pre-auth landing page: one button that plants the access cookie. */
export function renderUnlock(input) {
  return page({
    title: "dsh pocket · unlock",
    heading: "dsh pocket",
    subheading: "access key required",
    actions: "",
    body: `
<div class="empty">
  Add <code>?k=&lt;access-key&gt;</code> to this URL once. The gateway then keeps an
  HttpOnly cookie on this phone for ${input.days} days.
</div>
<div class="footer">Access key file: <code>${escapeHtml(input.configPath)}</code></div>`,
  });
}

/** Fatal startup error page. */
export function renderFault(input) {
  return page({
    title: "dsh pocket · error",
    heading: "dsh pocket",
    subheading: "not connected",
    actions: "",
    body: `<div class="empty">${escapeHtml(input.message)}</div>`,
  });
}
