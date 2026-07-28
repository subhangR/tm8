/**
 * `tm8 undo apply` — token redemption (W4 group 3), and the one command in
 * this slot whose RENDERING is a gate item in its own right.
 *
 * LAW O5, and why it is a correctness rule rather than a wording preference.
 * The undo-token table admits exactly four registered inverses
 * (`edges.delete`, `entities.move`, `entities.restore`, `messages.delete`), and
 * the `messages.delete` one is the inverse of a `placements.apply … embed` —
 * an intent that POSTS a message. Redeeming it therefore calls
 * `w2_tombstone_message`: the body becomes `[redacted]`, mentions and
 * attachments are cleared, `redacted_at` is set, and THE ROW NEVER LEAVES THE
 * THREAD. Thread history survives.
 *
 * Rendering that transition as a "delete", or as an "un-delete", tells an
 * operator that history is gone when it is not — and the natural response to
 * "history is gone" is a destructive recovery against data that was never
 * lost. So the CLI's own words for this transition are REDACTION and nothing
 * else, and the probe that asserts the forbidden vocabulary is absent proves
 * FIRST that it can detect that vocabulary when it is present.
 *
 * NOT UNIVERSAL. An undo token exists only when the mutation that ran issued
 * one. Nothing in this command may read as though every command produces one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { isCommandPath } from '../src/discovery/operations.js';
import { ledger } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function undoCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/undo.js')).UNDO_COMMANDS;
}

interface Seen {
  method: string;
  pathname: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: { patches: [] }, requestId: 'req_t' } };
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
const MSG = '55555555-5555-7555-8555-555555555555';
const ACTOR = '77777777-7777-7777-8777-777777777777';
const TOKEN = 'undo_0192f0aa11224433aabbccddeeff0011';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: { patches: [] }, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g3-undo-'));
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
  const modules = await undoCommands();
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

describe('registration and binding', () => {
  it('registers exactly `undo apply`', async () => {
    const paths = (await undoCommands()).map((m) => m.path.join(' '));
    expect(paths).toEqual(['undo apply']);
  });

  it('the registered path is in the frozen grammar projection', async () => {
    for (const m of await undoCommands()) expect(isCommandPath(m.path)).toBe(true);
  });

  it('binds commands.undo through bindPath and sends the token in the body', async () => {
    const r = await drive(['undo', 'apply', TOKEN]);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(bindPath('commands.undo', {}));
    expect(seen[0]?.body).toMatchObject({ token: TOKEN });
  });

  it('generates a UUIDv7 mutation id and passes a supplied one verbatim', async () => {
    await drive(['undo', 'apply', TOKEN]);
    const generated = (seen[0]?.body as { clientMutationId?: string })?.clientMutationId;
    expect(generated).toMatch(UUID_PATTERN);
    expect(generated?.[14]).toBe('7');
    seen = [];
    await drive(['undo', 'apply', TOKEN, '--mutation-id', 'MINE-verbatim']);
    expect((seen[0]?.body as { clientMutationId?: string })?.clientMutationId).toBe('MINE-verbatim');
  });

  it('carries --as into the body as actorId', async () => {
    await drive(['undo', 'apply', TOKEN, '--as', ACTOR]);
    expect((seen[0]?.body as { actorId?: string })?.actorId).toBe(ACTOR);
  });

  it('an option outside the frozen syntax is a usage error', async () => {
    const r = await drive(['undo', 'apply', TOKEN, '--yes']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

// ── not universally applicable ──────────────────────────────────────────────

describe('an undo token is not universal', () => {
  it('the missing-token usage error says a token exists only when one was issued', async () => {
    const r = await drive(['undo', 'apply']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/not every mutation|only when|issued one/i);
  });

  it('never claims that every command produces an undo token', async () => {
    const r = await drive(['undo', 'apply']);
    expect(r.stderr).not.toMatch(/every command|any command|all commands/i);
  });
});

// ── LAW O5: the redaction vocabulary ────────────────────────────────────────

/**
 * The forbidden vocabulary for a REDACTION transition. Deliberately broad: the
 * failure mode is an operator concluding that a row is gone, and every one of
 * these words carries that implication.
 */
const DESTRUCTIVE_VOCABULARY = /\b(un-?delete[ds]?|delete[ds]?|deletion|removed|erased|resurrect\w*)\b/i;

/** A message CommandResult exactly as the redemption returns one. */
const REDACTED_MESSAGE = {
  entity: {
    id: MSG,
    kind: 'message',
    title: '[redacted]',
    version: 2,
    content: { kind: 'message', body: '[redacted]', mentions: [], attachments: [] },
  },
  patches: [{ id: MSG, kind: 'message', title: '[redacted]' }],
};

