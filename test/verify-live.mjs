/**
 * Live acceptance check for a running dsh-remote.
 *
 * The regression suite proves the code is correct; this proves the running
 * process actually loaded it. Those are different questions — a plugin edit
 * needs a dsh restart because Node caches the module, so a stale process
 * answers 404 on every new route while `npm test` stays green.
 *
 * Run: node test/verify-live.mjs [gateway-port]
 */

import { request as httpRequest } from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const checks = [];

/**
 * One raw HTTP request.
 *
 * Deliberately node:http rather than fetch: fetch failed against this gateway
 * with a generic "fetch failed" while curl returned 200 on the same URL, and a
 * probe that cannot say why it failed is not worth having.
 */
function request(path, { method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method, headers: { connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => resolve({ status: 0, type: '', body: '', error: e.message }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, type: '', body: '', error: e.message }));
    req.end();
  });
}

/**
 * Probe with a couple of retries.
 *
 * This gateway answers a 404 with an empty body and drops the socket about one
 * time in three (measured; independent of the Connection header, and only on
 * 404s). Real clients only ever request paths that exist, so it is a
 * non-issue in practice — but it would make this report flap, and a check that
 * cries wolf is worse than no check.
 */
async function probe(path, { method = 'GET', expect, type } = {}) {
  let res = await request(path, { method });
  for (let attempt = 0; attempt < 3 && res.error !== undefined; attempt += 1) {
    await new Promise((r) => setTimeout(r, 150));
    res = await request(path, { method });
  }
  const typeOk = type === undefined || res.type.includes(type);
  checks.push({
    name: `${method} ${path}`,
    ok: res.status === expect && typeOk,
    detail: res.error !== undefined
      ? `unreachable after 3 attempts: ${res.error}`
      : `${res.status} ${res.type || '(no content-type)'}${typeOk ? '' : ' (wrong content-type)'}`,
    body: res.body,
  });
}

await probe('/', { expect: 200, type: 'text/html' });
await probe('/remote/api/config', { expect: 200, type: 'application/json' });
await probe('/remote/api/qr?text=probe', { expect: 200, type: 'image/svg+xml' });
await probe('/remote.webmanifest', { expect: 200, type: 'application/manifest+json' });
await probe('/remote-icon-180.png', { expect: 200, type: 'image/png' });
await probe('/remote-icon-192.png', { expect: 200, type: 'image/png' });
await probe('/remote-icon-512.png', { expect: 200, type: 'image/png' });
await probe('/remote/api/sync', { method: 'POST', expect: 200, type: 'application/json' });

const index = checks.find((c) => c.name === 'GET /');
const injected = index?.body ?? '';
checks.push({ name: 'head injection is live', ok: injected.includes('rel="manifest"') && injected.includes('apple-touch-icon'), detail: injected.includes('data-dsh-remote="mobile"') ? 'marker present' : 'marker missing' });
checks.push({ name: 'mobile script is the height-only revision', ok: injected.includes('dshrSized') && !injected.includes('minWidth = MIN_TARGET'), detail: injected.includes('dshpSized') ? 'still the dshp revision' : '' });

/** Parse a probe body without letting a failed probe crash the report. */
function parsed(name) {
  const entry = checks.find((c) => c.name === name);
  if (entry?.ok !== true) return null;
  try {
    return JSON.parse(entry.body);
  } catch {
    return null;
  }
}

const cfg = parsed('GET /remote/api/config');
const projects = cfg?.projects ?? null;
checks.push({
  name: 'project discovery answers',
  ok: projects !== null && Array.isArray(projects.missing),
  detail: projects === null
    ? 'no projects field in the reply'
    : `total=${projects.total} registered=${projects.registered?.length} missing=${projects.missing?.length} orphaned=${projects.orphaned}`,
});
const adapters = cfg?.lanInterfaces ?? [];
checks.push({
  name: 'LAN adapters are enumerated',
  ok: adapters.length > 0,
  detail: adapters.map((i) => i.name).join(',') || 'none',
});

const wide = checks.filter((c) => c.name.length > 0);
const failed = wide.filter((c) => c.ok === false);
for (const c of wide) console.log(`${c.ok ? ' ok  ' : ' FAIL'} ${c.name.padEnd(42)} ${c.detail}`);
console.log(`\n${wide.length - failed.length}/${wide.length} ok`);

if (failed.length > 0) {
  console.log('\nNot loaded. If the process start time predates the last commit, restart dsh:');
  console.log('  a plugin edit needs a restart because Node caches ES modules.');
  process.exit(1);
}
console.log('\nThe running process has loaded the current code.');
