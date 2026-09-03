/**
 * `tm8 chat …` — the chat noun (176, Wave 2 L2-cli).
 *
 * UNIT tests against a STUB HTTP server, driving the REAL kernel through
 * `run()` — parse → context → registry → dispatch → output → exit. Every
 * assertion here is about what THIS CLI puts on the wire and what it does with
 * an answer, never about what the Server would decide.
 *
 * THE POINT OF THE WIRE ASSERTIONS. Four of the five commands are SUGAR over
 * operations that already exist, which means the only thing that can be wrong
 * about them is the request they compose: a `chat list` that forgot
 * `kinds:['chat']` would return every entity in the Space and still exit 0, and
 * a `chat send` that dropped the caller's session id would silently break the
 * `authored_from` edge and the self-delivery guard keyed on it. So each sugar
 * command is pinned to the exact catalog path (via `bindPath`, never a URL
 * literal) AND to the fields that make it sugar for THAT question rather than
 * a neighbouring one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPath } from '@tm8/contract';

import { run } from '../src/run.js';
import { CHAT_COMMANDS } from '../src/commands/chat.js';
import { isRegisteredPath } from '../src/commands/registry.js';
import { commandDiscovery, isCommandPath } from '../src/discovery/operations.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

type Reply = { status: number; json: unknown };

let server: Server;
let seen: Seen[] = [];
let reply: (seen: Seen) => Reply = () => envelope({});
let stdout: string[] = [];
let stderr: string[] = [];
let savedEnv: NodeJS.ProcessEnv;

function envelope(data: unknown): Reply {
  return { status: 200, json: { data, requestId: 'req_stub' } };
}

const SPACE = '018f0000-0000-7000-8000-0000000000f1';
const CHAT = '018f0000-0000-7000-8000-000000000c01';
const TEAMMATE = '018f0000-0000-7000-8000-000000000a01';
const PROJECT = '018f0000-0000-7000-8000-000000000b01';
const ABOUT = '018f0000-0000-7000-8000-000000000ab1';
const MESSAGE = '018f0000-0000-7000-8000-000000000c02';
const SESSION = '018f0000-0000-7000-8000-0000000005e5';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const record: Seen = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      };
      seen.push(record);
      const answer = reply(record);
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        'x-tm8-request-id': 'req_stub',
      });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  savedEnv = { ...process.env };
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // An empty XDG dir so a config file on the developer's own machine cannot
  // decide what these tests resolve.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tm8-chat-cfg-'));
  process.env.TM8_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TM8_SPACE_ID = SPACE;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_SESSION_ID;
  delete process.env.TM8_AGENT_TOKEN;
  seen = [];
  stdout = [];
  stderr = [];
  reply = () => envelope({});
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = savedEnv;
});

const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

// ---------------------------------------------------------------------------
// Registration and agreement with the projection.
// ---------------------------------------------------------------------------

describe('the module registers exactly its own rows, and the projection agrees', () => {
  it('owns the five chat paths and nothing else', () => {
    expect(CHAT_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'chat list',
      'chat send',
      'chat show',
      'chat start',
      'chat turns',
    ]);
  });

  it('every path is BOTH documented in the projection and wired into the registry', () => {
    for (const c of CHAT_COMMANDS) {
      expect(isCommandPath(c.path), `${c.path.join(' ')} is missing from the projection`).toBe(true);
      expect(isRegisteredPath(c.path), `${c.path.join(' ')} is missing from the registry`).toBe(true);
    }
  });

  /**
   * The distinction the whole lane rests on: `chat start` projects a REAL
   * catalog operation; the other four project operations that already existed.
   * Asserted as exact operation lists rather than "has some operation", because
   * an alias silently re-pointed at a neighbouring row would still be a
   * command, still be available, and answer a different question.
   */
  it('one command is a catalog row; four are aliases over doors that already existed', () => {
    expect(commandDiscovery(['chat', 'start'])?.operations).toEqual(['chat.start']);
    expect(commandDiscovery(['chat', 'list'])?.operations).toEqual(['collections.query']);
    expect(commandDiscovery(['chat', 'show'])?.operations).toEqual(['entities.context']);
    expect(commandDiscovery(['chat', 'send'])?.operations).toEqual(['messages.post']);
    expect(commandDiscovery(['chat', 'turns'])?.operations).toEqual([
      'entities.get', 'messages.list', 'messages.delivery.get',
    ]);
  });

  it('the noun is `chat` — `chat-thread` named a shape that no longer exists', () => {
    for (const c of CHAT_COMMANDS) expect(commandDiscovery(c.path)?.noun).toBe('chat');
  });
});

