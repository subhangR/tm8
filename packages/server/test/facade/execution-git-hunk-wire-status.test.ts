/**
 * FINDING C AT THE WIRE — what a CLIENT actually receives when a hunk
 * selection is refused.
 *
 * ── WHY THIS FILE EXISTS AND WHY IT IS NOT THE UNIT TEST NEXT DOOR ─────────
 * `packages/execution/test/hunks.test.ts` proves that `selectHunks` now throws
 * a `WorktreeError` carrying `{ code: 'invalid_input', reason:
 * 'hunk_index_out_of_range' }`. That is a claim about a THROWN OBJECT one
 * layer below the one anybody consumes. The claim finding C actually makes is
 * that the CATEGORY REACHES THE CLIENT, and a client sees an HTTP response —
 * a status and a body — not a `WorktreeError`. Asserting the throw and
 * reporting the status is exactly the mistake finding A was: a fact
 * established at one layer, believed at another, with nothing joining them.
 *
 * So this file drives the whole production chain and reads the ANSWER:
 *
 *   INPUT_SCHEMAS['execution.gitStage']   (server.ts:399, by op-name STRING)
 *     -> validate()                       (server.ts:466, safeParse)
 *     -> the REGISTERED execution.gitStage handler, against a REAL git repo
 *     -> liftWorktreeError                (execution-git.ts:242)
 *     -> toWireError                      (errors.ts:78, THE serializer)
 *
 * `toWireError` is the function `sendWireError` (`errors.ts:143`) calls, and
 * `sendWireError` is what `server.ts:430`'s catch calls for every thrown value
 * on this route. Nothing between it and the socket changes `status`.
 *
 * ── A NUMBER THIS FILE CORRECTS ───────────────────────────────────────────
 * The review called the pre-fix behaviour "a 500". It is not. A value that is
 * not a `CollabError` falls to `ERROR_STATUS.upstream_unavailable`, and that
 * is **503** (contract.ts:1560) with `retryable: true` — which is worse than a
 * 500 for this defect, because it tells the client the request is worth
 * retrying when the selection can never succeed. `it('BEFORE-WITNESS ...')`
 * below does not reason about that; it runs the serializer on a plain `Error`
 * and asserts what comes back.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { SessionGitDiff, SessionGitStageResult } from '@tm8/contract';
import { INPUT_SCHEMAS } from '../../src/facade/input-schemas.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionGitHandlers } from '../../src/facade/services/execution-git.js';
import { toWireError } from '../../src/http/errors.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const WORKTREE_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = 'req-wire-c';

interface LaneRow {
  session_id: string;
  workdir_mode: string | null;
  base_ref: string | null;
  worktree_id: string | null;
  path: string | null;
  branch: string | null;
  base_commit_oid: string | null;
  worktree_status: string | null;
}

interface WireBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function ctxFor(query: Record<string, string> = {}, body?: unknown): RequestContext {
  return {
    params: { workSessionId: SESSION_ID },
    query: new URLSearchParams(query),
    body,
    requestId: REQUEST_ID,
  } as unknown as RequestContext;
}

describe('finding C at the wire: a refused hunk selection, end to end', () => {
  let repo: string;
  let baseOid: string;
  let registry: HandlerRegistry;

  const lane = (): LaneRow => ({
    session_id: SESSION_ID,
    workdir_mode: 'worktree',
    base_ref: 'main',
    worktree_id: WORKTREE_ID,
    path: repo,
    branch: 'tm8/lane',
    base_commit_oid: baseOid,
    worktree_status: 'active',
  });

  function handlerFor(name: string): OperationHandler {
    const handler = registry.get(name as never);
    if (!handler) throw new Error(`${name} not registered`);
    return handler;
  }

  /**
   * THE GATE, resolved the way `server.ts:399` resolves it — by OPERATION-NAME
   * STRING out of the table, never by importing the schema binding. Importing
   * the binding would prove the schema and say nothing about whether the table
   * routes this operation to it, and the table is the half that was wrong.
   */
  function gate(opName: string): ZodTypeAny {
    const schema = (INPUT_SCHEMAS as Record<string, ZodTypeAny | undefined>)[opName];
    expect(schema, `${opName} has no INPUT_SCHEMAS binding, so nothing guards its body`)
      .toBeDefined();
    return schema as ZodTypeAny;
  }

  /**
   * The chain, with the two outcomes a client can actually observe kept
   * distinct: a parsed RESULT, or a wire STATUS + BODY. Nothing is inferred —
   * the failure arm returns whatever `toWireError` returns.
   */
  async function throughTheWire(
    body: unknown,
  ): Promise<
    | { kind: 'gate-refused'; status: number; body: WireBody }
    | { kind: 'result'; value: SessionGitStageResult }
    | { kind: 'wire-error'; status: number; body: WireBody }
  > {
    const parsed = gate('execution.gitStage').safeParse(body);
    if (!parsed.success) {
      // server.ts:466 — the gate's own refusal is a CollabError too.
      const { CollabError } = await import('@tm8/contract');
      const wire = toWireError(
        new CollabError('invalid_input', 'request body failed contract validation', {
          details: { issues: parsed.error.issues },
        }),
        REQUEST_ID,
      );
      return { kind: 'gate-refused', status: wire.status, body: wire.body as unknown as WireBody };
    }
    try {
      const value = (await handlerFor('execution.gitStage')(
        ctxFor({}, parsed.data),
      )) as SessionGitStageResult;
      return { kind: 'result', value };
    } catch (error) {
      const wire = toWireError(error, REQUEST_ID);
      return { kind: 'wire-error', status: wire.status, body: wire.body as unknown as WireBody };
    }
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tm8-hunk-wire-'));
    git(repo, 'init', '-b', 'main');
    // Twenty lines so two edits far apart produce two SEPARATE hunks under
    // git's default three lines of context. A single-hunk file would make
    // `count` in the refusal below 1, and a 1 is the value an off-by-one bug
    // in the assertion would also produce.
    await writeFile(repo + '/many.txt', Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    baseOid = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'tm8/lane');
    registry = (() => {
      const db: Db = { query: async () => [lane()] as never } as unknown as Db;
      const config: ServerConfig = {
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 8 * 1024 * 1024,
        databaseUrl: 'unused',
      } as unknown as ServerConfig;
      const r = new HandlerRegistry();
      registerExecutionGitHandlers(r, {
        db,
        config,
        owner: async () => ({ identityId: 'ident', accountId: 'acct', isNodeAdmin: false }) as never,
      });
      return r;
    })();
  });

  beforeEach(async () => {
    // Every case starts from the same TWO-HUNK working tree. Without this the
    // positive control below stages hunk 1 and leaves the next case reading a
    // one-hunk diff, which would change `count` from 2 to 1 and make the
    // out-of-range assertion pass for the wrong reason.
    git(repo, 'reset', '--hard', baseOid);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[1] = 'line 2 EDITED';
    lines[17] = 'line 18 EDITED';
    await writeFile(repo + '/many.txt', lines.join('\n') + '\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /**
   * THE CONTROL THAT MAKES EVERY NUMBER BELOW MEAN SOMETHING: the working tree
   * really does hold exactly two hunks. `count: 2` in the refusal is then a
   * fact about this repository rather than a constant the service happened to
   * emit.
   */
  it('CONTROL: the unstaged diff really does carry exactly two hunks', async () => {
    const result = (await handlerFor('execution.gitDiff')(
      ctxFor({ path: 'many.txt', scope: 'unstaged' }),
    )) as SessionGitDiff;
    expect(result.hunks, 'a scoped single-file diff must offer hunks').not.toBeNull();
    expect(result.hunks?.length).toBe(2);
  });

  /**
   * THE GATE IS NOT THE REFUSER. An out-of-range index is SHAPE-VALID — it is
   * a number — so the schema must let it through. If this ever starts failing,
   * the 400 in the next test is coming from zod and finding C is unproven,
   * because a schema refusal cannot carry `{index, count}`: only the worktree
   * knows how many hunks exist.
   */
  it('CONTROL: the gate ACCEPTS an out-of-range index — shape is all it can judge', () => {
    const parsed = gate('execution.gitStage').safeParse({
      clientMutationId: 'wire-c-gate',
      action: 'stage',
      hunks: { path: 'many.txt', indices: [9] },
    });
    expect(parsed.success, 'an out-of-range index is a NUMBER; the schema has no count to check it against')
      .toBe(true);
  });

  /**
   * THE POSITIVE HALF. Without it, every refusal below is satisfied by a chain
   * that refuses everything — and that chain is exactly what existed before
   * finding A was fixed.
   */
  it('POSITIVE: an IN-RANGE selection succeeds through the same gate and handler', async () => {
    const outcome = await throughTheWire({
      clientMutationId: 'wire-c-ok',
      action: 'stage',
      hunks: { path: 'many.txt', indices: [1] },
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.value.hunkSelection).toMatchObject({ path: 'many.txt', applied: 1, total: 2 });
    expect(outcome.value.paths).toEqual(['many.txt']);
  });

  /**
   * ── THE ASSERTION FINDING C IS ABOUT ──────────────────────────────────────
   * The STATUS a client receives, and the fact that the body names the
   * category and the offending index. Before the fix this same request
   * produced a plain `Error` from `hunks.ts`, which `liftWorktreeError`
   * re-throws unchanged, which `toWireError` cannot recognise — see the
   * BEFORE-WITNESS below for what that actually serialized to.
   */
  it('OUT OF RANGE: the client receives 400 invalid_input naming index and count', async () => {
    const outcome = await throughTheWire({
      clientMutationId: 'wire-c-oor',
      action: 'stage',
      hunks: { path: 'many.txt', indices: [9] },
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('wire-error');
    if (outcome.kind !== 'wire-error') return;

    expect(outcome.status, 'a selection that names a hunk the file does not have is the CALLER\'s error')
      .toBe(400);
    expect(outcome.body.error.code).toBe('invalid_input');
    expect(outcome.body.error.details).toMatchObject({
      reason: 'hunk_index_out_of_range',
      index: 9,
      count: 2,
    });
    // A client that retries this gets the same answer forever. Saying so is
    // half the value of the category reaching the wire at all.
    expect(outcome.body.error.retryable).toBe(false);
    expect(outcome.body.error.requestId).toBe(REQUEST_ID);
  });

  /**
   * THE SAME SHAPE FOR THE OTHER TWO REASONS, so the taxonomy is proven as a
   * taxonomy and not as one lucky value. `no_hunks_selected` is raised by the
   * FACADE (`execution-git.ts:948`) and `not_a_single_file` by the WORKTREE
   * (`hunks.ts:88`) — two different layers, one wire shape.
   */
  it('EMPTY SELECTION: 400 invalid_input / no_hunks_selected', async () => {
    const outcome = await throughTheWire({
      clientMutationId: 'wire-c-empty',
      action: 'stage',
      hunks: { path: 'many.txt', indices: [] },
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('wire-error');
    if (outcome.kind !== 'wire-error') return;
    expect(outcome.status).toBe(400);
    expect(outcome.body.error.code).toBe('invalid_input');
    expect(outcome.body.error.details).toMatchObject({ reason: 'no_hunks_selected' });
  });

  it('A DIRECTORY AS THE HUNK PATH: 400 invalid_input / not_a_single_file', async () => {
    // Give the directory case a second changed file, so the diff it would have
    // to parse genuinely spans more than one — otherwise `.` and `many.txt`
    // are the same diff and the case proves nothing.
    await writeFile(repo + '/second.txt', 'new file\n');
    git(repo, 'add', 'second.txt');
    git(repo, 'commit', '-m', 'second');
    await writeFile(repo + '/second.txt', 'new file EDITED\n');

    const outcome = await throughTheWire({
      clientMutationId: 'wire-c-dir',
      action: 'stage',
      hunks: { path: '.', indices: [1] },
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('wire-error');
    if (outcome.kind !== 'wire-error') return;
    expect(outcome.status).toBe(400);
    expect(outcome.body.error.code).toBe('invalid_input');
    expect(outcome.body.error.details).toMatchObject({ reason: 'not_a_single_file' });

    git(repo, 'reset', '--hard', baseOid);
  });

  /**
   * ── THE BEFORE-WITNESS, RUN RATHER THAN DESCRIBED ─────────────────────────
   * This is what the four `hunks.ts` throws serialized to before this PR
   * converted them: the exact value they threw, handed to the exact serializer
   * the route uses. It is not a reconstruction of the old code path — it is
   * the old code path's PAYLOAD through today's serializer, which is the half
   * that decides the status.
   *
   * Two things a reader should take from the result: the status is **503**,
   * not the 500 the review named; and `retryable` is **true**, so a
   * well-behaved client retries a request that cannot ever succeed. Neither
   * `reason` nor `index` survives — the category does not reach the client at
   * all, which is the whole of finding C.
   */
  it('BEFORE-WITNESS: the plain Error this PR removed serializes to 503, category lost', () => {
    const asItWas = new Error('hunk index 9 is out of range (1..2)');
    const wire = toWireError(asItWas, REQUEST_ID) as { status: number; body: WireBody };

    expect(wire.status, 'a caller error escaping as an unrecognised throw is not a 500 here').toBe(503);
    expect(wire.body.error.code).toBe('upstream_unavailable');
    expect(wire.body.error.retryable, 'and it invites a retry that can never succeed').toBe(true);
    expect(wire.body.error.details, 'nothing of the category survives').toBeUndefined();
    expect(wire.body.error.message, 'not even the message reaches the client')
      .toBe('internal server error');
    expect(JSON.stringify(wire.body)).not.toContain('hunk_index_out_of_range');
  });

  /**
   * FINDING B AT THE WIRE, for the same reason: the review called it a 500 and
   * the claim was never driven. A directory-scoped `gitDiff` must ANSWER, not
   * fail — the hunk half is `null` and the diff itself is still returned.
   *
   * `execution.gitDiff` is a GET and has no `INPUT_SCHEMAS` entry; it reads
   * `ctx.query`, so there is no gate to drive it through and this file does
   * not pretend there is one.
   */
  it('FINDING B: a directory-scoped gitDiff returns a diff with hunks null, not an error', async () => {
    await writeFile(repo + '/other.txt', 'other\n');
    git(repo, 'add', 'other.txt');
    git(repo, 'commit', '-m', 'other');
    await writeFile(repo + '/other.txt', 'other EDITED\n');

    let outcome: { kind: 'ok'; value: SessionGitDiff } | { kind: 'wire'; status: number };
    try {
      outcome = {
        kind: 'ok',
        value: (await handlerFor('execution.gitDiff')(
          ctxFor({ path: '.', scope: 'unstaged' }),
        )) as SessionGitDiff,
      };
    } catch (error) {
      outcome = { kind: 'wire', status: toWireError(error, REQUEST_ID).status };
    }

    expect(outcome.kind, 'before the fix this threw a plain Error and became a 503').toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.hunks, 'a multi-file diff has no per-file hunk indices to offer').toBeNull();
    expect(outcome.value.diff.length, 'and the diff itself is still answered').toBeGreaterThan(0);
    expect(outcome.value.diff).toContain('many.txt');
    expect(outcome.value.diff).toContain('other.txt');

    git(repo, 'reset', '--hard', baseOid);
  });
});
