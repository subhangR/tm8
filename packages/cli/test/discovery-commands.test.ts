/**
 * The discovery COMMANDS, end-to-end through `run()`, plus the registry
 * invariant that will catch a future slot wiring a command it forgot to
 * document — or documenting one it forgot to wire.
 *
 * The registry and the projection answer two DIFFERENT questions and both
 * answers are load-bearing:
 *
 *   the PROJECTION  = what the grammar contains        (99 command paths)
 *   the REGISTRY    = what this CLI build can execute  (a growing subset)
 *
 * So a path in neither is exit 2 "unknown command", and a path in the
 * projection but not the registry is exit 8 "documented, not built here" with a
 * pointer at its help. Collapsing those two into one answer is how an agent
 * concludes a command does not exist when it simply has not landed yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { COMMANDS, isRegisteredPath } from '../src/commands/registry.js';
import { run } from '../src/run.js';
import { byteLength, CAPS } from '../src/discovery/help.js';
import { COMMAND_PATHS, commandDiscovery, isCommandPath } from '../src/discovery/operations.js';
import { AvailabilityLedger } from '../src/discovery/availability.js';

let server: Server;
let baseUrl: string;
let requests: string[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ data: { kinds: [] }, requestId: 'req_test' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  requests = [];
  stdout = [];
  stderr = [];
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = 'spc_test';
  delete process.env.TM8_CONFIG_PATH;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

describe('the registry is composed from per-noun modules, and agrees with the projection', () => {
  it('every REGISTERED command path is documented in the help projection', () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    for (const c of COMMANDS) {
      if (c.path[0] === 'help' || c.path[0] === 'completion' || c.path[0] === 'worker') continue;
      expect(
        isCommandPath(c.path),
        `\`${c.path.join(' ')}\` is wired but absent from the help projection`,
      ).toBe(true);
      expect(commandDiscovery(c.path)?.syntax, c.path.join(' ')).toContain('tm8 ');
    }
  });

  it('every registered command path is REACHABLE through dispatch, never "unknown command"', async () => {
    let reached = 0;
    for (const c of COMMANDS) {
      stderr = [];
      stdout = [];
      await run([...c.path, '--help']);
      expect(err(), c.path.join(' ')).not.toMatch(/unknown command/);
      reached++;
    }
    expect(reached).toBe(COMMANDS.length);
  });

  it('registration is unique — two modules cannot claim one path', () => {
    const keys = COMMANDS.map((c) => c.path.join(' '));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the projection holds 123 command paths; the registry is an honest subset of them', () => {
    // 126 catalog rows − 3 with no command (project directory browser,
    // execution.prompt, bridge.fetchBlob) = 123 command-bearing rows.
    // 121 -> 125 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
    // = 116 rows that have one; `files.uploadInit` + `files.uploadComplete` share
    // `file upload` and `artifacts.create` + `artifacts.publish` share
    // `artifact publish` ⇒ 113 DISTINCT paths.
    expect(COMMAND_PATHS).toHaveLength(123);
    const registered = COMMANDS.filter((c) => isCommandPath(c.path));
    expect(registered.length).toBeLessThanOrEqual(COMMAND_PATHS.length);
    expect(registered.length).toBeGreaterThan(0);
  });
});

describe('tm8 help — the root shard', () => {
  it('is exit 0 with DATA on stdout and nothing on stderr', async () => {
    expect(await run(['help'])).toBe(0);
    expect(out()).toContain('entity');
    expect(stderr).toEqual([]);
  });

  it('--format json emits tm8.help.v1 inside the 8 KiB cap', async () => {
    expect(await run(['help', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { schemaVersion: string; nouns: unknown[] };
    expect(dto.schemaVersion).toBe('tm8.help.v1');
    expect(dto.nouns.length).toBeGreaterThanOrEqual(26);
    expect(byteLength(dto)).toBeLessThanOrEqual(CAPS.root);
  });

  it('names the timeout unit in human output', async () => {
    expect(await run(['help'])).toBe(0);
    expect(out()).toContain('--timeout <seconds>');
  });
});

describe('tm8 help <noun> and <noun> <verb>', () => {
  it('a noun shard lists that noun commands', async () => {
    expect(await run(['help', 'message', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { schemaVersion: string; commands: { command: string }[] };
    expect(dto.schemaVersion).toBe('tm8.help.noun.v1');
    expect(dto.commands.map((c) => c.command)).toContain('message send');
  });

  it('a command shard renders exact syntax', async () => {
    expect(await run(['help', 'message', 'send', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { schemaVersion: string; syntax: string };
    expect(dto.schemaVersion).toBe('tm8.help.command.v1');
    expect(dto.syntax).toContain('tm8 message send --to');
  });

  it('`tm8 <command> --help` renders the same command shard, even when unwired', async () => {
    expect(await run(['message', 'send', '--help', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { command: string };
    expect(dto.command).toBe('message send');
    expect(requests).toEqual([]);
  });

  it('an unknown noun is a usage error that points at discovery', async () => {
    expect(await run(['help', 'nonsense'])).toBe(2);
    expect(err()).toMatch(/tm8 help/);
    expect(stdout).toEqual([]);
  });
});

describe('tm8 help --query and --operation', () => {
  it('--query returns at most five ranked matches', async () => {
    expect(await run(['help', '--query', 'reply to the coordinator', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { schemaVersion: string; matches: { command: string }[] };
    expect(dto.schemaVersion).toBe('tm8.help.search.v1');
    expect(dto.matches.length).toBeLessThanOrEqual(5);
    expect(dto.matches[0]?.command).toBe('message send');
  });

  it('--operation works for an INTERNAL row and renders no invocation', async () => {
    expect(await run(['help', '--operation', 'execution.prompt', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as Record<string, unknown>;
    expect(dto.exposure).toBe('internal');
    expect(dto.reason).toBe('use_message_send');
    expect(dto.syntax).toBeNull();
    expect(out()).not.toContain('session prompt');
  });

  it('--operation works for a RESERVED row with no command', async () => {
    expect(await run(['help', '--operation', 'bridge.fetchBlob', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as Record<string, unknown>;
    expect(dto.command).toBeNull();
    expect(dto.availabilityReason).toBe('reserved');
  });

  it('an unknown operation name is exit 2, never a fabricated row', async () => {
    expect(await run(['help', '--operation', 'entities.yeet'])).toBe(2);
    expect(stdout).toEqual([]);
    expect(err()).toMatch(/entities\.yeet/);
  });

  it('no help surface ever touches the network', async () => {
    await run(['help']);
    await run(['help', 'entity']);
    await run(['help', 'entity', 'get']);
    await run(['help', '--query', 'anything']);
    await run(['help', '--operation', 'identity.get']);
    expect(requests).toEqual([]);
  });
});

describe('tm8 completion', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    it(`emits a ${shell} script on stdout`, async () => {
      expect(await run(['completion', shell])).toBe(0);
      expect(out().length).toBeGreaterThan(200);
      expect(out()).toContain('tm8');
      expect(stderr).toEqual([]);
    });
  }

  it('offers every documented noun, so completion and help cannot disagree', async () => {
    await run(['completion', 'bash']);
    for (const noun of ['entity', 'message', 'task', 'session', 'search']) {
      expect(out(), noun).toContain(noun);
    }
  });

  it('an unsupported shell is a usage error naming the three that work', async () => {
    expect(await run(['completion', 'powershell'])).toBe(2);
    expect(err()).toMatch(/bash/);
    expect(err()).toMatch(/zsh/);
    expect(err()).toMatch(/fish/);
  });

  it('a missing shell argument is a usage error', async () => {
    expect(await run(['completion'])).toBe(2);
  });
});

describe('tm8 search query — the ASYMMETRIC reserved command', () => {
  it('exists, refuses honestly with exit 8, and sends NOTHING', async () => {
    expect(await run(['search', 'query', 'anything'])).toBe(8);
    expect(requests).toEqual([]);
    expect(err()).toMatch(/reserved/i);
    expect(err()).toMatch(/not_implemented|not implemented/);
  });

  it('names what to use instead rather than leaving a dead end', async () => {
    await run(['search', 'query', 'anything']);
    expect(err()).toMatch(/entity query/);
  });

  it('a missing search text is a usage error, not a silent empty search', async () => {
    expect(await run(['search', 'query'])).toBe(2);
  });

  it('bridge.fetchBlob has NO command — the asymmetry holds at the router too', async () => {
    expect(await run(['bridge', 'fetch-blob', 'file_1'])).toBe(2);
    expect(err()).toMatch(/unknown command/);
  });
});

describe('tm8 kind — a real catalog-backed command', () => {
  it('kind list reaches the catalog-bound route', async () => {
    expect(await run(['kind', 'list', '--space', 'spc_1'])).toBe(0);
    expect(requests).toEqual(['GET /v2/spaces/spc_1/entity-kinds']);
  });

  it('kind create refuses a name outside the `c:` namespace before any request', async () => {
    expect(await run(['kind', 'create', 'task', '--schema', '[]'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toMatch(/c:/);
  });

  it('kind create sends the custom kind to the catalog-bound route', async () => {
    const schema = '[{"name":"servings","type":"number"}]';
    expect(await run(['kind', 'create', 'c:recipe', '--schema', schema])).toBe(0);
    expect(requests).toEqual(['POST /v2/spaces/spc_test/entity-kinds']);
  });

  it('--schema given an object instead of a field-definition ARRAY fails locally', async () => {
    expect(await run(['kind', 'create', 'c:recipe', '--schema', '{"type":"object"}'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toMatch(/ARRAY/);
  });

  it('kind update requires something to change', async () => {
    expect(await run(['kind', 'update', 'c:recipe'])).toBe(2);
    expect(requests).toEqual([]);
  });

  it('a read refuses --mutation-id rather than accepting a meaningless one', async () => {
    expect(await run(['kind', 'list', '--mutation-id', 'x'])).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('documented-but-unwired is exit 8, NOT "unknown command"', () => {
  /**
   * THIS TEST'S ORIGINAL PREMISE EXPIRED, AND IT WENT RED RATHER THAN ROTTING.
   *
   * It used to hardcode `entity get` as "in the grammar, not yet wired". Once
   * the final domain modules were registered, `entity get` became wired and the
   * assertion `isRegisteredPath(...) === false` failed. That is the GOOD
   * outcome: it asserted a NEGATIVE, so the fix could not silently un-test it.
   * Had it asserted only `exit === 8` it would have passed for a completely
   * different reason and nobody would have looked.
   *
   * Derived from the registry now, never hardcoded, so it cannot expire twice.
   */
  const unwired = COMMAND_PATHS.filter((p) => !isRegisteredPath(p)).map((p) => p.join(' '));

  it('EVERY command in the frozen grammar is wired into the registry', () => {
    // Non-vacuity: a grammar that had become empty would trivially be "all
    // wired". Pin the floor against the catalog's own command count.
    expect(COMMAND_PATHS.length).toBeGreaterThan(90);
    expect(unwired).toEqual([]);
  });

  it.skipIf(unwired.length === 0)(
    'a real grammar command with no handler says so and points at its help',
    async () => {
      const path = (unwired[0] as string).split(' ');
      expect(isCommandPath(path)).toBe(true);
      expect(await run([...path, 'x'])).toBe(8);
      expect(err()).toMatch(new RegExp(`tm8 help ${path.join(' ')}`));
      expect(requests).toEqual([]);
    },
  );

  it('NOT MEASURED, recorded deliberately: the documented-but-unwired branch has no live example', () => {
    // `run.ts` still distinguishes "in the grammar but not implemented in THIS
    // BUILD" (exit 8) from "unknown command" (exit 2). With every command wired
    // there is no real path that reaches the first branch, so this suite CANNOT
    // exercise it and does not pretend to. Saying so out loud beats a green that
    // implies coverage nobody has.
    //
    // It also collapses the exit-8-has-two-causes trap for real commands: an
    // exit 8 from the built binary can now only be the Server's honest 501, not
    // a wiring gap. If `unwired` ever becomes non-empty the assertion above goes
    // red and the skipped test above starts running — both directions covered.
    expect(unwired.length).toBe(0);
  });

  it('a path in NEITHER is still exit 2 — the closed registry property holds', async () => {
    expect(await run(['entity', 'yeet', 'ent_1'])).toBe(2);
    expect(err()).toMatch(/unknown command/);
  });
});

describe('retired vocabulary keeps its discovery hint and gains an intent pointer (D6)', () => {
  for (const argv of [['whoami'], ['session', 'prompt', 'ws_1', 'hi'], ['progress', 'ent_1', 'hi']]) {
    it(`\`tm8 ${argv.join(' ')}\` fails with a hint and sends nothing`, async () => {
      expect(await run(argv)).toBe(2);
      expect(err()).toMatch(/no longer exists/);
      expect(err()).toMatch(/tm8 help/);
      expect(requests).toEqual([]);
    });
  }
});

describe('availability is observed from calls the caller already made', () => {
  it('a 501 on a real call marks THAT operation unavailable, and nothing else', async () => {
    const l = new AvailabilityLedger();
    l.record('entityKinds.list', 'not_implemented');
    expect(l.observed('entityKinds.list')).toBe('not_implemented');
    expect(l.observed('entityKinds.create')).toBeUndefined();
  });
});