describe('LAW O5 — redeeming a messages.delete token is a REDACTION', () => {
  /**
   * THE POSITIVE CONTROL, and it runs FIRST. A probe that reports "the
   * forbidden vocabulary is absent" is worthless until it has demonstrated it
   * can detect that vocabulary when present — the classic vacuous pass.
   */
  it('the probe can detect the vocabulary it forbids', () => {
    expect(DESTRUCTIVE_VOCABULARY.test('the message was un-deleted')).toBe(true);
    expect(DESTRUCTIVE_VOCABULARY.test('undeleted 1 message')).toBe(true);
    expect(DESTRUCTIVE_VOCABULARY.test('deleted the message')).toBe(true);
    expect(DESTRUCTIVE_VOCABULARY.test('the row was removed from the thread')).toBe(true);
    expect(DESTRUCTIVE_VOCABULARY.test('redacted; thread history survives')).toBe(false);
  });

  it('says REDACTED, in the CLI\'s own words', async () => {
    reply = { status: 200, body: { data: REDACTED_MESSAGE, requestId: 'req_t' } };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('redact');
  });

  /**
   * The same claim, with the word removed from the DTO. A mutation test showed
   * the assertion above can be satisfied by the SERVER's own `[redacted]`
   * title rather than by anything this CLI says — so this variant hands the
   * renderer a message whose title contains no such word. Now only the CLI's
   * own sentence can satisfy it.
   */
  it('says REDACTED even when the DTO itself never uses the word', async () => {
    reply = {
      status: 200,
      body: {
        data: { entity: { id: MSG, kind: 'message', title: 'standup notes', version: 2 }, patches: [] },
        requestId: 'req_t',
      },
    };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('redact');
    expect(r.stdout).not.toMatch(DESTRUCTIVE_VOCABULARY);
  });

  it('states that thread history SURVIVES', async () => {
    reply = { status: 200, body: { data: REDACTED_MESSAGE, requestId: 'req_t' } };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain('thread history');
  });

  it('never uses delete / un-delete vocabulary on EITHER stream', async () => {
    reply = { status: 200, body: { data: REDACTED_MESSAGE, requestId: 'req_t' } };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.stdout).not.toMatch(DESTRUCTIVE_VOCABULARY);
    expect(r.stderr).not.toMatch(DESTRUCTIVE_VOCABULARY);
  });

  it('keeps the message id, so the redaction can be read back', async () => {
    reply = { status: 200, body: { data: REDACTED_MESSAGE, requestId: 'req_t' } };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.stdout).toContain(MSG);
  });

  it('--format json is the contract DTO, unannotated', async () => {
    reply = { status: 200, body: { data: REDACTED_MESSAGE, requestId: 'req_t' } };
    const r = await drive(['undo', 'apply', TOKEN, '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual(REDACTED_MESSAGE);
  });

  /**
   * The three non-message inverses must NOT be annotated as redactions: a
   * moved entity has not been redacted, and saying so would be as wrong in the
   * other direction.
   */
  it('does not call a non-message inverse a redaction', async () => {
    reply = {
      status: 200,
      body: {
        data: { entity: { id: MSG, kind: 'task', title: 'Ship', version: 3 }, patches: [] },
        requestId: 'req_t',
      },
    };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.stdout.toLowerCase()).not.toContain('redact');
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

describe('refusals are rendered, not softened', () => {
  const CASES: ReadonlyArray<{ status: number; code: string; exit: number; message: string }> = [
    { status: 404, code: 'not_found', exit: 5, message: 'undo token not found' },
    { status: 409, code: 'invariant_violation', exit: 6, message: 'undo token already redeemed' },
    { status: 409, code: 'invariant_violation', exit: 6, message: 'undo token expired' },
    { status: 403, code: 'forbidden', exit: 4, message: 'only the original actor may undo this' },
  ];
  for (const c of CASES) {
    it(`${c.message} → exit ${c.exit}, verbatim on stderr`, async () => {
      reply = {
        status: c.status,
        body: { error: { code: c.code, message: c.message, requestId: 'req_t', retryable: false } },
      };
      const r = await drive(['undo', 'apply', TOKEN]);
      expect(r.code).toBe(c.exit);
      expect(r.stderr).toContain(c.message);
      expect(r.stdout).toBe('');
      expect(seen).toHaveLength(1);
    });
  }

  it('an honest 501 exits 8 and says so', async () => {
    reply = {
      status: 501,
      body: { error: { code: 'not_implemented', message: 'nope', requestId: 'req_t', retryable: false } },
    };
    const r = await drive(['undo', 'apply', TOKEN]);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('not implemented on this node');
  });
});
