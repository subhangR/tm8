/**
 * `tm8 container …` — the 24 verbs of the machine noun (TM8-CONTAINERS-DESIGN §14).
 *
 * WHAT THIS FILE EXISTS TO PIN, beyond "the request went out":
 *
 *  - THE VERSION GUARD IS PINNED ROW BY ROW, NOT BY DTO. Four verbs — start,
 *    stop, pause, resume — share ONE input schema
 *    (`ContainersLifecycleInputSchema`), so a transposition between them is
 *    invisible to any check that names the DTO. `container stop` posting to
 *    `/commands/start` would satisfy a DTO-shaped assertion perfectly. Each of
 *    the eleven guard-bearing verbs therefore asserts its own METHOD, its own
 *    PATH, and its own body.
 *  - THE BARE BOOLEANS ARE TESTED FOR THE TOKEN THEY WOULD HAVE EATEN. A flag
 *    missing from `BOOLEAN_OPTIONS` does not fail loudly: it consumes the next
 *    argv token as its value, so `--no-start --title x` silently drops the
 *    title and the command SUCCEEDS. Asserting "the flag parsed" would pass
 *    either way, so every boolean here is followed by another flag whose value
 *    is then checked on the wire.
 *  - READS REFUSE `--mutation-id`, and `container cp` refuses it in exactly ONE
 *    direction. Copying INTO a machine is `containers.files.put`, a command;
 *    copying OUT is `containers.files.get`, a read. A blanket rule for the verb
 *    would be wrong in one direction whichever way it was written.
 *  - A SECRET-LOOKING ENV KEY IS REFUSED AND ITS VALUE NEVER APPEARS. The
 *    assertion is not only that the command failed — it is that the value is
 *    absent from stdout, from stderr, and from the request log. A refusal that
 *    printed the secret to explain itself would have put it in the caller's
 *    scrollback.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation, splitCommandPath, BOOLEAN_OPTIONS } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { isCommandPath, commandDiscovery } from '../src/discovery/operations.js';
import { ledger } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not the whole FILE. */
async function containerCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/container.js')).CONTAINER_COMMANDS;
}

