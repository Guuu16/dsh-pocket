/**
 * Regression suite for dsh-remote.
 *
 * Every case drives the plugin's real code — the route handlers it registers,
 * the component it mounts, the script it injects — with mock service objects
 * that carry this machine's real shapes. Nothing here asserts on a string in a
 * file; a case fails if the behaviour changes, which is the point.
 *
 * Run: node test/run.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { check, section, report, reactStub, walk, textOf, classOf, expand } from './harness.mjs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** Build a context that records the routes and taps a real apply() installs. */
function mountPlugin({ sessions = [], workspaces = [], created = [] } = {}) {
  const routes = new Map();
  let taps = 0;
  const ctx = {
    logger: { info: () => {} },
    on: () => {},
    effect: (fn) => { fn(); return () => {}; },
    webServer: {
      port: 19387,
      register: (route) => { routes.set(route.path, route.handler); return () => {}; },
      tapIndex: () => { taps += 1; return () => {}; },
    },
    sessionQuery: { listSessions: async () => sessions },
    workspaceRegistry: {
      list: () => workspaces,
      create: async (path, title) => { created.push({ path, title }); return { path, title }; },
    },
  };
  const mod = createRequire(import.meta.url)('node:module');
  return import(new URL('index.js', ROOT).href).then((plugin) => {
    plugin.apply(ctx);
    return { routes, taps: () => taps, created, plugin };
  });
}

/** Call a registered route the way the HTTP server would. */
function call(routes, path, { method = 'GET', body, query = '' } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    if (body !== undefined) chunks.push(Buffer.from(body));
    let status = 0;
    let headers = {};
    let out = '';
    const req = {
      method,
      headers: {},
      url: path + query,
      socket: {},
      on(event, handler) {
        if (event === 'data') for (const c of chunks) handler(c);
        if (event === 'end') handler();
        return this;
      },
      destroy() {},
    };
    const res = {
      writeHead(s, h) { status = s; headers = h ?? {}; },
      end(b) { out = b === undefined ? '' : String(b); resolve({ status, headers, body: out }); },
      destroy() { resolve({ status, headers, body: out }); },
    };
    routes.get(path)(req, res);
  });
}

const SESSIONS = [
  { header: { cwd: '/w/app' } }, { header: { cwd: '/w/app' } },
  { header: { cwd: '/w/lost' } }, { header: { cwd: '/w/lost' } },
  { header: { cwd: '/w/lost' } }, { header: { cwd: '/w/lost' } },
  { header: { cwd: '/w/known' } },
  { header: {} },                                  // no cwd must be skipped
];
const WORKSPACES = [
  { path: '/w/app', title: 'app', sessionIds: ['a', 'b'], status: async () => 'ok' },
  { path: '/w/known', title: 'known', sessionIds: ['c'], status: async () => 'ok' },
  { path: '/w/gone', title: 'gone', sessionIds: [], status: async () => 'missing-dir' },
];

// ── injection ───────────────────────────────────────────────────────────────
section('inject.mjs');
{
  const { injectMobileShell } = await import(new URL('src/inject.mjs', ROOT).href);
  const once = injectMobileShell('<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  for (const needle of [
    'rel="manifest"',
    'apple-touch-icon',
    'apple-mobile-web-app-capable',
    'black-translucent',
    'viewport-fit=cover',
    'data-dsh-remote="mobile"',
  ]) check(`injects ${needle}`, once.includes(needle));
  check('idempotent', injectMobileShell(once) === once);
  check('keeps the original document', once.includes('<title>t</title>') && once.includes('>x<'));
}

// ── routes ──────────────────────────────────────────────────────────────────
const created = [];
const { routes } = await mountPlugin({ sessions: SESSIONS, workspaces: WORKSPACES, created });

section('asset routes');
for (const [path, type] of [
  ['/remote.webmanifest', 'application/manifest+json'],
  ['/remote-icon-180.png', 'image/png'],
  ['/remote-icon-192.png', 'image/png'],
  ['/remote-icon-512.png', 'image/png'],
  ['/remote.svg', 'image/svg+xml'],
]) {
  const r = await call(routes, path);
  check(`${path} → 200 ${type}`, r.status === 200 && (r.headers['content-type'] ?? '').includes(type),
    `status=${r.status} type=${r.headers['content-type']}`);
}

