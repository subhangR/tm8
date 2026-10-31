// B1c: `tm8 bridge import-config` against a fixture Phase-1 config.json and a
// fake server. Never a live config: the numbers in the fixture are placeholders.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeView } from '@tm8/contract';
import { run } from '../src/run.js';
import { mask, maskJids, pairs, planPhase1Import, scrubNumbers, type Phase1Config } from '../src/commands/bridge-import.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/phase1-wa-config.json', import.meta.url));
const config = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Phase1Config;
const SPACE = '33333333-3333-7333-8333-333333333333';
const SELF_CHAT = '22222222-2222-7222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RAHUL = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const ASHA = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const CONNECTION = '44444444-4444-7444-8444-444444444444';
const BRIDGE = '11111111-1111-7111-8111-111111111111';
// Every way an operator might write one number (review r5).
const SHAPES = ['919876543210', '+91 98765 43210', '98765-43210', '(987) 654-3210', '+91.98765.43210', 'a@919876543210',
  '919876543210@s.whatsapp.net', '919876543210%40s.whatsapp.net', '+91 98765 43210@s.whatsapp.net',
  // review r6 (F14): the other separators people type, and full-width digits
  '9198_7654_3210', '919/876/543/210', '9198\t7654\t3210', '+91\u00a098765\u00a043210', '98765\u201343210',
  '9198,7654,3210', '9198:7654:3210', '\uff19\uff11\uff19\uff18\uff17\uff16\uff15\uff14\uff13\uff12\uff11\uff10'];