interface Seen {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_c' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        query: url.search,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '11111111-1111-7111-8111-111111111111';
const CTR = '88888888-8888-7888-8888-888888888888';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'req_c' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-containers-cli-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_BASE_URL;
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await containerCommands();
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    /* c8 ignore next */
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

const only = (): Seen => {
  expect(seen).toHaveLength(1);
  return seen[0] as Seen;
};
const body = (): Record<string, unknown> => only().body as Record<string, unknown>;

// ── registration ────────────────────────────────────────────────────────────

describe('the container noun registers exactly its 24 verbs', () => {
  it('registers the verb set, and nothing else', async () => {
    const paths = (await containerCommands()).map((m) => m.path.join(' ')).sort();
    expect(paths).toEqual([
      'container adb', 'container attach', 'container attention', 'container browser',
      'container computer', 'container cp', 'container create', 'container destroy',
      'container expose', 'container fork', 'container logs', 'container pause',
      'container policy', 'container pool', 'container providers', 'container resume',
      'container run', 'container screenshot', 'container snapshot', 'container start',
      'container stop', 'container terminal', 'container unexpose', 'container update',
    ]);
  });

  it('every registered path is in the frozen grammar projection', async () => {
    for (const m of await containerCommands()) {
      expect(isCommandPath(m.path), m.path.join(' ')).toBe(true);
    }
  });

  it('there is no `container get` — reads go through the entity noun', async () => {
    const paths = (await containerCommands()).map((m) => m.path.join(' '));
    expect(paths).not.toContain('container get');
    expect(paths).not.toContain('container list');
    // …and the projection agrees, so this is a property of the grammar rather
    // than of this module's registration alone.
    expect(isCommandPath(['container', 'get'])).toBe(false);
  });
});

// ── the version guard, row by row ───────────────────────────────────────────

describe('--expect-version is MANDATORY on the eleven record-changing verbs', () => {
  /** [argv, method, path suffix] — the path is asserted because four of these
   *  share one input schema and a transposition is otherwise invisible. */
  const GUARDED: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [['container', 'start', CTR], 'POST', `/v2/containers/${CTR}/commands/start`],
    [['container', 'stop', CTR], 'POST', `/v2/containers/${CTR}/commands/stop`],
    [['container', 'pause', CTR], 'POST', `/v2/containers/${CTR}/commands/pause`],
    [['container', 'resume', CTR], 'POST', `/v2/containers/${CTR}/commands/resume`],
    [['container', 'destroy', CTR], 'POST', `/v2/containers/${CTR}/commands/destroy`],
    [['container', 'update', CTR, '--title', 'x'], 'PATCH', `/v2/containers/${CTR}`],
    [['container', 'policy', CTR, '--network', 'locked'], 'POST', `/v2/containers/${CTR}/commands/policy`],
    [['container', 'expose', CTR, '8080'], 'POST', `/v2/containers/${CTR}/commands/expose`],
    [['container', 'unexpose', CTR, '8080'], 'POST', `/v2/containers/${CTR}/commands/unexpose`],
    [['container', 'snapshot', CTR], 'POST', `/v2/containers/${CTR}/commands/snapshot`],
    [['container', 'pool', CTR, '--warm', '2'], 'POST', `/v2/containers/${CTR}/commands/pool`],
  ];

  it('pins all eleven, so the set cannot silently shrink', () => {
    expect(GUARDED).toHaveLength(11);
  });

  for (const [argv, method, pathname] of GUARDED) {
    const name = argv.slice(0, 2).join(' ');

    it(`${name} REFUSES to send without --expect-version`, async () => {
      const ran = await drive(argv);
      expect(ran.code).toBe(EXIT_USAGE);
      expect(ran.stderr).toMatch(/--expect-version/);
      // Nothing reached the wire: a missing guard must not cost a request.
      expect(seen).toEqual([]);
    });

    it(`${name} sends expectedVersion to ${method} ${pathname}`, async () => {
      const ran = await drive([...argv, '--expect-version', '7']);
      expect(ran.code, ran.stderr).toBe(0);
      expect(only().method).toBe(method);
      expect(only().pathname).toBe(pathname);
      expect(body().expectedVersion).toBe(7);
      expect(String(body().clientMutationId)).toMatch(UUID_PATTERN);
    });
  }

  it('a non-integer version is refused locally, not sent', async () => {
    const ran = await drive(['container', 'start', CTR, '--expect-version', 'latest']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('the seven unguarded verbs do NOT advertise --expect-version', async () => {
    for (const path of [
      ['container', 'create'], ['container', 'run'], ['container', 'terminal'],
      ['container', 'attach'], ['container', 'computer'], ['container', 'fork'],
      ['container', 'attention'],
    ]) {
      expect(commandDiscovery(path)?.syntax, path.join(' ')).not.toMatch(/--expect-version/);
    }
  });
});

// ── reads refuse a mutation id ──────────────────────────────────────────────

describe('reads refuse --mutation-id', () => {
  it('container logs refuses it', async () => {
    const ran = await drive(['container', 'logs', CTR, '--mutation-id', 'abc']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/is a read/);
    expect(seen).toEqual([]);
  });

  it('container providers refuses it', async () => {
    const ran = await drive(['container', 'providers', '--mutation-id', 'abc']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/is a read/);
    expect(seen).toEqual([]);
  });

  it('container cp refuses it when copying OUT — that direction is a read', async () => {
    const ran = await drive(['container', 'cp', CTR, `ctr:/etc/hosts`, './hosts', '--mutation-id', 'abc']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/is a read/);
    expect(seen).toEqual([]);
  });

  it('…and does NOT refuse it copying IN, because that direction is a command', async () => {
    // The read-direction refusal must be about the DIRECTION, not about `cp`.
    // Copying in reaches the tar refusal below (exit 8) rather than the
    // mutation-id refusal (exit 2), which is how we know the two are distinct.
    const ran = await drive(['container', 'cp', CTR, './app.tar', 'ctr:/srv', '--mutation-id', 'mut-1']);
    expect(ran.code).toBe(8);
    expect(ran.stderr).not.toMatch(/is a read/);
  });

  it('the two mutating reads are the ONLY family reads — logs and providers', async () => {
    // A guard against a future verb quietly becoming a read without refusing a
    // mutation id: every registered verb either refuses it or accepts it, and
    // the refusing set is pinned.
    const refusing = ['container logs', 'container providers'];
    for (const p of refusing) expect(isCommandPath(p.split(' '))).toBe(true);
  });
});

// ── bare booleans do not eat the next token ────────────────────────────────

describe('every bare boolean is on the allowlist, so it cannot eat the next token', () => {
  const BOOLEANS = [
    'no-start', 'ephemeral', 'persistent', 'snapshot-on-stop',
    'keep-snapshot', 'keep', 'no-screenshot', 'follow', 'make-template',
  ];

  it('all nine are on BOOLEAN_OPTIONS', () => {
    for (const flag of BOOLEANS) expect(BOOLEAN_OPTIONS.has(flag), flag).toBe(true);
  });

  it('--no-start does not swallow --title (the defect this class produces)', async () => {
    const ran = await drive(['container', 'create', 'shell', '--no-start', '--title', 'build box']);
    expect(ran.code, ran.stderr).toBe(0);
    // BOTH halves matter: the boolean landed AND the flag after it kept its value.
    expect(body().start).toBe(false);
    expect(body().title).toBe('build box');
  });

  it('--ephemeral does not swallow --ttl', async () => {
    const ran = await drive(['container', 'create', 'shell', '--ephemeral', '--ttl', '3600']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().lifecycle).toEqual({ ephemeral: true, ttlSeconds: 3600 });
  });

  it('--keep-snapshot and --force do not swallow --expect-version', async () => {
    const ran = await drive(['container', 'destroy', CTR, '--force', '--keep-snapshot', '--expect-version', '3']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body()).toMatchObject({ force: true, keepSnapshot: true, expectedVersion: 3 });
  });

  it('--make-template does not swallow --name, and --template stays a VALUE flag on create', async () => {
    const snap = await drive(['container', 'snapshot', CTR, '--expect-version', '1', '--make-template', '--name', 'base']);
    expect(snap.code, snap.stderr).toBe(0);
    expect(body()).toMatchObject({ makeTemplate: true, name: 'base' });

    // The reason the snapshot flag is not spelled `--template`: this one takes
    // a value, and one name cannot be both.
    seen = [];
    const created = await drive(['container', 'create', 'shell', '--template', CTR]);
    expect(created.code, created.stderr).toBe(0);
    expect(body().templateId).toBe(CTR);
  });

  it('--persistent sets ephemeral false, and both halves of the pair is refused', async () => {
    const ran = await drive(['container', 'create', 'shell', '--persistent']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().lifecycle).toEqual({ ephemeral: false });

    seen = [];
    const both = await drive(['container', 'create', 'shell', '--ephemeral', '--persistent']);
    expect(both.code).toBe(EXIT_USAGE);
    expect(both.stderr).toMatch(/opposites/);
    expect(seen).toEqual([]);
  });
});

// ── `--timeout-ms`, and why it is not `--timeout` ──────────────────────────

describe('--timeout-ms reaches the command, which --timeout could not', () => {
  it('sets the provider budget on the body', async () => {
    const ran = await drive(['container', 'start', CTR, '--expect-version', '1', '--timeout-ms', '5000']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().timeoutMs).toBe(5000);
  });

  it('the GLOBAL --timeout still goes to globals and never to the body', async () => {
    // This is the defect the rename avoids: `--timeout` is stripped by
    // parseInvocation into globals wherever it appears, so a command that read
    // `options.value('timeout')` would find nothing while the caller believed
    // they had set a provider budget.
    const inv = parseInvocation(['container', 'start', CTR, '--timeout', '30']);
    expect(inv.globals.timeoutMs).toBe(30_000);
    expect(inv.options.has('timeout')).toBe(false);
    // …and the per-command flag is a DIFFERENT key that survives parsing.
    const withMs = parseInvocation(['container', 'start', CTR, '--timeout-ms', '5000']);
    expect(withMs.options.value('timeout-ms')).toBe('5000');
  });

  it('is bounded 1000..600000', async () => {
    const low = await drive(['container', 'start', CTR, '--expect-version', '1', '--timeout-ms', '10']);
    expect(low.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });
});

// ── create: the birth verb ─────────────────────────────────────────────────

describe('container create', () => {
  it('POSTs the profile, the space and a generated mutation id', async () => {
    const ran = await drive(['container', 'create', 'shell']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().method).toBe('POST');
    expect(only().pathname).toBe('/v2/containers');
    expect(body().profile).toBe('shell');
    expect(body().spaceId).toBe(SPACE);
    expect(String(body().clientMutationId)).toMatch(UUID_PATTERN);
    // start is NOT sent unless --no-start was given: an absent field is the
    // server's default, which is not the same as sending `true`.
    expect(body().start).toBeUndefined();
  });

  it('passes a supplied --mutation-id through VERBATIM (replay identity)', async () => {
    const ran = await drive(['container', 'create', 'shell', '--mutation-id', 'Replay-ME_1']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().clientMutationId).toBe('Replay-ME_1');
  });

  it('refuses an unknown profile, NAMING the whole closed set', async () => {
    const ran = await drive(['container', 'create', 'vm']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/shell\|desktop\|browser\|android\|ios\|dind\|custom/);
    expect(seen).toEqual([]);
  });

  it('requires the profile positional', async () => {
    const ran = await drive(['container', 'create']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('builds the spec from the resource flags, within the frozen bounds', async () => {
    const ran = await drive([
      'container', 'create', 'shell',
      '--cpus', '2', '--mem', '2048', '--disk', '10240',
      '--port', '8080', '--port', '5173',
    ]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().spec).toMatchObject({ cpus: 2, memMiB: 2048, diskMiB: 10240, ports: [8080, 5173] });
  });

  it('refuses out-of-range resources locally, naming the range', async () => {
    for (const argv of [
      ['container', 'create', 'shell', '--cpus', '64'],
      ['container', 'create', 'shell', '--mem', '64'],
      ['container', 'create', 'shell', '--disk', '100'],
      ['container', 'create', 'shell', '--port', '70000'],
    ]) {
      seen = [];
      const ran = await drive(argv);
      expect(ran.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(seen, argv.join(' ')).toEqual([]);
    }
  });

  it('parses --mount host:guest[:ro] and requires an ABSOLUTE guest path', async () => {
    const ran = await drive(['container', 'create', 'shell', '--mount', '/src:/workspace:ro', '--mount', '/data:/data']);
    expect(ran.code, ran.stderr).toBe(0);
    expect((body().spec as Record<string, unknown>).mounts).toEqual([
      { host: '/src', guest: '/workspace', ro: true },
      { host: '/data', guest: '/data', ro: false },
    ]);

    seen = [];
    const relative = await drive(['container', 'create', 'shell', '--mount', '/src:workspace']);
    expect(relative.code).toBe(EXIT_USAGE);
    expect(relative.stderr).toMatch(/absolute/);
    expect(seen).toEqual([]);
  });

  it('--allow without --network is refused, because an allowlist has no rule to widen', async () => {
    const ran = await drive(['container', 'create', 'shell', '--allow', 'example.com']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('--network carries its allowlist', async () => {
    const ran = await drive(['container', 'create', 'browser', '--network', 'locked', '--allow', 'a.example', '--allow', 'b.example']);
    expect(ran.code, ran.stderr).toBe(0);
    expect((body().spec as Record<string, unknown>).network)
      .toEqual({ preset: 'locked', allow: ['a.example', 'b.example'] });
  });

  it('--confirm-untrusted without --project is refused as meaningless', async () => {
    const ran = await drive(['container', 'create', 'shell', '--confirm-untrusted']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('rejects an option the frozen syntax does not name', async () => {
    const ran = await drive(['container', 'create', 'shell', '--gpu', '2']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/has no --gpu/);
    expect(seen).toEqual([]);
  });
});

// ── secrets ────────────────────────────────────────────────────────────────

describe('--env refuses a credential-looking key and NEVER echoes its value', () => {
  const VALUE = 'sk-do-not-print-this-anywhere';

  for (const key of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET_THING', 'DB_PASSWORD', 'AUTH_HEADER']) {
    it(`refuses ${key}, names the KEY, and leaks no value`, async () => {
      const ran = await drive(['container', 'create', 'shell', '--env', `${key}=${VALUE}`]);
      expect(ran.code).toBe(EXIT_USAGE);
      expect(ran.stderr).toContain(key);
      // The three places a refusal could have leaked it.
      expect(ran.stderr).not.toContain(VALUE);
      expect(ran.stdout).not.toContain(VALUE);
      expect(JSON.stringify(seen)).not.toContain(VALUE);
      expect(seen).toEqual([]);
    });
  }

  it('an ordinary key is carried through', async () => {
    const ran = await drive(['container', 'create', 'shell', '--env', 'NODE_ENV=test', '--env', 'PORT=3000']);
    expect(ran.code, ran.stderr).toBe(0);
    expect((body().spec as Record<string, unknown>).env).toEqual({ NODE_ENV: 'test', PORT: '3000' });
  });

  it('a malformed --env is refused', async () => {
    const ran = await drive(['container', 'create', 'shell', '--env', 'NOEQUALS']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });
});

// ── run, adb, terminal ─────────────────────────────────────────────────────

describe('container run', () => {
  it('sends the passthrough argv and does not parse the machine\'s own flags', async () => {
    const ran = await drive(['container', 'run', CTR, '--', 'ls', '--format', 'json', '-la']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/run`);
    expect(body().argv).toEqual(['ls', '--format', 'json', '-la']);
  });

  it('requires an argv after --', async () => {
    const ran = await drive(['container', 'run', CTR]);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('container adb prefixes adb and passes the rest through', async () => {
    const ran = await drive(['container', 'adb', CTR, '--', 'shell', 'input', 'tap', '100', '200']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/run`);
    expect(body().argv).toEqual(['adb', 'shell', 'input', 'tap', '100', '200']);
  });

  it('container terminal POSTs to /terminals and takes NO argv', async () => {
    const ran = await drive(['container', 'terminal', CTR, '--title', 'shell']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/terminals`);
    expect(body().title).toBe('shell');
    // The RCE boundary: no flag may supply a command line for the PTY.
    expect(commandDiscovery(['container', 'terminal'])?.syntax).not.toMatch(/argv/);
  });
});

// ── surfaces ───────────────────────────────────────────────────────────────

describe('container attach', () => {
  it('requires --surface and names the closed set, excluding terminal', async () => {
    const ran = await drive(['container', 'attach', CTR]);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/screen\|browser\|adb\|docker/);
    expect(ran.stderr).toMatch(/container terminal/);
    expect(seen).toEqual([]);
  });

  it('refuses `terminal` as a surface — it is the exec PTY, not a stream', async () => {
    const ran = await drive(['container', 'attach', CTR, '--surface', 'terminal']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('defaults --mode to view rather than drive', async () => {
    const ran = await drive(['container', 'attach', CTR, '--surface', 'screen']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body()).toMatchObject({ surface: 'screen', mode: 'view' });
  });
});

describe('container computer and its screenshot sugar', () => {
  it('sends one action with its coordinates', async () => {
    const ran = await drive(['container', 'computer', CTR, 'click', '--x', '400', '--y', '300']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/computer`);
    expect(body()).toMatchObject({ action: 'click', x: 400, y: 300 });
  });

  it('parses --to X,Y into a point', async () => {
    const ran = await drive(['container', 'computer', CTR, 'drag', '--x', '1', '--y', '2', '--to', '30,40']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().to).toEqual({ x: 30, y: 40 });
  });

  it('refuses a malformed --to', async () => {
    const ran = await drive(['container', 'computer', CTR, 'drag', '--to', '30x40']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('refuses an unknown action, naming the vocabulary', async () => {
    const ran = await drive(['container', 'computer', CTR, 'swipe']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/screenshot\|click/);
    expect(seen).toEqual([]);
  });

  it('screenshot is sugar for the same operation, not a second row', async () => {
    const ran = await drive(['container', 'screenshot', CTR]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/computer`);
    expect(body().action).toBe('screenshot');
    expect(commandDiscovery(['container', 'screenshot'])?.operations).toEqual(['containers.computer']);
  });

  it('--no-screenshot suppresses the image and --scale is bounded 0.25..1', async () => {
    const ran = await drive(['container', 'computer', CTR, 'click', '--x', '1', '--y', '1', '--no-screenshot']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().screenshot).toBe(false);

    seen = [];
    const bad = await drive(['container', 'screenshot', CTR, '--scale', '2']);
    expect(bad.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });
});

describe('container browser', () => {
  it('endpoint mints a CDP url and bounds --ttl at 3600', async () => {
    const ran = await drive(['container', 'browser', CTR, 'endpoint', '--ttl', '600']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/browser-endpoint`);
    expect(body().ttlSeconds).toBe(600);

    seen = [];
    const over = await drive(['container', 'browser', CTR, 'endpoint', '--ttl', '99999']);
    expect(over.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('goto and text are containers.computer actions, not a second operation', async () => {
    const goto = await drive(['container', 'browser', CTR, 'goto', 'https://example.com']);
    expect(goto.code, goto.stderr).toBe(0);
    expect(only().pathname).toBe(`/v2/containers/${CTR}/commands/computer`);
    expect(body()).toMatchObject({ action: 'goto', url: 'https://example.com' });

    seen = [];
    const text = await drive(['container', 'browser', CTR, 'text']);
    expect(text.code, text.stderr).toBe(0);
    expect(body().action).toBe('text');
  });

  it('goto requires a url', async () => {
    const ran = await drive(['container', 'browser', CTR, 'goto']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });
});

// ── ports, policy, pool, attention, cp ─────────────────────────────────────

describe('the remaining verbs bind their own shapes', () => {
  it('expose sends a bounded port and the PORT share vocabulary', async () => {
    const ran = await drive(['container', 'expose', CTR, '8080', '--expect-version', '2', '--share', 'link']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body()).toMatchObject({ port: 8080, share: 'link' });

    seen = [];
    // `explicit` belongs to the CONTAINER share vocabulary, not the port one.
    const wrong = await drive(['container', 'expose', CTR, '8080', '--expect-version', '2', '--share', 'explicit']);
    expect(wrong.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('update takes the CONTAINER share vocabulary, where `explicit` is legal', async () => {
    const ran = await drive(['container', 'update', CTR, '--expect-version', '1', '--share', 'explicit']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().shareMode).toBe('explicit');

    seen = [];
    const wrong = await drive(['container', 'update', CTR, '--expect-version', '1', '--share', 'link']);
    expect(wrong.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('update with only a guard and nothing to change is refused', async () => {
    const ran = await drive(['container', 'update', CTR, '--expect-version', '1']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('policy requires --network', async () => {
    const ran = await drive(['container', 'policy', CTR, '--expect-version', '1']);
    expect(ran.code).toBe(EXIT_USAGE);
    expect(ran.stderr).toMatch(/open\|balanced\|locked/);
    expect(seen).toEqual([]);
  });

  it('pool requires --warm and bounds it 0..8', async () => {
    const missing = await drive(['container', 'pool', CTR, '--expect-version', '1']);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);

    const over = await drive(['container', 'pool', CTR, '--expect-version', '1', '--warm', '9']);
    expect(over.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('attention requires a reason from the closed set and bounds --points 1..100', async () => {
    const ran = await drive(['container', 'attention', CTR, '--reason', 'captcha', '--points', '80']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body()).toMatchObject({ reason: 'captcha', points: 80 });

    seen = [];
    const bad = await drive(['container', 'attention', CTR, '--reason', 'bored']);
    expect(bad.code).toBe(EXIT_USAGE);
    expect(seen).toEqual([]);
  });

  it('cp needs exactly one side prefixed ctr:', async () => {
    for (const argv of [
      ['container', 'cp', CTR, './a', './b'],
      ['container', 'cp', CTR, 'ctr:/a', 'ctr:/b'],
    ]) {
      seen = [];
      const ran = await drive(argv);
      expect(ran.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(seen).toEqual([]);
    }
  });

  it('cp validates fully and then REFUSES with exit 8, sending nothing', async () => {
    // Both containers.files.* rows carry a tar octet-stream, which this CLI has
    // no transport for. It refuses with the DEV-13 code rather than putting a
    // JSON body naming a LOCAL path on the wire — the node cannot open a path
    // on the caller's disk, so such a request would be a lie shaped like a
    // success. Asserting `seen` is EMPTY is the half that matters.
    for (const argv of [
      ['container', 'cp', CTR, 'ctr:/etc/hosts', './hosts'],
      ['container', 'cp', CTR, './app.tar', 'ctr:/srv'],
    ]) {
      seen = [];
      const ran = await drive(argv);
      expect(ran.code, argv.join(' ')).toBe(8);
      expect(ran.stderr).toMatch(/tar|not built|no tar transport/i);
      // It names the OPERATION, so the caller knows the row is real.
      expect(ran.stderr).toMatch(/containers\.files\.(put|get)/);
      expect(seen, argv.join(' ')).toEqual([]);
    }
  });

  it('logs passes its window as query, never as a body', async () => {
    const ran = await drive(['container', 'logs', CTR, '--tail', '50', '--follow']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().method).toBe('GET');
    expect(only().query).toContain('tail=50');
    expect(only().query).toContain('follow=true');
    expect(only().body).toBeUndefined();
  });

  it('providers is a GET with no body', async () => {
    const ran = await drive(['container', 'providers']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(only().method).toBe('GET');
    expect(only().pathname).toBe('/v2/containers/providers');
    expect(only().body).toBeUndefined();
  });

  it('fork carries no version guard — it reads the source, it does not change it', async () => {
    const ran = await drive(['container', 'fork', CTR, '--title', 'clone']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(body().expectedVersion).toBeUndefined();
    expect(body().title).toBe('clone');
  });
});

// ── the 501 posture ────────────────────────────────────────────────────────

describe('a P1 verb parses, sends, and reports an honest 501 as exit 8', () => {
  it('container snapshot maps not_implemented to exit 8, not to a crash', async () => {
    reply = {
      status: 501,
      // The canonical envelope: `requestId` and `retryable` live INSIDE the
      // error object. A sibling `requestId` is a DIFFERENT shape and the client
      // reads it as a protocol violation (exit 10), which is how a test can
      // "prove" a 501 maps to the wrong code while the mapping is correct.
      body: {
        error: {
          code: 'not_implemented',
          message: 'no provider on this node satisfies profile+policy',
          requestId: 'req_501',
          retryable: false,
        },
      },
    };
    const ran = await drive(['container', 'snapshot', CTR, '--expect-version', '1']);
    expect(ran.code).toBe(8);
    expect(ran.stderr).toMatch(/not_implemented|not implemented/i);
    // It REACHED the wire: the verb is real, only the runtime is absent.
    expect(seen).toHaveLength(1);
  });
});
