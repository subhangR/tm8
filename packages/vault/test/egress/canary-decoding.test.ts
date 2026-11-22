import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as querystring from 'node:querystring';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEgressExecutor, nodeHttpsTransport, type PinnedHttpsRequest } from '../../src/egress/index.js';
import { buildCanarySet, mintCanary } from '../../src/canary/index.js';
import { SecretMaterial } from '../../src/secret-material.js';
import { EgressRefusal, type ApiRequestSpec, type ApiResponseOutcome, type BrokerPolicy } from '../../src/types.js';
import { escapeAll, hex, lastEscaped, lowByteAlias, receiversSeeing, type Receiver } from '../support/receivers.js';

// Review F02 follow-up (task 01a1fe78; brief addendum 5): what a real receiver reads, end to end.
// A generic-mode request goes through the production executor and node:https transport to a local
// HTTPS server, which records the bytes it got and parses them with Node's own parsers. Each case
// runs twice: with an unrelated canary set the request is delivered, so the test shows what the
// receiver reads; with the decoy in the set it must be refused before DNS, and nothing is sent.
// The server then reflects the injected key back, to check what the response filter hands over.
// The certificate authority is generated per run. Every value here is synthetic.

const decoy = ['fixture', 'canary', 'ABCdef0123'].join('-');
const unrelated = ['fixture', 'unrelated', 'decoy', '000'].join('-');
const providerKey = ['fixture', 'provider', 'key', '0123456789'].join('-');
const ALL: Receiver[] = ['form', 'component', 'node-form', 'node-component', 'bytes'];
const NODE: Receiver[] = ['node-form', 'node-component'];
const generic: BrokerPolicy = { keyId: 'item', version: 1, mode: 'generic', connector: null, hosts: ['api.example.com'], methods: ['GET', 'POST'],
  pathPrefixes: ['/'], maxRequestBytes: 65536, maxResponseBytes: 65536, injection: { kind: 'bearer' } };

interface Received { method: string; target: string; headers: IncomingHttpHeaders; body: Buffer }
interface Reply { status?: number; headers?: Record<string, string>; body?: string }