section('QR endpoint');
{
  const longKey = 'K'.repeat(43);
  const url = `http://192.168.1.5:8787/?k=${longKey}`;
  const ok = await call(routes, '/remote/api/qr', { query: '?text=' + encodeURIComponent(url) });
  check('200 with SVG', ok.status === 200 && ok.headers['content-type'].includes('image/svg+xml'));
  check('emits an svg element', ok.body.startsWith('<svg'));
  const empty = await call(routes, '/remote/api/qr');
  check('400 without text', empty.status === 400);
  const long = await call(routes, '/remote/api/qr', { query: '?text=' + 'x'.repeat(3000) });
  check('400 for over-long text', long.status === 400);
  const wrong = await call(routes, '/remote/api/qr', { method: 'POST', query: '?text=abc' });
  check('405 for POST', wrong.status === 405);
}

// ── project discovery ───────────────────────────────────────────────────────
section('project discovery');
{
  const cfg = await call(routes, '/remote/api/config');
  const body = JSON.parse(cfg.body);
  const p = body.projects;
  check('counts distinct cwds, skipping the empty one', p.total === 3, `total=${p.total}`);
  check('reports registered workspaces', p.registered.length === 3, `n=${p.registered.length}`);
  check('names the missing projects', p.missing.map((m) => m.title).sort().join(',') === 'lost',
    JSON.stringify(p.missing.map((m) => m.title)));
  check('counts sessions per missing project', p.missing.every((m) => m.sessions === 4),
    JSON.stringify(p.missing));
  check('flags a workspace whose directory is gone', p.orphaned === 1, `orphaned=${p.orphaned}`);
  check('registered entries carry the session count from the registry',
    p.registered.find((r) => r.title === 'app')?.sessions === 2,
    JSON.stringify(p.registered.map((r) => `${r.title}:${r.sessions}`)));
  check('an already-owned directory is not reported as missing',
    !p.missing.some((m) => m.path === '/w/app') && !p.missing.some((m) => m.path === '/w/known'),
    JSON.stringify(p.missing.map((m) => m.path)));

  section('project sync');
  const sync = await call(routes, '/remote/api/sync', { method: 'POST' });
  const synced = JSON.parse(sync.body);
  check('registers only the missing directory', created.length === 1 && created[0].path === '/w/lost',
    JSON.stringify(created));
  check('reports what it added', synced.synced.added.join(',') === 'lost', JSON.stringify(synced.synced));
  check('reports no failures', synced.synced.failed.length === 0);
  const get = await call(routes, '/remote/api/sync');
  check('405 for GET on sync', get.status === 405);
}

