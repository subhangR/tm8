import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  // IPv6 is denied for egress until all transition/translation ranges can be
  // checked. IPv4 is resolved and pinned, so IPv6 DNS cannot bypass the policy.
  return false;
}
async function resolvePublic(hostname, lookup = dns.resolve4) {
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Private destination');
    return hostname;
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.length > 253) throw new Error('Invalid hostname');
  const addresses = await lookup(hostname);
  if (!addresses.length || addresses.some(address => !isPublicAddress(address))) throw new Error('Private destination');
  return addresses[0];
}
export function createEgressProxy({ lookup } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'http:' || (url.port && url.port !== '80') || url.username || url.password) throw new Error('Only public HTTP allowed');
      const address = await resolvePublic(url.hostname, lookup);
      const headers = { ...req.headers, host: url.host };
      for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) delete headers[key];
      const upstream = http.request({ hostname: address, port: 80, path: `${url.pathname}${url.search}`, method: req.method, headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Destination denied'); }
  });
  server.on('connect', async (req, client, head) => {
    try {
      const match = /^([a-z0-9.-]+):443$/i.exec(req.url ?? '');
      if (!match) throw new Error('Only public TLS on port 443 allowed');
      const address = await resolvePublic(match[1], lookup);
      const upstream = net.connect({ host: address, port: 443 });
      upstream.setTimeout(300000, () => upstream.destroy());
      client.setTimeout(300000, () => client.destroy());
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createEgressProxy().listen(3128, '0.0.0.0');
}
