/**
 * Tiny assertion harness — no dependency, matching the plugin's own rule of
 * borrowing nothing at runtime.
 */
let passed = 0;
let failed = 0;
const failures = [];

export function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail === undefined ? "" : ` — ${detail}`));
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log('  ' + f);
  }
  return failed === 0;
}

/** Minimal React stand-in: enough to run a component and walk its output. */
export function reactStub() {
  let hooks = [];
  let cursor = 0;
  return {
    api: {
      createElement: (type, props, ...children) => ({
        type,
        props: props ?? {},
        children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
      }),
      Fragment: Symbol('Fragment'),
      useState: (init) => {
        const i = cursor++;
        if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init;
        return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
      },
      useEffect: () => { cursor += 1; },
      useCallback: (fn) => { cursor += 1; return fn; },
      useRef: (init) => { const i = cursor++; if (hooks[i] === undefined) hooks[i] = { current: init }; return hooks[i]; },
    },
    seed(values) { hooks = values; cursor = 0; },
  };
}

/** Walk an element tree, keeping both nodes and text. */
export function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

export const textOf = (nodes) => nodes.filter((n) => typeof n === 'string').join(' ');
export const classOf = (nodes) => nodes.filter((n) => typeof n === 'object').map((n) => n.props?.className ?? '').join(' ');

/** Expand function components so a nested Qr() shows up as its real markup. */
export function expand(nodes, skip = []) {
  const out = [];
  for (const n of nodes) {
    if (typeof n === 'object' && typeof n.type === 'function' && !skip.includes(n.type.name)) {
      walk(n.type(n.props), out);
    } else out.push(n);
  }
  return out;
}