/** The property: no 8+ digits survive, whatever separates them (any 1-2 non-alphanumerics), in any script. */
const leaks = (text: string) => /\p{Nd}{8,}/u.test(
  text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>').replace(/(?<=\p{Nd})[^\p{L}\p{Nd}]{1,2}(?=\p{Nd})/gu, ''));
const GONE = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', GONE_ADDR = '910000000008@s.whatsapp.net', BAD = '910000000005@s.whatsapp.net', CLASH = '910000000006@s.whatsapp.net', DROP = '910000000007@s.whatsapp.net';
const PN = '910000000001@s.whatsapp.net', LID = '100000000000001@lid', TRUSTED = '910000000002@s.whatsapp.net';

const base = { spaceId: SPACE, mainChats: {}, purposes: {}, members: {}, ownerMember: OWNER };

describe('planPhase1Import (pure)', () => {
  it('plans the self chat as a dm bridge on its main chat, with the owner JIDs and trusted senders as links', () => {
    const [self, ...rest] = planPhase1Import(config, {
      ...base, channels: ['self'], mainChats: { self: SELF_CHAT }, members: { [TRUSTED]: RAHUL },
    });
    expect(rest).toEqual([]);
    expect(self).toEqual({
      channel: 'self',
      conversation: { externalId: PN, kind: 'dm', title: 'Self chat' },
      targetId: SELF_CHAT,
      teammateId: '55555555-5555-7555-8555-555555555555',
      purpose: 'Self chat, imported from the Phase-1 bridge',
      policy: { trigger: 'mention', whoMayTrigger: 'linked' },
      links: [
        { externalId: PN, memberId: OWNER, why: 'owner' },
        { externalId: LID, memberId: OWNER, why: 'owner' },
        { externalId: TRUSTED, memberId: RAHUL, why: 'trusted' },
      ],
    });
  });

  it('maps a group: its own teammate, trigger all → every, everyone → anyone, style, channel-trusted senders', () => {
    const [infra] = planPhase1Import(config, {
      ...base, channels: ['infra'], allowGroups: true, members: { [TRUSTED]: RAHUL, '910000000003@s.whatsapp.net': ASHA },
      purposes: { infra: 'infra on-call' },
    });
    expect(infra!.conversation).toEqual({ externalId: '120300000000000001@g.us', kind: 'group', title: 'Infra' });
    expect(infra!.targetId).toBe('77777777-7777-7777-8777-777777777777');
    expect(infra!.teammateId).toBe('66666666-6666-7666-8666-666666666666');
    expect(infra!.purpose).toBe('infra on-call');
    expect(infra!.policy).toEqual({ trigger: 'every', whoMayTrigger: 'anyone', style: 'casual & short' });
    expect(infra!.links.map(l => [l.externalId, l.memberId])).toEqual([
      [PN, OWNER], [LID, OWNER], [TRUSTED, RAHUL], ['910000000003@s.whatsapp.net', ASHA],
    ]);
  });

  it('refuses the whole run and names every gap at once', () => {
    let message = '';
    try {
      planPhase1Import(config, { ...base, ownerMember: null, channels: ['self', 'lvlup', 'feedback', 'nope'] });
    } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/^nothing was imported/);
    expect(message).toContain('self: no target chat; pass --main-chat self=<chat-id>');
    expect(message).toContain('self: ownerJids[0] …0001@s.whatsapp.net (owner) has no member');
    expect(message).toContain('self: trustedSenders[1] …0002@s.whatsapp.net (trusted) has no member; pass ' +
      '--member <the address at trustedSenders[1] in config.json>=<member-id>');
    expect(message).toContain('lvlup: belongs to space 88888888-8888-7888-8888-888888888888');
    expect(message).toContain('lvlup: a group; this cutover imports the self chat only');
    expect(message).toContain('feedback: shadow mode');
    expect(message).toContain('nope: no such channel');
    // F1: the refusal is pasted onto tasks during the cutover; it never carries a whole number.
    expect(message).not.toMatch(/[0-9]{8,}@/);
  });

  it('imports the self chat only: a group channel is refused unless --allow-groups (B1c-groups passes it)', () => {
    const opts = { ...base, channels: ['infra'], members: { [TRUSTED]: RAHUL, '910000000003@s.whatsapp.net': ASHA } };
    expect(() => planPhase1Import(config, opts)).toThrow(/infra: a group; this cutover imports the self chat only \(pass --allow-groups/);
    expect(planPhase1Import(config, { ...opts, allowGroups: true }).map(p => p.conversation.kind)).toEqual(['group']);
  });

  it('refuses --member and --purpose keys that name nothing in the plan', () => {
    const selfOnly = { ...base, channels: ['self'], mainChats: { self: SELF_CHAT } };
    let message = '';
    try {
      planPhase1Import(config, { ...selfOnly, members: { [TRUSTED]: RAHUL, '910000000099@s.whatsapp.net': ASHA }, purposes: { infra: 'x' } });
    } catch (err) { message = (err as Error).message; }
    expect(message).toContain('--member names addresses that are no owner or trusted sender of the channels imported: …0099@s.whatsapp.net');
    expect(message).toContain('--purpose names channels not being imported: infra');
    expect(message).not.toContain('910000000099');
  });

  it('touches only the channels named, and refuses with none named', () => {
    expect(() => planPhase1Import(config, { ...base, channels: [] })).toThrow(/--channel <id>/);
    const plan = planPhase1Import(config, { ...base, channels: ['self'], mainChats: { self: SELF_CHAT }, members: { [TRUSTED]: RAHUL } });
    expect(plan.map(p => p.channel)).toEqual(['self']);
    expect(() => planPhase1Import(config, {
      ...base, channels: ['self'], mainChats: { self: SELF_CHAT, infra: SELF_CHAT }, members: { [TRUSTED]: RAHUL },
    })).toThrow(/--main-chat names channels not being imported: infra/);
  });

  it('refuses a non-group channel that is not the owner\'s self chat, and a non-person address', () => {
    const odd: Phase1Config = { ...config, trustedSenders: ['120300000000000009@g.us'],
      channels: [{ id: 'dm', jid: '910000000009@s.whatsapp.net', mainChatId: SELF_CHAT }] };
    expect(() => planPhase1Import(odd, { ...base, channels: ['dm'] }))
      .toThrow(/must be the owner's self chat[\s\S]*is not a person's WhatsApp address/);
  });

  it('scrubNumbers masks a number in every shape, keeps its last 4, and leaves UUIDs and short numbers alone', () => {
    for (const n of SHAPES) {
      const out = scrubNumbers(`x ${n} y`);
      expect(out, JSON.stringify(n)).toMatch(/…(3210|\uff13\uff12\uff11\uff10)/);
      expect(leaks(out), JSON.stringify(n)).toBe(false);
    }
    expect(scrubNumbers(`bridge ${BRIDGE} → chat ${SELF_CHAT}`)).toBe(`bridge ${BRIDGE} → chat ${SELF_CHAT}`);
    // UUIDs survive next to numbers, and many of them in one text (indices past 9)
    const many = Array.from({ length: 12 }, () => BRIDGE).join(' ');
    expect(scrubNumbers(`${many} 919876543210`)).toBe(`${many} …3210`);
    expect(scrubNumbers(`${SELF_CHAT}:919876543210`)).toBe(`${SELF_CHAT}:…3210`);
    // the placeholder nit: input that already holds the private-use mark is left as it was
    expect(scrubNumbers('x\uE000\uE000y \uE000ab\uE000')).toBe('x\uE000\uE000y \uE000ab\uE000');
    expect(scrubNumbers('trustedSenders[1] · exit 5 · 1234')).toBe('trustedSenders[1] · exit 5 · 1234');
  });

  it('parses key=value flags and masks addresses', () => {
    expect(pairs('member', [`${PN}=${OWNER}`])).toEqual({ [PN]: OWNER });
    expect(() => pairs('member', ['nope'])).toThrow(/<key>=<value>/);
    expect(() => pairs('main-chat', ['a=1', 'a=2'])).toThrow(/names a twice/);
    // F6: a malformed or repeated --member key never prints the whole number.
    const refusal = (f: () => unknown) => { try { f(); } catch (err) { return (err as Error).message; } return ''; };
    const twice = refusal(() => pairs('member', [`${TRUSTED}=${RAHUL}`, `${TRUSTED}=${ASHA}`]));
    const malformed = refusal(() => pairs('member', [`${TRUSTED}=`]));
    expect(twice).toBe('--member names …0002@s.whatsapp.net twice');
    expect(malformed).toBe('--member takes <key>=<value>, got "…0002@s.whatsapp.net="');
    for (const m of [twice, malformed]) expect(m).not.toMatch(/[0-9]{8,}@/);
    // F7: a key without its @ suffix is masked too.
    const bareMalformed = refusal(() => pairs('member', ['919876543210']));
    const bareTwice = refusal(() => pairs('member', ['919876543210=a', '919876543210=b']));
    expect(bareMalformed).toBe('--member takes <key>=<value>, got "…3210"');
    expect(bareTwice).toBe('--member names …3210 twice');
    for (const m of [bareMalformed, bareTwice]) expect(m).not.toMatch(/[0-9]{8,}/);
    // F8: a request path (the @ URL-encoded) is masked.
    expect(maskJids('PATCH /v2/bridges/b/participants/919876543210%40s.whatsapp.net timed out'))
      .toBe('PATCH /v2/bridges/b/participants/…3210%40s.whatsapp.net timed out');
    expect(mask(PN)).toBe('…0001@s.whatsapp.net');
  });
});

describe('tm8 bridge import-config (fake server)', () => {
  let server: Server;
  let requests: Array<{ method: string; path: string; body: Record<string, any> }> = [];
  let bridges: BridgeView[] = [];
  const asserted = new Map<string, string>();
  let stdout = '', stderr = '';
  let refuseCreate = false;

  const viewFor = (body: Record<string, any>): BridgeView => ({
    id: BRIDGE, spaceId: SPACE, version: 1, title: body.conversation.title, createdAt: 'x', updatedAt: 'x',
    provider: 'whatsapp', connectionId: body.connectionId, connectionCredentialId: null,
    conversation: { ...body.conversation, memberCount: null },
    target: { kind: 'chat', id: body.targetId, title: 'Self' },
    policy: { trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'linked', voice: 'named', style: null, ...body.policy },
    status: 'live', health: { connection: 'linked', lastInboundAt: null, lastOutboundAt: null, queued: 0, failed24h: 0, detail: null },
    people: { participants: 0, linked: 0, guestsSeen7d: 0 }, handles: 0, retentionDays: 90, teammateId: body.teammateId,
    purpose: body.purpose, quietHours: null, workerPosting: true, workers: { wake: 'directed' }, pausedAt: null, endedAt: null,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://localhost');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {};
        requests.push({ method: req.method!, path: decodeURIComponent(url.pathname), body });
        let data: unknown;
        if (url.pathname.endsWith('/bridges') && req.method === 'GET') data = { items: bridges };
        else if (url.pathname.endsWith('/bridges') && req.method === 'POST' && refuseCreate) {
          // F15: a validation refusal whose details echo a number back, the way zod issues do.
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_input', message: 'request body failed validation', requestId: 'test', retryable: false,
            details: { reason: 'bad_value 919876543210', next: 'tm8 x 919876543210', issues: [{ key: 'purpose.919876543210', code: 'invalid_enum_value', message: "received '919876543210'" }] } } }));
          return;
        }
        else if (url.pathname.endsWith('/bridges') && req.method === 'POST') { const v = viewFor(body); bridges.push(v); data = v; }
        else if (url.pathname.includes('/participants/')) {
          // P's reply (#1439): no participant rows exist yet, so participant is null.
          const externalId = decodeURIComponent(url.pathname.split('/').at(-1)!);
          if (body.patch.memberId === GONE) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'not_found', message: 'member not found in this space', requestId: 'test', retryable: false } }));
            return;
          }
          if (externalId === BAD) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'invalid_input', message: 'a WhatsApp link names a person', requestId: 'test', retryable: false } }));
            return;
          }
          if (externalId === DROP) { req.socket.destroy(); return; } // a transport failure on this one row
          if (externalId === CLASH) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'conflict', message: 'this address is verified as someone else', details: { reason: 'link_conflict' }, requestId: 'test', retryable: false } }));
            return;
          }
          const changed = asserted.get(externalId) !== body.patch.memberId;
          asserted.set(externalId, body.patch.memberId);
          data = { bridgeId: BRIDGE, externalId, changed, participant: null };
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, requestId: 'test' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server port');
    vi.stubEnv('TM8_BASE_URL', `http://127.0.0.1:${address.port}`); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
    vi.stubEnv('TM8_SESSION_ID', ''); vi.stubEnv('TM8_AGENT_TOKEN', ''); vi.stubEnv('TM8_TEAM_MEMBER_ID', '');
    vi.stubEnv('TM8_JOURNAL_CLASS', 'human'); vi.stubEnv('TM8_NO_TERSE_DEFAULT', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { stdout += String(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { stderr += String(chunk); return true; });
    await run(['bridge', 'list']); // warm the CLI's module graph outside the per-test limit
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { requests = []; stdout = ''; stderr = ''; });

  const args = ['bridge', 'import-config', '--config', FIXTURE, '--channel', 'self', '--connection', CONNECTION,
    '--main-chat', `self=${SELF_CHAT}`, '--owner-member', OWNER, '--member', `${TRUSTED}=${RAHUL}`];

  it('--dry-run prints the plan and sends nothing', async () => {
    expect(await run([...args, '--dry-run'])).toBe(0);
    expect(requests).toEqual([]);
    expect(stdout).toContain('dry run, nothing written');
    expect(stdout).toContain(`self: dm "Self chat" → chat ${SELF_CHAT}`);
    expect(stdout).not.toContain('910000000001');
  });

  it('--json is masked too, for dry runs and real runs (F1)', async () => {
    expect(await run([...args, '--dry-run', '--format', 'json'])).toBe(0);
    expect(stdout).toContain('…0001@s.whatsapp.net');
    expect(stdout).not.toMatch(/[0-9]{8,}@/);
    stdout = ''; requests = [];
    expect(await run([...args, '--format', 'json'])).toBe(0);
    expect(requests.some(r => r.method === 'PATCH' && r.path.endsWith(`/participants/${PN}`))).toBe(true); // the wire carries the real id
    expect(stdout).not.toMatch(/[0-9]{8,}@/);
    bridges = []; asserted.clear(); // the next case starts from an empty space
  });

  it('creates the Self bridge, asserts every link, and a rerun changes nothing', async () => {
    expect(await run(args)).toBe(0);
    const create = requests.find(r => r.method === 'POST' && r.path.endsWith('/bridges'))!;
    expect(create.path).toBe(`/v2/spaces/${SPACE}/bridges`);
    expect(create.body).toMatchObject({
      connectionId: CONNECTION, targetId: SELF_CHAT,
      conversation: { externalId: PN, kind: 'dm', title: 'Self chat' },
      policy: { trigger: 'mention', whoMayTrigger: 'linked' },
      teammateId: '55555555-5555-7555-8555-555555555555',
    });
    const links = requests.filter(r => r.method === 'PATCH');
    expect(links.map(r => [r.path, r.body.patch.memberId])).toEqual([
      [`/v2/bridges/${BRIDGE}/participants/${PN}`, OWNER],
      [`/v2/bridges/${BRIDGE}/participants/${LID}`, OWNER],
      [`/v2/bridges/${BRIDGE}/participants/${TRUSTED}`, RAHUL],
    ]);
    expect(stdout).toContain('bridge 11111111-1111-7111-8111-111111111111 created');
    expect(stdout.match(/: asserted/g)).toHaveLength(3);
    expect(links.every(r => Object.keys(r.body.patch).join() === 'memberId' && typeof r.body.clientMutationId === 'string')).toBe(true);

    requests = []; stdout = '';
    expect(await run(args)).toBe(0);
    expect(requests.filter(r => r.method === 'POST')).toEqual([]);
    expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(3);
    expect(stdout).toContain('already there');
    expect(stdout).not.toMatch(/: asserted/);
    expect(stdout.match(/: unchanged/g)).toHaveLength(3);
  });

  it('reports a 404 (member not active), a 400 (not a person) and a 409 (linked to someone else) on their rows, writes the rest, and exits non-zero', async () => {
    const extra = ['--member', `${TRUSTED}=${GONE}`];
    const withBad: Phase1Config = { ...config, trustedSenders: [...(config.trustedSenders ?? []), BAD, CLASH] };
    const file = `${FIXTURE}.bad.json`;
    (await import('node:fs')).writeFileSync(file, JSON.stringify(withBad));
    try {
      const a = args.map(x => (x === FIXTURE ? file : x)).filter((x, i, all) => !(x.startsWith(`${TRUSTED}=`) || (x === '--member' && all[i + 1]?.startsWith(`${TRUSTED}=`))));
      expect(await run([...a, ...extra, '--member', `${BAD}=${RAHUL}`, '--member', `${CLASH}=${RAHUL}`])).toBe(5);
    } finally { (await import('node:fs')).rmSync(file); }
    expect(stdout).toContain('…0001@s.whatsapp.net → member');
    expect(stdout).toMatch(/…0002@s\.whatsapp\.net → member dddddddd-[^:]*: REFUSED member_not_active/);
    expect(stdout).toMatch(/…0005@s\.whatsapp\.net → member bbbbbbbb-[^:]*: REFUSED invalid_address/);
    expect(stdout).toMatch(/…0006@s\.whatsapp\.net → member bbbbbbbb-[^:]*: REFUSED link_conflict/);
    expect(stdout).toContain('some links were refused');
    expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(5);
  });

  it('refuses before any write when the bridge exists on another target', async () => {
    bridges = [{ ...bridges[0]!, target: { kind: 'chat', id: '00000000-0000-7000-8000-000000000001', title: 'Other' } }];
    expect(await run(args)).not.toBe(0);
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('a config that is not JSON is refused without quoting the file (F9)', async () => {
    const file = `${FIXTURE}.broken.json`;
    (await import('node:fs')).writeFileSync(file, '{"ownerJids": [x"919876543210@s.whatsapp.net"]}');
    try {
      const a = args.map(x => (x === FIXTURE ? file : x));
      expect(await run([...a, '--dry-run'])).toBe(2);
    } finally { (await import('node:fs')).rmSync(file); }
    expect(stderr).toContain('--config is not JSON');
    expect(stderr).not.toMatch(/[0-9]{8,}/);
    expect(requests).toEqual([]);
  });

  it('a transport failure on a link row names the request path masked (F8)', async () => {
    bridges = []; asserted.clear();
    const file = `${FIXTURE}.drop.json`;
    (await import('node:fs')).writeFileSync(file, JSON.stringify({ ...config, trustedSenders: [DROP] }));
    try {
      const a = [...args.filter((x, i, all) => !(x === '--member' || all[i - 1] === '--member')).map(x => (x === FIXTURE ? file : x)),
        '--member', `${DROP}=${RAHUL}`];
      expect(await run(a)).not.toBe(0);
    } finally { (await import('node:fs')).rmSync(file); bridges = []; asserted.clear(); }
    expect(requests.some(r => r.path.endsWith(`/participants/${DROP}`))).toBe(true);
    expect(stderr).toContain('…0007%40s.whatsapp.net');
    expect(stderr).not.toMatch(/[0-9]{8,}(@|%40)/);
  });

  it('catch-all: no refusal path prints a run of 8+ digits (UUIDs aside)', async () => {
    bridges = []; asserted.clear();
    const fs = await import('node:fs');
    const out: string[] = [];
    const take = () => { out.push(stdout, stderr); stdout = ''; stderr = ''; };
    const withConfig = async (cfg: unknown, extra: string[], drop: string[] = []) => {
      const file = `${FIXTURE}.all.json`;
      fs.writeFileSync(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
      try {
        const base = args.filter((x, i, all) => !drop.some(d => x === d || all[i - 1] === d)).map(x => (x === FIXTURE ? file : x));
        await run([...base, ...extra]);
      } finally { fs.rmSync(file); }
      take();
    };
    await withConfig(config, [], ['--owner-member', '--member']);                         // owner and trusted have no member
    await withConfig(config, ['--member', '910000000099@s.whatsapp.net=' + ASHA]);         // unused --member key
    await withConfig(config, ['--member', '919876543210'], ['--member']);                 // malformed, bare
    await withConfig(config, ['--member', '919876543210=a', '--member', '919876543210=b']);// repeated, bare
    await withConfig(config, ['--channel', 'infra']);                                     // a group without --allow-groups
    await withConfig({ ...config, trustedSenders: ['120300000000000009@g.us'] }, []);     // not a person
    await withConfig('{"ownerJids": [x"919876543210@s.whatsapp.net"]}', []);             // not JSON
    // r5, property-style: a number in every shape, in every flag slot and in every config-sourced field.
    for (const n of SHAPES) {
      const cases: Array<[string[], string[]]> = [
        [['--channel', n], []],
        [['--connection', n], ['--connection']],
        [['--main-chat', `${n}=x`], []], [['--main-chat', `self=${n}`], ['--main-chat']],
        [['--purpose', `${n}=x`], []], [['--purpose', `self=${n}`], []],
        [['--member', `${n}=${ASHA}`], []], [['--member', `${TRUSTED}=${n}`], ['--member']], [['--member', n], ['--member']],
        [['--owner-member', n], ['--owner-member']],
      ];
      for (const [extra, drop] of cases) await withConfig(config, [...extra, '--dry-run'], drop);
      await run([...args.filter((x, i, all) => !(x === '--config' || all[i - 1] === '--config')), '--config', n, '--dry-run']);
      take();
      // config-sourced: the channel id, its title, an owner JID and a trusted sender
      const self = config.channels!.find(c => c.id === 'self')!;
      await withConfig({ ...config, channels: [{ ...self, id: n }] }, ['--channel', n, '--dry-run'], ['--channel', '--main-chat']);
      await withConfig({ ...config, channels: [{ ...self, title: n }] }, ['--dry-run']);
      await withConfig({ ...config, trustedSenders: [n] }, ['--dry-run'], ['--member']);
      await withConfig({ ...config, ownerJids: [n, ...(config.ownerJids ?? [])] }, ['--dry-run']);
    }
    await withConfig({ ...config, trustedSenders: [...(config.trustedSenders ?? []), GONE_ADDR, BAD, CLASH] },
      ['--member', `${GONE_ADDR}=${GONE}`, '--member', `${BAD}=${RAHUL}`, '--member', `${CLASH}=${RAHUL}`]);   // 404 / 400 / 409 rows
    await withConfig({ ...config, trustedSenders: [DROP] }, ['--member', `${DROP}=${RAHUL}`], ['--member']); // a transport failure stops the run
    bridges = []; asserted.clear();
    const text = out.join('\n').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
    expect(text).toContain('REFUSED');                 // the row paths really ran
    expect(text).toContain('not JSON');
    expect(text).toContain('…3210@s.whatsapp.net: no such channel in the config');
    expect(text).toContain('--purpose names channels not being imported: …3210');
    expect(text).toContain('--main-chat names channels not being imported: …3210');
    expect(text).toContain('--connection takes the connection id');
    expect(text).toContain('--owner-member takes a member id');
    expect(text).toContain('purpose: …3210');
    expect(text).toContain('%40s.whatsapp.net failed');
    expect(text).not.toMatch(/[0-9]{8,}/);
    // and with any separator between digits taken out, in any script
    expect(leaks(text)).toBe(false);
  });

  it('an ApiError that escapes the command is scrubbed in its details too (F15)', async () => {
    bridges = []; asserted.clear(); refuseCreate = true;
    try { expect(await run(args)).not.toBe(0); } finally { refuseCreate = false; }
    expect(stderr).toContain('…3210');
    expect(leaks(stdout + stderr)).toBe(false);
  });

  it('refuses a real run without --connection', async () => {
    const without = args.filter((a, i) => a !== '--connection' && args[i - 1] !== '--connection');
    expect(await run(without)).not.toBe(0);
    expect(requests).toEqual([]);
  });
});
