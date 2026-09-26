/**
 * THE SSRF GUARD (doc 08 T10): the one list of addresses an outbound request
 * from tm8 may not reach. `web_fetch` (direct-tools.ts) and the server's
 * remote-server client (W8, packages/server/src/remote/guarded-https.ts) both
 * call it, so a new non-public range is added once.
 *
 * It resolves the host itself and returns the addresses it checked. A caller
 * must connect to exactly those (pin them) — resolving again at connect time
 * would let DNS rebinding swap in a private address after the check.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Resolves a host to every address it names. Injectable so tests need no DNS. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Why a URL was refused. `non_public` is the SSRF refusal proper. */
export type OutboundGuardReason = 'invalid_url' | 'dns' | 'non_public';

export class OutboundGuardError extends Error {
  constructor(readonly reason: OutboundGuardReason, message: string) {
    super(message);
    this.name = 'OutboundGuardError';
  }
}

const systemResolver: HostResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((item) => ({ address: item.address, family: item.family as 4 | 6 }));

// Keep families in separate BlockLists: Node treats IPv4 input as IPv4-mapped
// IPv6 when a list also contains `::ffff:0:0/96`, which would otherwise make
// that defensive IPv6 rule reject every ordinary public IPv4 address.
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
] as const) NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');

/** True for loopback, private, link-local, reserved and anything that is not an IP. */
export function isNonPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPV4.check(normalized, 'ipv4');
  if (family === 6) return NON_PUBLIC_IPV6.check(normalized, 'ipv6');
  return true;
}

/**
 * Refuses a URL that is not plain HTTP(S), carries embedded credentials, or
 * resolves to ANY non-public address (one private answer among public ones is
 * still a refusal). Returns the checked addresses for the caller to pin.
 */
export async function resolvePublicAddresses(
  url: URL,
  options: { protocols?: readonly string[]; resolve?: HostResolver } = {},
): Promise<ResolvedAddress[]> {
  const protocols = options.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new OutboundGuardError('invalid_url', 'URL must be public HTTP(S) without embedded credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  try {
    const family = isIP(hostname);
    addresses = family
      ? [{ address: hostname, family: family as 4 | 6 }]
      : await (options.resolve ?? systemResolver)(hostname);
  } catch {
    throw new OutboundGuardError('dns', 'host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new OutboundGuardError('non_public', 'URL resolves to a local or private address');
  }
  return addresses;
}
