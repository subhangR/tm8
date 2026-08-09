/**
 * G06 against a REAL Server — `project …` and `file …`, end to end.
 *
 * ONE integration file for this slot's two nouns, because the slot owns one
 * integration path and because each `startRealServer` costs a scratch database:
 * two files would mean two databases proving the same thing about one node.
 *
 * WHAT IS AND IS NOT PROVEN HERE, stated before the first assertion:
 *
 *  - The Server is REAL: the built `packages/server/dist/index.js` as a child
 *    process, on a freshly migrated scratch database, spoken to over HTTP.
 *  - The CLI is the REAL SHIPPED BINARY: `packages/cli/dist/index.js`, spawned
 *    as its own process and driven through ordinary `tm8 <noun> <verb>` argv —
 *    the way an agent invokes it, through the router, the registry, and the exit
 *    funnel. Not the TypeScript sources, not an in-process import, and not a
 *    hand-built CommandContext.
 *
 * This file originally asserted the opposite: that these paths answered an
 * honest exit 8 because `src/commands/registry.ts` is coordinator-owned and had
 * not yet wired this slot's modules. The coordinator wired them mid-run, so that
 * assertion went red and was REPLACED by what the binary now actually does —
 * measured, not predicted, in both directions.
 *
 * Availability is DERIVED HERE, never copied from a report: `/health` is read
 * from this Server, and every row is probed with `server.observe`, whose
 * `unknown` means "registered, but the handler never ran" and is never upgraded.
 * Where a row's handler is made to run with a SCHEMA-VALID body, that is said
 * explicitly and separately from the probe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath, type OperationName } from '@tm8/contract';
import { assertBuilt, cli, REPO_ROOT, startRealServer, type ObservedAvailability, type RealServer } from './harness.js';

const DIST = join(REPO_ROOT, 'packages/cli/dist');

/**
 * Every test here spawns the CLI as a CHILD PROCESS, often several times, while
 * eight sibling sessions build and test in the same tree. Node startup under
 * that load is seconds, not milliseconds, so vitest's 5 s default turns a
 * PASSING assertion into a timeout that reads exactly like a defect. The bound
 * is deliberately generous: it exists to keep a loaded host from counterfeiting
 * a red, not to hide a hang — a real hang still fails, two minutes later.
 */
const SLOW = 120_000;

/** Every row this slot owns, in catalog order. `bridge.fetchBlob` included. */
const ROWS: OperationName[] = [
  'projects.list',
  'projects.create',
  'projects.get',
  'projects.update',
  'projects.link',
  'projects.unlink',
  'projects.associations.correct',
  'files.uploadInit',
  'files.uploadComplete',
  'files.uploadAbort',
  'files.download',
  'bridge.fetchBlob',
];

let server: RealServer;
let scratch: string;
let spaceId: string;
let defaultChannelId: string;

/** The shipped entry point — the exact file `bin.tm8` points at. */
const BINARY = join(DIST, 'index.js');

interface Run {
  code: number;
  stdout: string;
  bytes: Buffer;
  stderr: string;
}

/**
 * Invoke the shipped binary. Its own process, its own argv, real stdout bytes —
 * `harness.cli()` does the same but decodes stdout as a string, and a blob must
 * never be utf8-decoded on its way to an assertion.
 */
async function tm8(argv: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  return await new Promise((resolve) => {
    const child = spawn('node', [BINARY, ...argv], {
      env: { ...process.env, ...server.env, TM8_SPACE_ID: spaceId, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => void stdout.push(c));
    child.stderr.on('data', (c: Buffer) => void (stderr += c.toString()));
    child.once('close', (code) => {
      const bytes = Buffer.concat(stdout);
      resolve({ code: code ?? -1, stdout: bytes.toString('utf8'), bytes, stderr });
    });
  });
}

/** Test-side setup only: a Space this slot's rows can act in. Never a CLI path. */
async function raw<T>(
  operation: OperationName,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(new URL(bindPath(operation, params), server.baseUrl), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await res.json()) as { data?: T; error?: unknown };
  if (res.status >= 400) throw new Error(`${operation} setup failed: ${JSON.stringify(body)}`);
  return body.data as T;
}

function jsonOf(run: Run): Record<string, unknown> {
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  await assertBuilt();
  for (const mod of ['commands/project.js', 'commands/file.js']) {
    if (!existsSync(join(DIST, mod))) {
      throw new Error(`missing ${join(DIST, mod)} — run \`bun run build:cli\` first`);
    }
  }
  server = await startRealServer('g06-project-file');
  scratch = mkdtempSync(join(tmpdir(), 'tm8-g06-'));

  const created = await raw<{ space: { id: string }; defaultChannelId: string }>(
    'spaces.create',
    {},
    {
      method: 'POST',
      body: JSON.stringify({ name: 'g06 scratch', clientMutationId: randomUUID() }),
    },
  );
  spaceId = created.space.id;
  defaultChannelId = created.defaultChannelId;
}, 180_000);

afterAll(async () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  await server?.stop();
});