describe('generic-mode egress to a real HTTPS receiver (Addendum 5)', () => {
  let directory: string;
  let ca: Buffer;
  let certificate: Buffer;
  let privateKey: Buffer;
  let server: HttpsServer;
  let port: number;
  const sockets = new Set<Duplex>();
  const received: Received[] = [];
  let reply: (got: Received) => Reply = () => ({});

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vault-canary-tls-'));
    try {
      const run = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
      run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Vault Canary Test CA',
        '-keyout', 'ca-key.pem', '-out', 'ca.pem');
      run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.example.com', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr');
      await writeFile(join(directory, 'extensions.cnf'), 'subjectAltName=DNS:api.example.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
      run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial',
        '-out', 'leaf.pem', '-days', '2', '-extfile', 'extensions.cnf');
      ca = await readFile(join(directory, 'ca.pem'));
      certificate = await readFile(join(directory, 'leaf.pem'));
      privateKey = await readFile(join(directory, 'leaf-key.pem'));
    } finally { await rm(directory, { recursive: true, force: true }); }
    server = createHttpsServer({ key: privateKey, cert: certificate }, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const got = { method: req.method ?? '', target: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      received.push(got);
      const { status = 200, headers = { 'content-type': 'text/plain' }, body = 'ok' } = reply(got);
      res.writeHead(status, headers);
      res.end(body);
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    ca?.fill(0); certificate?.fill(0); privateKey?.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /**
   * The production executor and transport. DNS answers a public address, so the outbound guard
   * runs as it does in production; the transport then connects to the local server instead, keeping
   * the hostname for SNI and certificate verification.
   */
  async function send(request: ApiRequestSpec, canaries: string[], keyValue = providerKey) {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const transport = vi.fn((pinned: PinnedHttpsRequest) => {
      const local = new URL(pinned.url.href);
      local.port = String(port);
      return nodeHttpsTransport({ ...pinned, url: local, address: { address: '127.0.0.1', family: 4 } }, { ca });
    });
    const executor = createEgressExecutor({ resolve, transport });
    const key = SecretMaterial.fromUtf8(JSON.stringify({ key: keyValue }));
    const before = received.length;
    try {
      const result: { outcome?: ApiResponseOutcome; refused?: string } = await executor.execute({ operationId: 'operation', policy: generic, key,
        request, canaries: buildCanarySet(canaries) }).then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ refused: error instanceof EgressRefusal ? error.code : `unexpected ${String(error)}` }));
      return { result, resolve, transport, delivered: received.slice(before) };
    } finally { key.dispose(); }
  }

  /** Delivered once, with an unrelated canary set; returns what the server got. */
  async function control(request: ApiRequestSpec): Promise<Received> {
    const { result, delivered } = await send(request, [unrelated]);
    expect(result).toMatchObject({ outcome: { status: 200 } });
    expect(delivered).toHaveLength(1);
    return delivered[0]!;
  }

  /** Refused before DNS with the decoy in the set: nothing reaches the receiver. */
  async function armed(request: ApiRequestSpec, value = decoy, code = 'canary_in_request'): Promise<void> {
    const { result, resolve, transport, delivered } = await send(request, [unrelated, value]);
    expect(result).toEqual({ refused: code });
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  }

  const queryOf = (target: string) => target.slice(target.indexOf('?') + 1);
  const rawField = (pairs: string, name: string) => new RegExp(`(?:^|&)${name}=([^&]*)`).exec(pairs)?.[1] ?? '';

  /**
   * Where the agent puts a value, and how the receiver gets it back: `sent` is the field as the
   * vault must deliver it, `field` the same field cut from what arrived, before any decoding, and
   * `parsed` what Node's own parser for that position reads from it.
   */
  interface Place {
    latin1: boolean;
    request(value: string): ApiRequestSpec;
    sent(value: string): string;
    field(got: Received): string;
    parsed(got: Received): string;
  }
  const places: Record<string, Place> = {
    'the query': {
      latin1: false,
      request: (value) => ({ method: 'GET', url: `https://api.example.com/search?q=${value}&page=2` }),
      // The URL serializer escapes a literal non-ASCII character as its UTF-8 bytes.
      sent: (value) => rawField(new URL(`https://api.example.com/search?q=${value}&page=2`).search.slice(1), 'q'),
      field: (got) => rawField(queryOf(got.target), 'q'),
      parsed: (got) => String(querystring.parse(queryOf(got.target)).q),
    },
    'a form body': {
      latin1: false,
      request: (value) => ({ method: 'POST', url: 'https://api.example.com/notes',
        body: { kind: 'text', value: `note=${value}&page=2`, contentType: 'application/x-www-form-urlencoded' } }),
      sent: (value) => value,
      field: (got) => rawField(got.body.toString('utf8'), 'note'),
      parsed: (got) => String(new URLSearchParams(got.body.toString('utf8')).get('note')),
    },
    'a text body': {
      latin1: false,
      request: (value) => ({ method: 'POST', url: 'https://api.example.com/notes', body: { kind: 'text', value, contentType: 'text/plain' } }),
      sent: (value) => value,
      field: (got) => got.body.toString('utf8'),
      parsed: (got) => querystring.unescape(got.body.toString('utf8')),
    },
    'a callback URL in a JSON body': {
      latin1: false,
      request: (value) => ({ method: 'POST', url: 'https://api.example.com/subscriptions',
        body: { kind: 'json', value: { callback: `https://collector.example/cb?token=${value}&page=2` } } }),
      sent: (value) => value,
      field: (got) => rawField(queryOf(String((JSON.parse(got.body.toString('utf8')) as { callback: unknown }).callback)), 'token'),
      parsed: (got) => String(querystring.parse(queryOf(String((JSON.parse(got.body.toString('utf8')) as { callback: unknown }).callback))).token),
    },
    // Node sends a header value's code units as Latin-1 bytes and reads them back the same way.
    'a header': {
      latin1: true,
      request: (value) => ({ method: 'GET', url: 'https://api.example.com/notes', headers: { 'x-note': value } }),
      sent: (value) => value,
      field: (got) => String(got.headers['x-note']),
      parsed: (got) => querystring.unescape(String(got.headers['x-note'])),
    },
  };
  const sendable = (place: Place, value: string) => !place.latin1 || /^[\x00-\xff]*$/.test(value);

  // (a) The decoy class, and Node's low-byte class, in every position that can carry them. The
  // receivers named are the ones that read the decoy from what actually arrived.
  const alias = `${lowByteAlias(decoy[0]!)}${decoy.slice(1)}%C3`;
  const forms: [string, string, (where: string) => Receiver[]][] = [
    ['the last character escaped, then a truncated lead byte', lastEscaped(decoy, '%C3'), () => ALL],
    ['a broken lead byte before the escaped first character', `%C3%${hex(decoy[0]!)}${decoy.slice(1)}`, () => ALL],
    ['every byte escaped, then an invalid byte', `${escapeAll(decoy)}%FF`, () => ALL],
    ['lowercase escapes, then a surrogate escape', `${escapeAll(decoy, true)}%ed%a0%80`, () => ALL],
    // The URL serializer escapes the alias as its UTF-8 bytes, so in the query no receiver reads
    // the decoy. The vault refuses it there anyway, because it also reads the agent's raw URL.
    ['a low-byte alias of the first character, then a truncated lead byte', alias, (where) => (where === 'the query' ? [] : NODE)],
  ];
  const cases = forms.flatMap(([label, value, readers]) => Object.entries(places)
    .filter(([, place]) => sendable(place, value))
    .map(([where, place]) => [`${label}, in ${where}`, place, value, readers(where)] as const));

  it.each(cases)('%s: delivered unrefused it reaches the receiver as the decoy; armed it is refused', async (_label, place, value, readers) => {
    const got = await control(place.request(value));
    expect(place.field(got)).toBe(place.sent(value));
    expect(receiversSeeing(place.field(got), decoy)).toEqual(readers);
    // The parser Node itself runs for this position.
    expect(place.parsed(got).includes(decoy)).toBe(readers.some((reader) => NODE.includes(reader)));
    await armed(place.request(value));
  });

  it('cannot carry the Node class in a header: Node refuses to send a code unit above 0xFF', async () => {
    const { result, delivered } = await send(places['a header']!.request(alias), [unrelated]);
    expect(result).toEqual({ refused: 'upstream_unreachable' });
    expect(delivered).toEqual([]);
    await armed(places['a header']!.request(alias));
  });

  // A decoy with a non-ASCII character, from the operator's canary file, through a header.
  const accented = ['fixture', 'café', 'canary', '0123'].join('-');
  it.each([
    ['its UTF-8 bytes written as Latin-1 text', Buffer.from(accented, 'utf8').toString('latin1'), 'component'],
    ['a literal Latin-1 lead byte and an escaped continuation', accented.replace('é', 'Ã%A9'), 'node-component'],
  ] as const)('refuses a non-ASCII decoy in a header as %s', async (_label, value, reading) => {
    const got = await control(places['a header']!.request(value));
    const header = String(got.headers['x-note']);
    expect(header).toBe(value);
    expect(header).not.toContain(accented);
    // A receiver reading the header's bytes as UTF-8, or Node's own unescape, reads the decoy.
    const read = reading === 'component' ? Buffer.from(header, 'latin1').toString('utf8') : querystring.unescape(header);
    expect(read).toContain(accented);
    await armed(places['a header']!.request(value), accented);
  });

  it('refuses a minted decoy behind an invalid escape run in each position', async () => {
    const minted = mintCanary('api_key');
    for (const place of Object.values(places)) {
      const value = lastEscaped(minted, '%C3');
      const got = await control(place.request(value));
      expect(receiversSeeing(place.field(got), minted)).toEqual(ALL);
      await armed(place.request(value), minted);
    }
  });

  it('refuses a malformed escape in the path outright, and reads valid path escapes', async () => {
    for (const value of [lastEscaped(decoy, '%C3'), alias, `${lastEscaped(decoy)}%FF`]) {
      const { result, resolve, delivered } = await send({ method: 'GET', url: `https://api.example.com/files/${value}` }, [unrelated]);
      expect(result).toEqual({ refused: 'url_refused' });
      expect(resolve).not.toHaveBeenCalled();
      expect(delivered).toEqual([]);
    }
    const request: ApiRequestSpec = { method: 'GET', url: `https://api.example.com/files/${lastEscaped(decoy)}` };
    const got = await control(request);
    expect(decodeURIComponent(got.target)).toBe(`/files/${decoy}`);
    await armed(request);
  });

  // (b) No over-blocking: ordinary escapes arrive as sent and decode as intended, with the decoy armed.
  const ordinary: [string, string, string][] = [
    ['a two-byte character', 'Ren%C3%A9e', 'Renée'],
    ['an escaped space', 'S%C3%A3o%20Paulo', 'São Paulo'],
    ['lowercase escapes', 'caf%c3%a9', 'café'],
    ['a three-byte character', '%E6%9D%B1%E4%BA%AC', '東京'],
    ['a four-byte character', '%F0%9F%98%80', '😀'],
    ['literal non-ASCII text', '東京タワー', '東京タワー'],
    ['a near miss: the last escape is another digit', lastEscaped(`${decoy.slice(0, -1)}4`), `${decoy.slice(0, -1)}4`],
  ];
  const ordinaryCases = ordinary.flatMap(([label, value, decoded]) => Object.entries(places)
    .filter(([, place]) => sendable(place, value))
    .map(([where, place]) => [`${label}, in ${where}`, place, value, decoded] as const));

  it.each(ordinaryCases)('delivers %s, which the receiver decodes as intended', async (_label, place, value, decoded) => {
    const { result, delivered } = await send(place.request(value), [unrelated, decoy]);
    expect(result).toMatchObject({ outcome: { status: 200 } });
    expect(delivered).toHaveLength(1);
    const got = delivered[0]!;
    expect(place.field(got)).toBe(place.sent(value));
    expect(place.parsed(got)).toBe(decoded);
    expect(receiversSeeing(place.field(got), decoy)).toEqual([]);
  });

  it('delivers ordinary text with a malformed escape, which no receiver reads as the decoy', async () => {
    for (const place of [places['a form body']!, places['a text body']!, places['a callback URL in a JSON body']!]) {
      const value = '東京タワー 100%FF';
      const { result, delivered } = await send(place.request(value), [unrelated, decoy]);
      expect(result).toMatchObject({ outcome: { status: 200 } });
      expect(place.field(delivered[0]!)).toBe(value);
      expect(receiversSeeing(value, decoy)).toEqual([]);
    }
  });

  // The response side: the server reflects the injected key, hidden the same ways. What the agent
  // is handed must not let any receiver read it.
  describe('a reflected key, through the response filter', () => {
    const reflect = (hide: (key: string) => string, json = false) => (got: Received): Reply => {
      const key = String(got.headers.authorization).replace(/^Bearer /, '');
      expect(key).toBe(providerKey);
      const next = `https://api.example.com/items?cursor=${hide(key)}&page=2`;
      const ascii = /^[\x00-\x7f]*$/.test(next);
      return {
        headers: { 'content-type': json ? 'application/json' : 'text/plain', ...(ascii ? { link: `<${next}>; rel="next"` } : {}) },
        body: json ? JSON.stringify({ next }) : `cursor=${hide(key)}&page=2`,
      };
    };
    const hidden: [string, (key: string) => string, string][] = [
      ['the last character escaped, then a truncated lead byte', (key) => lastEscaped(key, '%C3'), '[redacted]%C3'],
      ['a broken lead byte before the escaped first character', (key) => `%C3%${hex(key[0]!)}${key.slice(1)}`, '%C3[redacted]'],
      ['every byte escaped, then an invalid byte', (key) => `${escapeAll(key)}%FF`, '[redacted]%FF'],
      ['a low-byte alias of the first character, then a truncated lead byte', (key) => `${lowByteAlias(key[0]!)}${key.slice(1)}%C3`, '[redacted]%C3'],
    ];
    afterAll(() => { reply = () => ({}); });

    it.each(hidden)('redacts the key hidden as %s, in the body, a JSON body and a link header', async (_label, hide, redacted) => {
      const before = receiversSeeing(hide(providerKey), providerKey);
      expect(before.length).toBeGreaterThan(0);
      reply = reflect(hide);
      const text = await send({ method: 'GET', url: 'https://api.example.com/echo' }, [unrelated]);
      expect(text.result.outcome?.body).toEqual({ kind: 'text', value: `cursor=${redacted}&page=2` });
      const link = text.result.outcome?.headers.link;
      if (/^[\x00-\x7f]*$/.test(hide(providerKey))) expect(link).toBe(`<https://api.example.com/items?cursor=${redacted}&page=2>; rel="next"`);
      reply = reflect(hide, true);
      const json = await send({ method: 'GET', url: 'https://api.example.com/echo' }, [unrelated]);
      expect(json.result.outcome?.body).toEqual({ kind: 'json', value: { next: `https://api.example.com/items?cursor=${redacted}&page=2` } });
      for (const handed of [JSON.stringify(text.result.outcome), JSON.stringify(json.result.outcome)]) {
        expect(receiversSeeing(handed, providerKey)).toEqual([]);
      }
    });

    it('withholds a response that carries a decoy behind an invalid escape run', async () => {
      reply = () => ({ body: `cursor=${lastEscaped(decoy, '%C3')}&page=2` });
      const { result } = await send({ method: 'GET', url: 'https://api.example.com/echo' }, [unrelated, decoy]);
      expect(result.outcome).toEqual({ status: 200, headers: {}, body: { kind: 'withheld', reason: 'canary' }, redactions: 0 });
    });

    it('passes a response of ordinary escapes unchanged', async () => {
      const body = 'name=Ren%C3%A9e&city=S%C3%A3o+Paulo&price=10%E2%82%AC&note=100%25+sure';
      reply = () => ({ headers: { 'content-type': 'application/x-www-form-urlencoded', link: '<https://api.example.com/items?cursor=Ren%C3%A9e>; rel="next"' }, body });
      const { result } = await send({ method: 'GET', url: 'https://api.example.com/echo' }, [unrelated, decoy]);
      expect(result.outcome).toMatchObject({ status: 200, body: { kind: 'text', value: body }, redactions: 0,
        headers: { link: '<https://api.example.com/items?cursor=Ren%C3%A9e>; rel="next"' } });
    });
  });
});