// ── the standalone page ─────────────────────────────────────────────────────
section('config page');
{
  const { renderConfigPage } = await import(new URL('src/config-page.mjs', ROOT).href);
  const html = renderConfigPage({
    store: { port: 8787, accessKey: 'K'.repeat(43), relay: { mode: 'cloudflare', host: '', user: '', sshPort: 22, remotePort: 8787, password: '' } },
    status: { gateway: 'listening', tunnel: 'up', publicUrl: 'https://x.trycloudflare.com', lanUrls: ['http://192.168.1.5:8787'] },
    projects: { total: 3, registered: [], missing: [{ title: 'lost', sessions: 4 }] },
  });
  const order = ['扫码打开', '当前状态', '项目', '中继服务器', '怎么用'].map((h) => html.indexOf(`<h2>${h}`));
  check('sections appear in order', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  check('the QR codes come before the status block',
    html.indexOf('<img class="qr"') < html.indexOf('<h2>当前状态'));
  check('names the missing project with its session count', html.includes('lost — 4 个会话'));
  check('collapses the relay form', html.includes('<details') && html.includes('<summary>'));
  check('points at the settings section', html.includes('设置 → 远程访问'));
}

section('unlock page');
{
  const { renderUnlock } = await import(new URL('src/ui.mjs', ROOT).href);
  const html = renderUnlock({ days: 30, configPath: '/Users/someone/.dsh-remote/config.json' });
  check('never prints a filesystem path', !html.includes('/Users/'), 'path leaked');
  check('names the next action', html.includes('设置 → 远程访问'));
  check('keeps the ?k= fallback', html.includes('?k='));
}

// ── the client component ────────────────────────────────────────────────────
section('settings section component');
{
  const React = reactStub();
  const store = { def: undefined };
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (def) => { store.def = def; } } };
  await import(new URL('client.js', ROOT).href + '?t=' + Date.now());
  globalThis.window = previousWindow;

  check('registers under its package id', store.def.id === 'dsh-remote', store.def.id);
  const mod = store.def.factory((name) => {
    if (name === 'react') return React.api;
    throw new Error('unexpected require: ' + name);
  });
  let Component;
  mod.apply({ slots: { inject: (key, cb) => cb(), register: (opts, c) => { Component = c; return () => {}; } } });
  check('registers one settings section', typeof Component === 'function');
  check('declares the slots service', JSON.stringify(mod.inject) === '["slots"]');

  const state = {
    port: 8787, accessKey: 'K'.repeat(43),
    relay: { mode: 'cloudflare', host: '', user: '', sshPort: 22, remotePort: 8787, password: '' },
    status: { gateway: 'listening', tunnel: 'up', publicUrl: 'https://x.trycloudflare.com' },
    lanUrls: ['http://192.168.1.5:8787'],
    lanInterfaces: [{ name: 'en0', url: 'http://192.168.1.5:8787' }, { name: 'utun3', url: 'http://10.8.0.2:8787' }],
    autoSyncProjects: false,
    projects: {
      total: 3,
      registered: [
        { path: '/w/app', title: 'app', sessions: 2, present: true },
        { path: '/w/gone', title: 'gone', sessions: 0, present: false },
      ],
      missing: [{ path: '/w/lost', title: 'lost', sessions: 4 }],
    },
  };
  React.seed([
    state,
    { mode: 'cloudflare', host: '', user: '', sshPort: 22, remotePort: 8787, password: '' },
    false, '', '', '', { current: undefined }, { current: undefined },
  ]);
  const tree = walk(Component({}));
  const expanded = expand(tree, ['RemoteAccess']);
  const text = textOf(expanded);
  const classes = classOf(expanded);

  check('shows a per-project list', classes.includes('dshr-plist'));
  check('lists a healthy project with its count', /app/.test(text) && /2 个会话/.test(text));
  check('marks a missing project', /＋/.test(text) && /lost/.test(text) && /4 个会话/.test(text));
  check('marks an orphaned workspace', /✕/.test(text) && /gone/.test(text));
  check('warns when something is wrong', classes.includes('dshr-warn-card'));
  check('offers the补齐 action', /补齐这 1 个项目（4 个会话）/.test(text), text.match(/补齐[^ ]*/)?.[0]);
  check('offers the auto-sync toggle',
    expanded.some((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false));
  check('renders one QR per LAN adapter', expanded.filter((n) => n.type === 'img' && n.props.className === 'dshr-qr').length === 3,
    String(expanded.filter((n) => n.type === 'img' && n.props.className === 'dshr-qr').length));
  check('labels the adapters', /网卡 en0/.test(text) && /网卡 utun3/.test(text));

  // all-clear state
  React.seed([
    { ...state, projects: { total: 2, registered: state.projects.registered.slice(0, 1), missing: [], orphaned: 0 } },
    { mode: 'off', host: '', user: '', sshPort: 22, remotePort: 8787, password: '' },
    false, '', '', '', { current: undefined }, { current: undefined },
  ]);
  const clean = { text: textOf(expand(walk(Component({})), ['RemoteAccess'])), classes: classOf(expand(walk(Component({})), ['RemoteAccess'])) };
  React.seed([
    { ...state, projects: { total: 2, registered: [state.projects.registered[0]], missing: [], orphaned: 0 } },
    { mode: 'off', host: '', user: '', sshPort: 22, remotePort: 8787, password: '' },
    false, '', '', '', { current: undefined }, { current: undefined },
  ]);
  const settled = expand(walk(Component({})), ['RemoteAccess']);
  check('all-clear uses the ok card', classOf(settled).includes('dshr-ok-card'));
  check('all-clear has no action button', !/补齐这/.test(textOf(settled)),
    textOf(settled).match(/补齐这[^ ]*/)?.[0]);
  check('all-clear still offers the toggle', /启动时自动补齐/.test(textOf(settled)));
}

