/**
 * Transparent reverse proxy from the phone-facing gateway to the loopback dsh
 * web server.
 *
 * Two rewrites make the dsh browser-trust fence accept forwarded traffic:
 *
 *   Host / Origin  dsh serves only loopback or declared authorities and
 *                  compares Origin against Host, so both are rewritten to the
 *                  loopback authority the gateway is authenticated as.
 *   Cookie         the gateway mints the signed dsh browser cookie itself, so
 *                  the phone never needs the process launch token.
 *
 * HTTP and WebSocket upgrades share one path: dsh carries its RPC over the
 * `/api/remote.mux` WebSocket, so upgrade traffic is piped socket-to-socket
 * without frame inspection.
 */

import { request as requestHttp } from "node:http";
import { connect as connectTcp } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Decode one upstream body so it can be edited as text. */
function decodeBody(buffer, encoding) {
  const kind = String(encoding ?? "").toLowerCase();
  if (kind === "" || kind === "identity") return buffer.toString("utf8");
  if (kind === "gzip") return gunzipSync(buffer).toString("utf8");
  if (kind === "br") return brotliDecompressSync(buffer).toString("utf8");
  if (kind === "deflate") return inflateSync(buffer).toString("utf8");
  // An unknown coding cannot be rewritten safely; callers fall back to piping.
  return undefined;
}

/** Hop-by-hop headers that must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "origin",
  "cookie",
]);

/**
 * Build the upstream header set.
 *
 * `connection` and `upgrade` are hop-by-hop and normally dropped, but a
 * WebSocket handshake *is* those headers — stripping them turns the upgrade
 * into a plain GET, the upstream never emits `upgrade`, and the client sees a
 * dead socket. For upgrade requests they are therefore rebuilt explicitly.
 */
function forwardHeaders(headers, authority, cookie, options = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[name] = value;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  if (cookie !== undefined) out.cookie = cookie;
  if (options.upgrade === true) {
    out.connection = "Upgrade";
    out.upgrade = headers.upgrade ?? "websocket";
  }
  return out;
}

/**
 * Build a proxy bound to one loopback target.
 *
 * @param {{
 *   port: number,
 *   authority: string,
 *   cookie: () => string | undefined,
 *   onUpgradeError?: (error: Error) => void,
 * }} options
 * @returns {{
 *   handleHttp: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
 *   handleUpgrade: (req: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void,
 * }}
 */
export function createProxy(options) {
  const { cookie } = options;
  // Both targets may be functions: as a dsh plugin the upstream port is only
  // known after the web server binds, which happens after this proxy is built.
  const portOf = () => (typeof options.port === "function" ? options.port() : options.port);
  const authorityOf = () => (typeof options.authority === "function" ? options.authority() : options.authority);

  function handleHttp(req, res) {
    const port = portOf();
    const authority = authorityOf();
    const headers = forwardHeaders(req.headers, authority, cookie());
    const upstream = requestHttp({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers,
    });

    upstream.on("response", (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      const type = String(headers["content-type"] ?? "");
      const isHtml = type.includes("text/html");

      // A tunnel's edge (Cloudflare) rewrites HTML unless told not to, and its
      // injected script tags break dsh's ES-module boot. `no-transform` is the
      // standard opt-out.
      if (isHtml) {
        headers["cache-control"] = "no-store, no-transform";
      }

      // Documents get the mobile shell mounted; everything else streams through.
      if (isHtml && options.tapHtml !== undefined) {
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("error", () => res.destroy());
        upstreamRes.on("end", () => {
          // dsh serves HTML gzipped. Decoding before editing is mandatory:
          // injecting into compressed bytes and keeping content-encoding makes
          // the browser fail with ERR_CONTENT_DECODING_FAILED.
          let text;
          try {
            text = decodeBody(Buffer.concat(chunks), headers["content-encoding"]);
          } catch {
            text = undefined;
          }
          if (text === undefined) {
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            res.end(Buffer.concat(chunks));
            return;
          }
          const buffer = Buffer.from(options.tapHtml(text), "utf8");
          delete headers["content-encoding"];
          delete headers.etag;
          // The body is now a known-length buffer, so it must not also claim to
          // be chunked. Upstream headers are copied wholesale, and dsh sends
          // `transfer-encoding: chunked`; leaving both makes the response
          // invalid — Node's HTTP client rejects it outright with "Content-Length
          // can't be present with Transfer-Encoding", and a strict client on the
          // phone would too. curl tolerates it, which is why it went unnoticed.
          delete headers["transfer-encoding"];
          headers["content-length"] = String(buffer.byteLength);
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          res.end(buffer);
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    });

    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dsh-remote: upstream ${authority} failed: ${error.message}\n`);
    });

    // A phone that backgrounds the page or roams networks closes the client
    // side mid-response; tear the upstream request down instead of leaking it.
    const abort = () => upstream.destroy();
    req.on("error", abort);
    res.on("error", abort);
    res.on("close", () => {
      if (!res.writableEnded) abort();
    });

    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    // A reset during the handshake must not reach an unhandled 'error' event.
    socket.on("error", () => socket.destroy());
    const port = portOf();
    const authority = authorityOf();
    const headers = forwardHeaders(req.headers, authority, cookie(), { upgrade: true });
    const upstream = requestHttp({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers,
    });

    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const close = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on("error", close);
      socket.on("error", close);
      upstreamSocket.on("close", close);
      socket.on("close", close);
    });

    upstream.on("response", (upstreamRes) => {
      // The upstream refused the upgrade; relay the plain response instead.
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ""}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      upstreamRes.pipe(socket);
    });

    upstream.on("error", (error) => {
      options.onUpgradeError?.(error);
      socket.destroy();
    });

    upstream.end();
  }

  return { handleHttp, handleUpgrade };
}

/**
 * Pipe one raw TCP connection straight through, used when the target needs a
 * byte-level relay rather than an HTTP hop.
 *
 * @param {{port: number, socket: import("node:net").Socket}} options
 */
export function pipeRawTcp(options) {
  const upstream = connectTcp({ host: "127.0.0.1", port: options.port });
  upstream.on("connect", () => options.socket.pipe(upstream).pipe(options.socket));
  const close = () => upstream.destroy();
  upstream.on("error", close);
  options.socket.on("error", close);
}