// ---------------------------------------------------------------------------
// chat start — the one new command.
// ---------------------------------------------------------------------------

describe('chat start', () => {
  const START = [
    'chat', 'start',
    '--teammate', TEAMMATE,
    '--model', 'claude-opus-5',
    '--mode', 'build',
    '--workdir', 'scratch',
  ];

  it('POSTs the frozen input to the catalog path, never a hand-written URL', async () => {
    reply = () => envelope({ chat: { id: CHAT, kind: 'chat', title: 'x', version: 1 }, messageId: MESSAGE });
    expect(await run([...START, 'open with this', '--format', 'json'])).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(bindPath('chat.start', {}));
    expect(seen[0]?.body).toMatchObject({
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'claude-opus-5',
      mode: 'build',
      workdirMode: 'scratch',
      body: 'open with this',
    });
    expect(typeof seen[0]?.body?.clientMutationId).toBe('string');
  });

  it('names the opening message, because that is the id the turn is watched by', async () => {
    reply = () => envelope({ chat: { id: CHAT, kind: 'chat', title: 'x', version: 1 }, messageId: MESSAGE });
    expect(await run([...START, 'hello'])).toBe(0);
    expect(out()).toContain(CHAT);
    expect(out()).toContain(MESSAGE);
  });

  it('carries --title, --about and --attach when given, and omits them when not', async () => {
    reply = () => envelope({ chat: { id: CHAT }, messageId: MESSAGE });
    await run([...START, 'hi', '--title', 'A chat', '--about', ABOUT, '--attach', MESSAGE]);
    expect(seen[0]?.body).toMatchObject({ title: 'A chat', aboutId: ABOUT, attachmentIds: [MESSAGE] });

    seen = [];
    await run([...START, 'hi']);
    expect(seen[0]?.body).not.toHaveProperty('title');
    expect(seen[0]?.body).not.toHaveProperty('aboutId');
    expect(seen[0]?.body).not.toHaveProperty('attachmentIds');
  });

  /**
   * Each required flag is proved SEPARATELY. A single "missing flags are
   * refused" test passes as soon as the FIRST check fires, which would leave
   * three unguarded flags behind a green assertion — and the Server applies no
   * default for any of the four, so an unguarded one becomes a 400 the caller
   * has to decode instead of a usage error naming the flag.
   */
  it.each([
    ['teammate', ['--model', 'm', '--mode', 'build', '--workdir', 'scratch']],
    ['model', ['--teammate', TEAMMATE, '--mode', 'build', '--workdir', 'scratch']],
    ['mode', ['--teammate', TEAMMATE, '--model', 'm', '--workdir', 'scratch']],
    ['workdir', ['--teammate', TEAMMATE, '--model', 'm', '--mode', 'build']],
  ])('requires --%s, and sends nothing without it', async (flag, args) => {
    expect(await run(['chat', 'start', ...args, 'body'])).toBe(2);
    expect(err()).toContain(`--${flag}`);
    expect(seen).toHaveLength(0);
  });

  it('names the WHOLE closed set on a bad --mode, and never sends a session mode', async () => {
    // `coordinator` is a real SESSION mode. A caller reaching for it here has
    // the wrong vocabulary, not a typo, so the diagnostic spells the set out.
    expect(await run([...START.slice(0, 6), '--mode', 'coordinator', '--workdir', 'scratch', 'b'])).toBe(2);
    expect(err()).toContain('ask|explain|plan|build|orchestrate|craft');
    expect(seen).toHaveLength(0);
  });

  it('refuses the workdir/project pairing in BOTH directions, before the wire', async () => {
    expect(await run([
      'chat', 'start', '--teammate', TEAMMATE, '--model', 'm', '--mode', 'ask',
      '--workdir', 'project', 'b',
    ])).toBe(2);
    expect(err()).toContain('--project');
    expect(seen).toHaveLength(0);

    expect(await run([...START, '--project', PROJECT, 'b'])).toBe(2);
    expect(err()).toMatch(/--project applies only to --workdir project/);
    expect(seen).toHaveLength(0);
  });

  it('sends projectId for a project chat', async () => {
    reply = () => envelope({ chat: { id: CHAT }, messageId: MESSAGE });
    await run([
      'chat', 'start', '--teammate', TEAMMATE, '--model', 'm', '--mode', 'ask',
      '--workdir', 'project', '--project', PROJECT, 'b',
    ]);
    expect(seen[0]?.body).toMatchObject({ workdirMode: 'project', projectId: PROJECT });
  });

  it('refuses an unknown flag rather than dropping it silently', async () => {
    expect(await run([...START, '--access-mode', 'fullAccess', 'b'])).toBe(2);
    expect(err()).toContain('--access-mode');
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The four sugar commands.
// ---------------------------------------------------------------------------

describe('chat list', () => {
  it('is collections.query narrowed to kinds:[chat] — the narrowing IS the command', async () => {
    reply = () => envelope({ page: { items: [], nextCursor: null } });
    expect(await run(['chat', 'list', '--format', 'json'])).toBe(0);
    expect(seen[0]?.path).toBe(bindPath('collections.query', {}));
    expect(seen[0]?.body).toMatchObject({ spaceId: SPACE, kinds: ['chat'] });
  });

  it('carries --limit and --cursor, and refuses --mutation-id on a read', async () => {
    reply = () => envelope({ page: { items: [] } });
    await run(['chat', 'list', '--limit', '5', '--cursor', 'c1']);
    expect(seen[0]?.body).toMatchObject({ limit: 5, cursor: 'c1' });

    seen = [];
    expect(await run(['chat', 'list', '--mutation-id', 'x'])).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('prints BOTH runtime and turn state — a cold chat may still owe a turn', async () => {
    reply = () => envelope({
      page: {
        items: [{
          id: CHAT, kind: 'chat', title: 'A chat', version: 3,
          state: { kind: 'chat', runtimeState: 'cold', turnState: 'queued', turnCount: 4 },
        }],
      },
    });
    expect(await run(['chat', 'list'])).toBe(0);
    expect(out()).toContain('cold/queued');
    expect(out()).toContain('4 turns');
  });

  it('says "no chats" rather than printing an empty page', async () => {
    reply = () => envelope({ page: { items: [] } });
    await run(['chat', 'list']);
    expect(out()).toContain('no chats');
  });
});

describe('chat show', () => {
  it('is entities.context on the chat id, with the three flags that bind', async () => {
    reply = () => envelope({ root: { id: CHAT, kind: 'chat' } });
    expect(await run([
      'chat', 'show', CHAT, '--sections', 'summary,messages',
      '--total-bytes', '8192', '--section-bytes', '2048', '--format', 'json',
    ])).toBe(0);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe(bindPath('entities.context', { id: CHAT }));
    expect(seen[0]?.query.get('sections')).toBe('summary,messages');
    expect(seen[0]?.query.get('totalBytes')).toBe('8192');
    expect(seen[0]?.query.get('sectionBytes')).toBe('2048');
  });

  it('requires a <chat-id> and sends nothing without one', async () => {
    expect(await run(['chat', 'show'])).toBe(2);
    expect(err()).toContain('<chat-id>');
    expect(seen).toHaveLength(0);
  });
});

describe('chat send', () => {
  it('is messages.post with the chat as the single anchor', async () => {
    reply = () => envelope({ messageBatchId: 'b1', messages: [{ id: MESSAGE }] });
    expect(await run(['chat', 'send', CHAT, 'a turn', '--format', 'json'])).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(bindPath('messages.post', {}));
    expect(seen[0]?.body).toMatchObject({ anchorIds: [CHAT], body: 'a turn' });
  });

  /**
   * THE FIELD THAT MAKES THIS SUGAR RATHER THAN A SECOND, WEAKER DOOR.
   * `workSessionId` is what records `authored_from` and what the chat's
   * self-delivery guard is keyed on. A `chat send` that dropped it would still
   * store the message and still exit 0 — and the chat would be handed a turn
   * with no source, which is precisely the shape 176's guard exists to refuse.
   */
  it('forwards the caller’s work-session id exactly as `message send` does', async () => {
    process.env.TM8_SESSION_ID = SESSION;
    reply = () => envelope({ messages: [{ id: MESSAGE }] });
    await run(['chat', 'send', CHAT, 'from a session']);
    expect(seen[0]?.body).toMatchObject({ workSessionId: SESSION });
  });

  it('omits workSessionId entirely for an ordinary human shell', async () => {
    reply = () => envelope({ messages: [{ id: MESSAGE }] });
    await run(['chat', 'send', CHAT, 'from a shell']);
    expect(seen[0]?.body).not.toHaveProperty('workSessionId');
  });

  it('carries --reply-to, --mention and --attach', async () => {
    reply = () => envelope({ messages: [{ id: MESSAGE }] });
    await run([
      'chat', 'send', CHAT, 'b',
      '--reply-to', MESSAGE, '--mention', TEAMMATE, '--attach', ABOUT,
    ]);
    expect(seen[0]?.body).toMatchObject({
      parentMessageId: MESSAGE, mentionIds: [TEAMMATE], attachmentIds: [ABOUT],
    });
  });

  it('requires a <chat-id> and a body, and sends nothing without either', async () => {
    expect(await run(['chat', 'send'])).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('chat turns', () => {
  it('reads the chat’s folded state AND its recent turns — two reads, two facts', async () => {
    reply = (s) => (s.path === bindPath('entities.get', { id: CHAT })
      ? envelope({
        id: CHAT, kind: 'chat',
        state: { kind: 'chat', runtimeState: 'live', turnState: 'running', turnCount: 7, lastTurnAt: '2026-09-03T10:00:00Z' },
      })
      : envelope({ items: [], nextCursor: null }));

    expect(await run(['chat', 'turns', CHAT])).toBe(0);
    expect(seen.map((s) => s.path)).toEqual([
      bindPath('entities.get', { id: CHAT }),
      bindPath('messages.list', { anchorId: CHAT }),
    ]);
    expect(seen[1]?.query.get('order')).toBe('newest');
    expect(out()).toContain('running');
    expect(out()).toContain('7 turns');
  });

  it('carries --limit and --cursor onto the message page', async () => {
    reply = (s) => (s.path.includes('/messages') ? envelope({ items: [] }) : envelope({ id: CHAT }));
    await run(['chat', 'turns', CHAT, '--limit', '3', '--cursor', 'c9']);
    expect(seen[1]?.query.get('limit')).toBe('3');
    expect(seen[1]?.query.get('cursor')).toBe('c9');
  });

  /**
   * The drilldown is the ONLY place a per-turn `chat_turns` state is reachable
   * on the wire, and it is one read rather than one per message on purpose.
   */
  it('--message reads exactly one delivery, and no entity or message page', async () => {
    reply = () => envelope({
      message: { id: MESSAGE },
      deliveries: [],
      chatTurns: [{ chatId: CHAT, turnId: 't-1', state: 'running' }],
    });
    expect(await run(['chat', 'turns', '--message', MESSAGE])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(bindPath('messages.delivery.get', { messageId: MESSAGE }));
    expect(out()).toContain('t-1');
    expect(out()).toContain('running');
  });

  /**
   * ADDITIVE-AND-OPTIONAL, so the two empties are DIFFERENT facts: a node that
   * predates the chat entity omits the key, and reporting that as "no turn" is
   * the wrong answer to "did my message wake this chat?".
   */
  it('distinguishes "this node cannot tell you" from "no turn was queued"', async () => {
    reply = () => envelope({ message: { id: MESSAGE }, deliveries: [] });
    await run(['chat', 'turns', '--message', MESSAGE]);
    expect(out()).toMatch(/did not report them/);

    stdout = [];
    reply = () => envelope({ message: { id: MESSAGE }, deliveries: [], chatTurns: [] });
    await run(['chat', 'turns', '--message', MESSAGE]);
    expect(out()).toMatch(/queued no turn/);
  });

  it('refuses a <chat-id> beside --message rather than letting the two disagree', async () => {
    expect(await run(['chat', 'turns', CHAT, '--message', MESSAGE])).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
