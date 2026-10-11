/**
 * The plugin's own settings page, served by the dsh web server on loopback.
 *
 * Deliberately server-rendered HTML with no client bundle: configuring the
 * relay is a rare, one-off action, and a plain form works identically in the
 * desktop GUI's browser tab and in a phone browser.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

const STYLE = `
:root { color-scheme: light dark;
  --bg:#ffffff; --panel:#f6f7f9; --line:#e3e6ec; --fg:#1b1f27; --dim:#697386;
  --accent:#4b6bfb; --ok:#1f9d55; --warn:#b7791f; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --panel:#161a21; --line:#252b36; --fg:#e7ebf3; --dim:#8b95a7; --accent:#6b8dff; --ok:#4ec98a; --warn:#e2b24a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
.wrap { max-width:720px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:28px 0 10px; }
.sub { color:var(--dim); font-size:13px; margin-bottom:22px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
.row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.k { color:var(--dim); font-size:12.5px; min-width:96px; }
.v { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; word-break:break-all; }
label { display:block; font-size:13px; color:var(--dim); margin:14px 0 5px; }
input, select { width:100%; height:40px; padding:0 11px; border:1px solid var(--line); border-radius:9px;
  background:var(--bg); color:var(--fg); font:inherit; font-size:14px; }

/* Colours here are hard-coded and marked important on purpose. This page is
   also opened inside hosts that inject their own stylesheets, and a themed
   variable that resolved to the wrong value there produced a white-on-white
   button. A fixed blue on white text is legible in any theme and cannot be
   overridden from the outside. */
button { height:42px; padding:0 18px; border-radius:10px; cursor:pointer;
  background:#3f63f5 !important; color:#ffffff !important; border:1px solid #3f63f5 !important;
  font:inherit; font-weight:600; text-shadow:0 1px 1px rgba(0,0,0,.22); }
button.ghost { background:#1c2333 !important; color:#e8ecf5 !important; border:1px solid #3a4455 !important;
  font-weight:500; text-shadow:none; }
button:hover { filter:brightness(1.1); }
button:active { transform:translateY(1px); }
button:disabled { opacity:.6; cursor:default; }
form.inline { display:inline; }
.url { display:block; padding:10px 12px; border-radius:10px; background:var(--bg); border:1px solid var(--line);
  font-family:ui-monospace, Menlo, monospace; font-size:12.5px; margin:8px 0; word-break:break-all; }
.pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--dim); }
.pill.on { color:var(--ok); border-color:var(--ok); }
.pill.off { color:var(--warn); border-color:var(--warn); }
.note { font-size:12.5px; color:var(--dim); margin-top:8px; }
ol { padding-left:20px; } li { margin:5px 0; font-size:13.5px; }
code { background:var(--bg); border:1px solid var(--line); border-radius:5px; padding:1px 5px;
  font-family:ui-monospace, Menlo, monospace; font-size:12.5px; }
`;

/**
 * Render the settings page.
 *
 * @param {{
 *   store: object,
 *   status: {gateway?: string, tunnel?: string, publicUrl?: string, lanUrls?: string[], error?: string},
 * }} input
 */
export function renderConfigPage(input) {
  const { store, status } = input;
  const relay = store.relay ?? {};
  const mode = relay.mode ?? "off";
  const key = store.accessKey ?? "";

  const lanBlock = (status.lanUrls ?? []).length === 0
    ? '<div class="note">没有检测到局域网地址。</div>'
    : (status.lanUrls ?? []).map((url) => `<span class="url">${esc(url)}/?k=${esc(key)}</span>`).join("");

  const publicBlock = status.publicUrl === undefined
    ? '<div class="note">尚未建立公网入口。</div>'
    : `<span class="url">${esc(status.publicUrl)}/?k=${esc(key)}</span>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh remote</title><style>${STYLE}</style></head>
<body><div class="wrap">
<h1>dsh remote</h1>
<div class="sub">从任何地方访问这台机器的 dsh。手机访问 dsh 本身的界面——同一份工作区、同一份聊天记录。</div>

