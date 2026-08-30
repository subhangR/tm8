/**
 * A one-port front for the harness: everything to vite, `/v2` to the node with
 * the `Origin` header REMOVED.
 *
 * This node runs an exact-origin allowlist (`TM8_ALLOWED_ORIGINS`) naming its
 * deployed hostnames. A dev origin is not on it, so `checkOrigin` answers 403
 * before any handler runs. That guard explicitly ALLOWS an absent Origin —
 * "browsers always send one, so absence proves a non-browser client" — which is
 * the same door the CLI comes through, and the one this strips down to.
 *
 * It has to happen in a proxy rather than in Playwright: `route.continue({
 * headers })` cannot drop `Origin`, the network stack puts it back.
 *
 * NOT a product change and not a change to the package's vite proxy — an
 * accommodation for where this harness is being run from.
 */
import { createServer, request as httpRequest } from 'node:http';

const PORT = Number(process.env.PROXY_PORT ?? 4630);
const VITE = { host: '127.0.0.1', port: Number(process.env.VITE_PORT ?? 4620) };
const NODE = { host: '127.0.0.1', port: Number(process.env.NODE_PORT ?? 17777) };

createServer((req, res) => {
  const toNode = req.url.startsWith('/v2') || req.url.startsWith('/health');
  const target = toNode ? NODE : VITE;
  const headers = { ...req.headers };
  if (toNode) {
    delete headers.origin;
    delete headers.referer;
    headers.host = `${NODE.host}:${NODE.port}`;
  } else {
    headers.host = `${VITE.host}:${VITE.port}`;
  }
  const up = httpRequest({ ...target, method: req.method, path: req.url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`origin-proxy on http://127.0.0.1:${PORT}`));
