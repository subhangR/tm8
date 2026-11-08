/**
 * Is this URL's host on the caller's own machine or network — loopback,
 * `localhost`, mDNS `.local`, or an RFC 1918 range? Those are the servers that
 * need `allowPrivateNetwork` (the server refuses them otherwise) and that
 * usually speak plain http. A hint for the UI only: the server's own
 * resolve-and-pin check (`server/mcp/transport.ts`) is the boundary.
 */
export function isPrivateHost(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '0.0.0.0';
}