<h2>当前状态</h2>
<div class="card">
  <div class="row"><span class="k">网关</span><span class="pill ${status.gateway === "listening" ? "on" : "off"}">${esc(status.gateway ?? "未启动")}</span></div>
  <div class="row" style="margin-top:8px"><span class="k">中继隧道</span><span class="pill ${status.tunnel === "up" ? "on" : "off"}">${esc(status.tunnel ?? "未启动")}</span></div>
  ${status.error === undefined ? "" : `<div class="note" style="color:var(--warn)">${esc(status.error)}</div>`}
  <div class="row" style="margin-top:10px"><span class="k">访问密钥</span><span class="v">${esc(key)}</span></div>
  <form class="inline" method="post" action="/remote/rotate" style="margin-top:10px">
    <button class="ghost" type="submit">换一把密钥（所有已配对设备失效）</button>
  </form>
</div>

<h2>局域网地址</h2>
<div class="card">${lanBlock}
  <div class="note">手机和这台机器在同一 WiFi 时，用这个地址直接打开。</div>
</div>

<h2>公网地址</h2>
<div class="card">${publicBlock}
  <div class="note">不在同一网络时用这个。必须带 <code>?k=</code>，第一次打开会换成 cookie。</div>
</div>

<h2>中继服务器</h2>
<form method="post" action="/remote/config">
<div class="card">
  <label for="mode">方式</label>
  <select id="mode" name="mode">
    <option value="off"${mode === "off" ? " selected" : ""}>关闭（只在本机/局域网可用）</option>
    <option value="ssh"${mode === "ssh" ? " selected" : ""}>SSH 反向隧道（需要一台你能登录的服务器）</option>
    <option value="cloudflare"${mode === "cloudflare" ? " selected" : ""}>Cloudflare 隧道（零配置，不需要服务器）</option>
  </select>

  <label for="host">服务器地址</label>
  <input id="host" name="host" placeholder="203.0.113.10 或 vps.example.com" value="${esc(relay.host)}">

  <label for="user">用户名</label>
  <input id="user" name="user" placeholder="root" value="${esc(relay.user)}">

  <label for="password">密码</label>
  <input id="password" name="password" type="password" placeholder="留空则使用已有的 SSH 密钥" value="">

  <label for="sshPort">SSH 端口</label>
  <input id="sshPort" name="sshPort" type="number" min="1" max="65535" value="${esc(relay.sshPort ?? 22)}">

  <label for="remotePort">服务器上对外暴露的端口</label>
  <input id="remotePort" name="remotePort" type="number" min="1" max="65535" value="${esc(relay.remotePort ?? 8787)}">

  <div style="margin-top:18px"><button type="submit">保存并连接</button></div>
  <div class="note">
    保存后立即生效。SSH 方式首次会用密码登录并把本机公钥装到服务器上，之后就不再需要密码；
    服务器需要 <code>GatewayPorts clientspecified</code> 并在云平台安全组放行该端口。
  </div>
</div>
</form>

<h2>怎么用</h2>
<div class="card">
<ol>
  <li>在上面选一种中继方式，填好服务器（Cloudflare 方式可以留空），保存。</li>
  <li>回到「公网地址」，把那一整行（含 <code>?k=</code>）发到手机上打开。</li>
  <li>加进主屏，之后就是一个全屏 app。</li>
</ol>
<div class="note">访问密钥是唯一的门禁。不装这个插件、没有这把密钥，任何人都进不来。</div>
</div>

<div id="dshr-error" class="note" style="display:none;color:var(--warn)"></div>

</div>
<script>
/* Submit in place. A native form POST navigates (and a page opened with ?k=
   would lose its key), so intercept it: fetch, then swap the document without
   touching the URL. With JS off the plain form still works. */
(function () {
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();

    var button = form.querySelector("button[type=submit]");
    var label = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = "处理中…"; }

    fetch(form.action, {
      method: "POST",
      body: new URLSearchParams(new FormData(form)).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: "same-origin"
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    }).then(function (html) {
      try {
        document.open();
        document.write(html);
        document.close();
      } catch (error) {
        location.reload();
      }
    }).catch(function (error) {
      if (button) { button.disabled = false; button.textContent = label; }
      var note = document.getElementById("dshr-error");
      if (note) { note.textContent = "保存失败：" + error.message; note.style.display = "block"; }
    });
  });
})();
</script>
</body></html>`;
}