// ── the injected mobile script ──────────────────────────────────────────────
section('mobile touch targets');
{
  const make = (geometry) => ({
    dataset: {}, style: {},
    getAttribute: () => 'x',
    getBoundingClientRect: () => ({ x: 0, width: 0, height: 0, ...geometry }),
  });
  const sidebarRow = make({ x: 8, width: 35, height: 28 });
  const railButton = make({ x: 10, width: 56, height: 28 });
  const already = make({ x: 200, width: 120, height: 44 });
  const previous = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval };
  globalThis.document = { readyState: 'complete', querySelectorAll: () => [sidebarRow, railButton, already], addEventListener: () => {} };
  globalThis.window = { addEventListener: () => {} };
  globalThis.setInterval = () => 0;
  await import(new URL('public/remote-mobile.js', ROOT).href + '?t=' + Date.now());
  Object.assign(globalThis, previous);

  check('raises the height of a small target', railButton.style.minHeight === '44px', String(railButton.style.minHeight));
  check('never sets a width — it overflowed the 35px sidebar lane',
    sidebarRow.style.minWidth === undefined && railButton.style.minWidth === undefined,
    `sidebar=${sidebarRow.style.minWidth} rail=${railButton.style.minWidth}`);
  check('leaves a control that already measures up', already.style.minHeight === undefined && already.style.minHeight === undefined);
}

// ── manifest ────────────────────────────────────────────────────────────────
section('manifest');
{
  const m = JSON.parse(read('public/remote.webmanifest'));
  check('names the app', m.name === 'dsh remote' && m.short_name === 'dsh', `${m.name}/${m.short_name}`);
  check('opens standalone', m.display === 'standalone');
  check('starts at the root so the cookie applies', m.start_url === '/');
  const sizes = m.icons.map((i) => i.sizes);
  check('ships the raster sizes the manifest needs',
    ['192x192', '512x512'].every((s) => sizes.includes(s)), sizes.join(','));
  check('marks a maskable icon', m.icons.some((i) => i.purpose === 'maskable'));
  // 180 is iOS-only and lives on the injected <link>, not in the manifest.
  const { injectMobileShell } = await import(new URL('src/inject.mjs', ROOT).href);
  const head = injectMobileShell('<html><head></head><body></body></html>');
  check('the injected head carries the iOS 180px icon', head.includes('remote-icon-180.png'));
  check('and the manifest link', head.includes('rel="manifest"'));
}



// ── proxy response headers ──────────────────────────────────────────────────
// Kept last because it binds real sockets.
section('proxy');
{
  const { createServer, request } = await import('node:http');
  const { createProxy } = await import(new URL('src/proxy.mjs', ROOT).href);

  // An upstream that answers like dsh does for a document: chunked, because it
  // never computes a length. This is the shape that produced the invalid pair.
  let sawChunked = false;
  const upstream = createServer((req, res) => {
    sawChunked = true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<html><head><title>up</title></head><body>hello</body></html>');
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const proxy = createProxy({
    port: upstreamPort,
    authority: `127.0.0.1:${upstreamPort}`,
    cookie: () => undefined,
    tapHtml: (html) => html.replace('</head>', '<meta name="tapped" content="1"></head>'),
  });
  const gateway = createServer((req, res) => proxy.handleHttp(req, res));
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const gatewayPort = gateway.address().port;

  const result = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: gatewayPort, path: '/', headers: { connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });

  check('the upstream really answered chunked', sawChunked && result.headers?.transport === undefined);
  check('the response arrives at all (strict clients used to reject it)',
    result.error === undefined, result.error);
  check('no transfer-encoding is left alongside content-length',
    result.headers?.['transfer-encoding'] === undefined,
    `transfer-encoding=${result.headers?.['transfer-encoding']}`);
  check('content-length matches the rewritten body',
    Number(result.headers?.['content-length']) === Buffer.byteLength(result.body ?? '', 'utf8'),
    `declared=${result.headers?.['content-length']} actual=${Buffer.byteLength(result.body ?? '', 'utf8')}`);
  check('the tap still ran', (result.body ?? '').includes('name="tapped"'));
  check('content-encoding was dropped because the body is now plain text',
    result.headers?.['content-encoding'] === undefined);
  check('the two header names are never both present',
    !(result.headers?.['content-length'] !== undefined && result.headers?.['transfer-encoding'] !== undefined));

  gateway.close();
  upstream.close();
}

process.exit(report() ? 0 : 1);