describe('what this node is, measured rather than assumed', () => {
  it('reports its own mounted/registered surface and its chain bind', async () => {
    const h = await server.health();
    console.log(
      `[g06] ${server.baseUrl} operations=${h.operations} registered=${h.implemented} ` +
        `bind-start ${server.bindStart.files}/${server.bindStart.digest}`,
    );
    expect(h.operations).toBe(128); // 126 -> 128 (2026-08-09): projects.contention + entities.commands.gate (Tier 4 git x graph).
    // `implemented` is registry.size — MOUNTED handlers, not behaviourally
    // implemented. Asserted as a floor only, never quoted as an implemented count.
    expect(h.implemented).toBeGreaterThan(0);
  }, SLOW);

  it('observes all twelve rows THREE-STATE, and never upgrades `unknown`', async () => {
    const observed: Record<string, ObservedAvailability> = {};
    for (const row of ROWS) observed[row] = await server.observe(row);
    console.log(`[g06] observed availability ${JSON.stringify(observed)}`);
    expect(Object.keys(observed)).toHaveLength(ROWS.length);

    // CONTRACT beats observation: bridge.fetchBlob is permanently reserved and
    // answers an honest 501 on every node.
    expect(observed['bridge.fetchBlob']).toBe('unavailable');
    // The rest are registered here, so an invalid probe body can only reach
    // validation. `unknown` is the honest answer; the tests below are what make
    // their handlers actually run.
    for (const row of ROWS.filter((r) => r !== 'bridge.fetchBlob')) {
      expect(observed[row], row).not.toBe('unavailable');
    }
  }, SLOW);

  it('the SHIPPED binary resolves every one of this slot command paths', async () => {
    // `--help` is answered from the projection for any documented path, so this
    // separates "the router found it" from "the handler worked" — and it must
    // never be exit 2 (unknown command) or exit 8 (documented, not built here).
    const paths = [
      ['project', 'list'], ['project', 'create'], ['project', 'get'], ['project', 'update'],
      ['project', 'link'], ['project', 'unlink'], ['project', 'association', 'correct'],
      ['file', 'upload'], ['file', 'upload', 'abort'], ['file', 'download'],
    ];
    for (const path of paths) {
      const r = await cli([...path, '--help'], server);
      expect(r.code, `${path.join(' ')}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`tm8 ${path[0]}`);
    }
  }, SLOW);

  it('`tm8 project list` runs end to end through the real router and exit funnel', async () => {
    const r = await tm8(['project', 'list', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
  }, SLOW);
});

describe('projects — the ProjectResource lifecycle, really executed', () => {
  let projectId: string;

  it('creates a ProjectResource (201) and reads it back', async () => {
    const workingDir = join(scratch, 'workspace');
    const created = jsonOf(
      await tm8(['project', 'create', 'g06 project', '--working-dir', workingDir, '--format', 'json']),
    );
    expect(typeof created.id).toBe('string');
    expect(created.workingDir).toBe(workingDir);
    // Trust is an explicit grant: an unspecified project is untrusted.
    expect(created.trust).toBe('untrusted');
    projectId = created.id as string;

    const read = jsonOf(await tm8(['project', 'get', projectId, '--format', 'json']));
    expect(read.id).toBe(projectId);
  }, SLOW);

  it('lists it, and human output keeps the id a follow-up command needs', async () => {
    const listed = await tm8(['project', 'list']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(projectId);
  }, SLOW);

  it('updates configuration, and §7.5 gates the working-directory relocation', async () => {
    const renamed = jsonOf(
      await tm8(['project', 'update', projectId, '--name', 'g06 renamed', '--format', 'json']),
    );
    expect(renamed.name).toBe('g06 renamed');

    const moved = join(scratch, 'relocated');
    const blocked = await tm8(['project', 'update', projectId, '--working-dir', moved]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('--yes');

    const allowed = jsonOf(
      await tm8(['project', 'update', projectId, '--working-dir', moved, '--yes', '--format', 'json']),
    );
    expect(allowed.workingDir).toBe(moved);
  }, SLOW);

  it('links into a Space, and reports the two identifier domains without conflating them', async () => {
    const linked = await tm8(['project', 'link', projectId, '--format', 'json']);
    expect(linked.code, linked.stderr).toBe(0);
    const dto = JSON.parse(linked.stdout) as Record<string, unknown>;
    expect(dto.projectId).toBe(projectId);
    expect(dto.spaceId).toBe(spaceId);

    // MEASURED, not assumed, and adjudicated against the CONTRACT rather than
    // the design doc: `projectEntityId` appears in grammar §4.9 and in ZERO
    // places under packages/contract/src, so a result without it is complete as
    // SPECIFIED — not a server defect. What the CLI must never do, either way,
    // is collapse the two identifier domains into one value.
    console.log(
      `[g06] projects.link result keys: ${JSON.stringify(Object.keys(dto))} ` +
        `projectEntityId=${String(dto.projectEntityId ?? '<absent>')}`,
    );
    if (dto.projectEntityId === undefined) {
      expect(linked.stderr).toMatch(/projection entity/i);
      expect(linked.stderr).not.toContain(projectId);
      const human = await tm8(['project', 'link', projectId]);
      const projectionLine = human.stdout.split('\n').find((l) => l.includes('projectEntityId')) ?? '';
      expect(projectionLine).not.toContain(projectId);
    } else {
      expect(dto.projectEntityId).not.toBe(projectId);
    }
  }, SLOW);

  it('unlinks under --yes, and refuses without it', async () => {
    const blocked = await tm8(['project', 'unlink', projectId]);
    expect(blocked.code).toBe(2);
    const unlinked = await tm8(['project', 'unlink', projectId, '--yes', '--format', 'json']);
    expect(unlinked.code, unlinked.stderr).toBe(0);
    expect((JSON.parse(unlinked.stdout) as Record<string, unknown>).projectId).toBe(projectId);
    // Re-link so the file tests below have a linked Project available.
    expect((await tm8(['project', 'link', projectId])).code).toBe(0);
  }, SLOW);

  it('project association correct: the handler RUNS against a schema-valid body', async () => {
    // A fabricated artifact id is a real request the Server fully evaluates:
    // it answers not_found (exit 5) from inside the handler. That resolves this
    // row from `unknown` to "the handler ran"; it does NOT exercise the success
    // path, and this test does not claim it does.
    const r = await tm8([
      'project', 'association', 'correct', randomUUID(),
      '--project', projectId, '--expect-version', '1',
    ]);
    expect([5, 4], `code ${r.code}: ${r.stderr}`).toContain(r.code);
    expect(r.stderr).not.toContain('invalid_input');
  }, SLOW);

  it('a nonexistent ProjectResource is an honest not-found, not a CLI invention', async () => {
    const r = await tm8(['project', 'get', randomUUID()]);
    expect(r.code, r.stderr).toBe(5);
    expect(r.stdout).toBe('');
  }, SLOW);
});

describe('files — the composed upload and the raw-bytes download', () => {
  const payload = Buffer.from('g06 blob payload — real bytes over real HTTP\n');
  const sha = createHash('sha256').update(payload).digest('hex');
  let fileEntityId: string;

  it('uploads through init → grant PUT → complete, in ONE command', async () => {
    const source = join(scratch, 'payload.bin');
    writeFileSync(source, payload);
    const r = await tm8(['file', 'upload', source, '--mime', 'text/plain', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const dto = JSON.parse(r.stdout) as { entity?: { id?: string; kind?: string } };
    expect(dto.entity?.kind).toBe('file');
    expect(typeof dto.entity?.id).toBe('string');
    fileEntityId = dto.entity?.id as string;
  }, SLOW);

  it('downloads the SAME bytes back, outside the JSON envelope', async () => {
    const target = join(scratch, 'roundtrip.bin');
    const r = await tm8(['file', 'download', fileEntityId, '--output', target]);
    expect(r.code, r.stderr).toBe(0);
    expect(Buffer.compare(readFileSync(target), payload)).toBe(0);
    expect(createHash('sha256').update(readFileSync(target)).digest('hex')).toBe(sha);
    // stdout carried the DATA to the file, so nothing structured joined it.
    expect(r.bytes).toHaveLength(0);
  }, SLOW);

  it('streams the same bytes to stdout for `--output -`', async () => {
    const r = await tm8(['file', 'download', fileEntityId, '--output', '-']);
    expect(r.code, r.stderr).toBe(0);
    expect(Buffer.compare(r.bytes, payload)).toBe(0);
  }, SLOW);

  it('refuses to clobber an existing file without --overwrite', async () => {
    const target = join(scratch, 'roundtrip.bin');
    const blocked = await tm8(['file', 'download', fileEntityId, '--output', target]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('--overwrite');
    const forced = await tm8(['file', 'download', fileEntityId, '--output', target, '--overwrite']);
    expect(forced.code, forced.stderr).toBe(0);
  }, SLOW);

  it('attaches on completion when --attach-to names a live entity in the Space', async () => {
    const source = join(scratch, 'attached.bin');
    writeFileSync(source, Buffer.from('attached blob'));
    const r = await tm8([
      'file', 'upload', source, '--attach-to', defaultChannelId, '--format', 'json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const dto = JSON.parse(r.stdout) as { patches?: { id: string }[] };
    // The completion result patches carry the file and every attachment target.
    expect(dto.patches?.some((p) => p.id === defaultChannelId), JSON.stringify(dto.patches)).toBe(true);
  }, SLOW);

  it('two stages, two ledger rows: one root id drives BOTH catalog mutations', async () => {
    // If both stages had shared one id, the Server's ledger would answer the
    // second with the first's stored result and completion would fail. It
    // succeeding under an explicit root is the real-Server evidence that the
    // derived ids are distinct and each replayed against its own operation.
    const source = join(scratch, 'derived.bin');
    writeFileSync(source, Buffer.from('derived-id evidence'));
    const root = randomUUID();
    const r = await tm8(['file', 'upload', source, '--mutation-id', root, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { entity?: { kind?: string } }).entity?.kind).toBe('file');
  }, SLOW);

  it('aborts a reserved slot, and refuses to without --yes', async () => {
    const grant = await raw<{ uploadId: string }>(
      'files.uploadInit',
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          spaceId,
          name: 'abandoned.bin',
          mime: 'application/octet-stream',
          sizeBytes: 11,
          checksumSha256: createHash('sha256').update(Buffer.from('abandoned!!')).digest('hex'),
          clientMutationId: randomUUID(),
        }),
      },
    );
    const blocked = await tm8(['file', 'upload', 'abort', grant.uploadId]);
    expect(blocked.code).toBe(2);
    const aborted = await tm8(['file', 'upload', 'abort', grant.uploadId, '--yes']);
    expect(aborted.code, aborted.stderr).toBe(0);
    expect(aborted.stdout).toContain(grant.uploadId);
  }, SLOW);

  it('a size the node will not accept is refused, and the CLI does not pretend otherwise', async () => {
    // The declaration is computed from the bytes, so this exercises the Server's
    // own ceiling rather than a client-side guess: a 1-byte file is fine, and a
    // fabricated --size that disagrees is refused locally at exit 2.
    const source = join(scratch, 'one.bin');
    writeFileSync(source, Buffer.from('1'));
    const lying = await tm8(['file', 'upload', source, '--size', '999999']);
    expect(lying.code).toBe(2);
    expect(lying.stderr).toContain('disagrees');
  }, SLOW);
});

/**
 * THE GUARD PROOF — is `--expect-version` ENFORCED, or merely TOLERATED?
 *
 * A `.strict()` schema accepting `expectedArtifactVersion` proves only that the
 * field is ACCEPTED. A handler could parse it and never compare it, and a guard
 * that is parsed-and-ignored looks IDENTICAL to a working guard on every
 * happy-path test. The only call that can tell them apart is one that SHOULD be
 * refused.
 *
 * The fixture must also avoid the no-op trap: if the mutation between the two
 * calls does not actually move the artifact's version, the "stale" replay is not
 * stale and passes for the wrong reason. So the version is re-read and asserted
 * to have MOVED before the stale value is replayed.
 */
describe('projects.associations.correct — the --expect-version guard, proved on the wire', () => {
  let artifactId: string;
  let projectId: string;
  let versionBefore: number;

  it('mints a real pull_request artifact attributed to a linked ProjectResource', async () => {
    const created = jsonOf(
      await tm8(['project', 'create', 'guard proof', '--working-dir', join(scratch, 'guard'), '--format', 'json']),
    );
    projectId = created.id as string;
    expect((await tm8(['project', 'link', projectId])).code).toBe(0);

    const task = await raw<{ entity?: { id: string } }>('entities.create', {}, {
      method: 'POST',
      body: JSON.stringify({
        clientMutationId: randomUUID(), spaceId, kind: 'task', title: 'g06 guard fixture',
      }),
    });
    const taskId = task.entity?.id as string;
    expect(typeof taskId).toBe('string');

    // `link_pull_request` answers a CommandResult whose PRIMARY entity is the
    // TASK and whose `tracks` edge TARGETS the new pull_request. Read the
    // artifact off the edge rather than assuming the primary entity is it —
    // measured from the response, not predicted.
    const linked = await raw<{
      entity?: { id: string; kind: string };
      edge?: { target?: { id: string; kind: string } };
      patches?: { id: string; kind: string }[];
    }>('entities.commands.linkPr', { id: taskId }, {
      method: 'POST',
      body: JSON.stringify({
        clientMutationId: randomUUID(),
        url: 'https://github.com/tm8-fixture/repo/pull/7',
        projectId,
      }),
    });
    artifactId =
      (linked.edge?.target?.kind === 'pull_request' ? linked.edge.target.id : undefined) ??
      (linked.patches ?? []).find((p) => p.kind === 'pull_request')?.id ??
      '';
    expect(artifactId, `no pull_request in ${JSON.stringify(linked).slice(0, 400)}`).not.toBe('');
    const read = await raw<{ version: number; kind: string }>('entities.get', { id: artifactId });
    expect(read.kind).toBe('pull_request');
    versionBefore = read.version;
    console.log(`[g06] guard fixture: pull_request ${artifactId} at version ${versionBefore}`);
  }, SLOW);

  it('ACCEPTANCE — the CURRENT version is accepted: exit 0', async () => {
    const r = await tm8([
      'project', 'association', 'correct', artifactId,
      '--project', projectId, '--expect-version', String(versionBefore),
    ]);
    console.log(`[g06] guard ACCEPTANCE exit ${r.code} · ${r.stdout.trim().split('\n')[0]}`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('outcome');
  }, SLOW);

  it('POSITIVE CONTROL — the artifact version actually MOVED, so the replay below is genuinely stale', async () => {
    // Without this, a no-op mutation would leave the "stale" value current and
    // the refusal test would pass for entirely the wrong reason.
    await raw('entities.patch', { id: artifactId }, {
      method: 'PATCH',
      body: JSON.stringify({
        clientMutationId: randomUUID(),
        expectedVersion: versionBefore,
        title: 'g06 guard fixture — moved',
      }),
    });
    const after = await raw<{ version: number }>('entities.get', { id: artifactId });
    console.log(`[g06] artifact version ${versionBefore} -> ${after.version}`);
    expect(after.version).toBeGreaterThan(versionBefore);
  }, SLOW);

  it('REFUSAL — the STALE version is refused: exit 6 version_conflict', async () => {
    const r = await tm8([
      'project', 'association', 'correct', artifactId,
      '--project', projectId, '--expect-version', String(versionBefore),
    ]);
    console.log(`[g06] guard REFUSAL exit ${r.code} · ${r.stderr.trim().split('\n')[0]}`);
    expect(r.code, r.stderr).toBe(6);
    expect(r.stderr).toMatch(/version_conflict|invariant_violation/);
    // The guard is REAL, not decoration: the Server COMPARED the value.
    expect(r.stdout).toBe('');
  }, SLOW);

  it('OMISSION — the required flag is required, and never reaches the wire without it', async () => {
    const r = await tm8(['project', 'association', 'correct', artifactId, '--project', projectId]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
  }, SLOW);
});

describe('bridge.fetchBlob — reserved on this node, and reserved everywhere', () => {
  it('answers an honest 501 over the wire, with no CLI command to reach it', async () => {
    const res = await fetch(
      new URL(bindPath('bridge.fetchBlob', { fileEntityId: randomUUID() }), server.baseUrl),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_implemented');
    // And no grammar reaches it: the shipped binary answers "unknown command"
    // (exit 2), NOT exit 8 — there is nothing documented here to build.
    const r = await tm8(['bridge', 'fetch-blob', randomUUID()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command');
  }, SLOW);

  it('stays discoverable by exact lookup while rendering NO invocation syntax', async () => {
    const r = await tm8(['help', '--operation', 'bridge.fetchBlob']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('bridge.fetchBlob');
    // A reserved row that printed a command line would be a promise the system
    // cannot keep. POSITIVE CONTROL below proves this probe can see syntax.
    expect(r.stdout).not.toMatch(/tm8 bridge/);

    const control = await tm8(['help', '--operation', 'files.download']);
    expect(control.code, control.stderr).toBe(0);
    expect(control.stdout).toContain('tm8 file download');
  }, SLOW);
});

describe('bind coherence — asserted LAST, before any number leaves this file', () => {
  it('the migration chain did not move under this suite', async () => {
    await server.assertBindCoherent();
    console.log(`[g06] bind coherent at ${server.bindStart.files}/${server.bindStart.digest}`);
  }, SLOW);
});
