/**
 * `tm8 project …` — the seven ProjectResource rows (§4.9 + A04).
 *
 * These drive the CommandModules DIRECTLY rather than through `run()`, because
 * `src/commands/registry.ts` is coordinator-owned: this slot exports a
 * `CommandModule[]` and the coordinator wires it. Driving the modules through
 * the REAL parser and the REAL context resolver keeps everything except that
 * one wiring line under test.
 *
 * The laws these assert, each of which has a named source:
 *
 *  - every path is bound with `bindPath(<operation>, params)`; not one URL
 *    literal exists in the production module, and the assertions compare the
 *    observed request path against `bindPath` rather than a hand-typed string,
 *    so a literal that happened to be correct today would still be caught the
 *    moment the catalog moved.
 *  - A ProjectResource id and a per-Space project PROJECTION entity id are two
 *    different identifier domains. `project link` renders both, names both, and
 *    NEVER substitutes one for the other — including when the node answers
 *    without the projection id at all.
 *  - §7.5: `project unlink` requires `--yes`; `project update` requires it
 *    exactly when `--working-dir` is supplied, and never otherwise.
 *  - reads refuse `--mutation-id`; mutations pass a supplied one verbatim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  bindPath,
  CorrectProjectAssociationInputSchema,
  FileUploadCompleteInputSchema,
  FileUploadInitInputSchema,
  MessageDeliveryQuerySchema,
  ProjectCreateInputSchema,
  ProjectLinkInputSchema,
  ProjectUpdateInputSchema,
} from '@tm8/contract';
import { parseInvocation } from '../src/args.js';
import { resolveContext } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { createOutput } from '../src/output.js';
import { PROJECT_COMMANDS } from '../src/commands/project.js';
import { commandDiscovery, isCommandPath } from '../src/discovery/operations.js';

const SPACE = '00000000-0000-7000-8000-0000000000aa';
const PROJECT = '00000000-0000-7000-8000-0000000000bb';
const ARTIFACT = '00000000-0000-7000-8000-0000000000cc';
const PROJECTION = '00000000-0000-7000-8000-0000000000dd';

interface Captured {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let requests: Captured[] = [];
let respond: (req: Captured) => { status?: number; body?: unknown } = () => ({ body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const captured: Captured = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.search,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      };
      requests.push(captured);
      const answer = respond(captured);
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-tm8-request-id', 'req_test');
      res.statusCode = answer.status ?? 200;
      res.end(
        res.statusCode >= 400
          ? JSON.stringify(answer.body)
          : JSON.stringify({ data: answer.body ?? {}, requestId: 'req_test' }),
      );
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
  respond = () => ({ body: {} });
});

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
}

/** Longest-match against this module's own paths — the router's discipline. */
function moduleFor(positionals: readonly string[]) {
  return [...PROJECT_COMMANDS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((m) => m.path.every((seg, i) => positionals[i] === seg));
}

async function invoke(argv: readonly string[], session: Record<string, string> = {}): Promise<Invocation> {
  const parsed = parseInvocation(argv);
  const mod = moduleFor(parsed.positionals);
  if (!mod) throw new Error(`no project module for ${parsed.positionals.join(' ')}`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    format: parsed.globals.format,
    quiet: parsed.globals.quiet,
    streams: {
      stdout: (c) => void stdout.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8')),
      stderr: (c) => void stderr.push(c),
    },
  });
  const ctx = resolveContext({ globals: parsed.globals, session: { baseUrl, ...session }, config: {} });
  let code: number;
  try {
    code = await mod.run({
      path: mod.path,
      args: parsed.positionals.slice(mod.path.length),
      options: parsed.options,
      passthrough: parsed.passthrough,
      ctx,
      out,
    });
  } catch (err) {
    out.error(errorLines(err));
    code = exitCodeFor(err);
  }
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const RESOURCE = {
  id: PROJECT,
  name: 'tm8',
  repoUrl: null,
  workingDir: '/Users/agent/tm8',
  trust: 'untrusted',
  defaults: {},
  linkFrozen: false,
  activeLinkCount: 0,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
};

describe('the project module registers exactly its projected paths', () => {
  it('claims the eight project rows and nothing else', () => {
    expect(PROJECT_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'project association correct',
      'project contention',
      'project create',
      'project get',
      'project link',
      'project list',
      'project unlink',
      'project update',
    ]);
  });

  it('every claimed path is in the frozen discovery projection', () => {
    for (const c of PROJECT_COMMANDS) {
      expect(isCommandPath(c.path), c.path.join(' ')).toBe(true);
      expect(commandDiscovery(c.path)?.syntax, c.path.join(' ')).toContain('tm8 project');
    }
  });

  it('registers each path exactly once — a duplicate would throw at registry import', () => {
    const keys = PROJECT_COMMANDS.map((c) => c.path.join(' '));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('G06 owns no paging surface — asserted at the SCHEMA, not by grepping names', () => {
  /**
   * The cursor-truncation class (a `timestamptz` round-tripped through a JS
   * `Date`, losing microseconds) can only touch a row that HAS a cursor. Rather
   * than assert "we looked and found none", this introspects the frozen zod
   * shapes for every G06 row that carries a request body and requires the
   * absence of any paging member.
   *
   * WHAT THIS MECHANISM DOES NOT EXPLAIN, stated rather than left over: a query
   * parameter needs no body schema, so schema absence alone cannot prove the
   * Server has no cursor — `projects.list` does accept an unadvertised
   * `?spaceId=` filter, which proves query params exist outside these shapes.
   * That gap is closed at the source instead: the `projects.list` service issues
   * `order by name asc, id asc` with no limit, offset or keyset predicate, so
   * there is no boundary value to truncate anywhere in this group.
   */
  const PAGING = /cursor|limit|after|before|seq|page|offset/i;

  const membersOf = (schema: unknown): string[] =>
    Object.keys((schema as { _def: { shape: () => Record<string, unknown> } })._def.shape());

  it('no G06 input schema carries a cursor, limit, or any other paging member', () => {
    const rows: [string, unknown][] = [
      ['projects.create', ProjectCreateInputSchema],
      ['projects.update', ProjectUpdateInputSchema],
      ['projects.link', ProjectLinkInputSchema],
      ['projects.associations.correct', CorrectProjectAssociationInputSchema],
      ['files.uploadInit', FileUploadInitInputSchema],
      ['files.uploadComplete', FileUploadCompleteInputSchema],
    ];
    // A loop that silently iterates zero rows is the classic vacuous pass.
    expect(rows).toHaveLength(6);
    for (const [name, schema] of rows) {
      const members = membersOf(schema);
      expect(members.length, `${name} introspected to an EMPTY shape`).toBeGreaterThan(0);
      expect(members.filter((m) => PAGING.test(m)), name).toEqual([]);
    }
  });

  it('POSITIVE CONTROL: the same introspection FINDS paging where the contract defines it', () => {
    // If this matcher could not see a cursor, the negative above would be worth
    // nothing. `MessageDeliveryQuery` is a contract row that genuinely pages.
    const members = membersOf(MessageDeliveryQuerySchema);
    expect(members.filter((m) => PAGING.test(m)).sort()).toEqual(['cursor', 'limit']);
  });
});

describe('tm8 project list', () => {
  it('binds the catalog path and renders ids a follow-up command needs', async () => {
    respond = () => ({ body: [RESOURCE] });
    const r = await invoke(['project', 'list']);
    expect(r.code).toBe(0);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe(bindPath('projects.list'));
    expect(r.stdout).toContain(PROJECT);
    expect(r.stdout).toContain('tm8');
  });

  it('refuses --mutation-id: a read is not a mutation', async () => {
    const r = await invoke(['project', 'list', '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
    expect(r.stderr).toContain('--mutation-id');
  });

  it('REFUSES --limit/--cursor: the frozen contract gives projects.list no paging', async () => {
    // `--limit`/`--cursor` appear in the CLI projection's syntax string for this
    // row, but NOTHING in packages/contract/src defines a limit, a cursor, or a
    // page for `projects.list` — it returns a bare `ProjectResource[]`. A flag
    // with no wire destination is a promise the CLI cannot keep: an agent that
    // sees `--limit` reasonably concludes the operation pages. So it is refused
    // locally, with the conflict named, rather than sent into the void.
    const limited = await invoke(['project', 'list', '--limit', '1']);
    expect(limited.code).toBe(2);
    expect(limited.stderr).toContain('--limit');
    expect(requests).toEqual([]);

    const cursored = await invoke(['project', 'list', '--cursor', 'abc']);
    expect(cursored.code).toBe(2);
    expect(cursored.stderr).toContain('--cursor');
    expect(requests).toEqual([]);
  });

  it('POSITIVE CONTROL: the same command with no fictional flag reaches the wire', async () => {
    // Proves the refusal above is about those two flags and not about the
    // command being unable to make a request at all.
    respond = () => ({ body: [RESOURCE] });
    const r = await invoke(['project', 'list']);
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toBe('');
  });

  it('--format json emits the server DTO verbatim, with no CLI envelope', async () => {
    respond = () => ({ body: [RESOURCE] });
    const r = await invoke(['project', 'list', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual([RESOURCE]);
  });
});

describe('tm8 project create', () => {
  it('binds POST /v2/projects and generates a UUIDv7 mutation id when omitted', async () => {
    respond = () => ({ status: 201, body: RESOURCE });
    const r = await invoke(['project', 'create', 'tm8', '--working-dir', '/Users/agent/tm8']);
    expect(r.code).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe(bindPath('projects.create'));
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.name).toBe('tm8');
    expect(body.workingDir).toBe('/Users/agent/tm8');
    expect(String(body.clientMutationId)).toMatch(UUID_PATTERN);
  });

  it('passes a supplied mutation id VERBATIM', async () => {
    respond = () => ({ status: 201, body: RESOURCE });
    await invoke([
      'project', 'create', 'tm8', '--working-dir', '/tmp/x', '--mutation-id', 'MiXeD-Case_id',
    ]);
    expect((requests[0]?.body as Record<string, unknown>).clientMutationId).toBe('MiXeD-Case_id');
  });

  it('opts into creating one missing working-directory child explicitly', async () => {
    respond = () => ({ status: 201, body: RESOURCE });
    await invoke([
      'project', 'create', 'tm8', '--working-dir', '/tmp/new-project', '--ensure-working-dir',
    ]);
    expect((requests[0]?.body as Record<string, unknown>).ensureWorkingDir).toBe(true);
  });

  it('carries trust and the three spawn defaults, with `none` clearing a default', async () => {
    respond = () => ({ status: 201, body: RESOURCE });
    await invoke([
      'project', 'create', 'tm8', '--working-dir', '/tmp/x',
      '--trust', 'trusted', '--repo-url', 'https://example.invalid/r.git',
      '--default-model', 'claude', '--default-agent-tool', 'none', '--default-mode', 'worker',
    ]);
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.trust).toBe('trusted');
    expect(body.repoUrl).toBe('https://example.invalid/r.git');
    expect(body.defaults).toEqual({ model: 'claude', agentTool: null, mode: 'worker' });
  });

  it('refuses a relative --working-dir LOCALLY, before the network', async () => {
    const r = await invoke(['project', 'create', 'tm8', '--working-dir', 'relative/path']);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('refuses a `..` segment in --working-dir locally', async () => {
    const r = await invoke(['project', 'create', 'tm8', '--working-dir', '/Users/../etc']);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('refuses a trust level outside the closed set, naming the set', async () => {
    const r = await invoke(['project', 'create', 'tm8', '--working-dir', '/tmp/x', '--trust', 'sort-of']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('trusted');
    expect(r.stderr).toContain('untrusted');
    expect(requests).toEqual([]);
  });

  it('requires --working-dir', async () => {
    const r = await invoke(['project', 'create', 'tm8']);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('tm8 project get / update', () => {
  it('get binds :projectId and refuses --mutation-id', async () => {
    respond = () => ({ body: RESOURCE });
    const ok = await invoke(['project', 'get', PROJECT]);
    expect(ok.code).toBe(0);
    expect(requests[0]?.path).toBe(bindPath('projects.get', { projectId: PROJECT }));
    requests = [];
    const bad = await invoke(['project', 'get', PROJECT, '--mutation-id', 'x']);
    expect(bad.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('update PATCHes only what was supplied', async () => {
    respond = () => ({ body: RESOURCE });
    const r = await invoke(['project', 'update', PROJECT, '--name', 'renamed']);
    expect(r.code).toBe(0);
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.path).toBe(bindPath('projects.update', { projectId: PROJECT }));
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.name).toBe('renamed');
    expect('workingDir' in body).toBe(false);
    expect('trust' in body).toBe(false);
  });

  it('refuses an empty update rather than bumping a version for nothing', async () => {
    const r = await invoke(['project', 'update', PROJECT]);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('§7.5: --working-dir relocation requires --yes, and only that flag does', async () => {
    const without = await invoke(['project', 'update', PROJECT, '--working-dir', '/tmp/moved']);
    expect(without.code).toBe(2);
    expect(without.stderr).toContain('--yes');
    expect(requests).toEqual([]);

    respond = () => ({ body: RESOURCE });
    const with_ = await invoke(['project', 'update', PROJECT, '--working-dir', '/tmp/moved', '--yes']);
    expect(with_.code).toBe(0);
    expect((requests[0]?.body as Record<string, unknown>).workingDir).toBe('/tmp/moved');
  });

  it('does NOT require --yes for a rename — §7.5 names working-dir exactly', async () => {
    respond = () => ({ body: RESOURCE });
    const r = await invoke(['project', 'update', PROJECT, '--trust', 'trusted', '--name', 'x']);
    expect(r.code).toBe(0);
  });
});

describe('tm8 project link — two identifier domains, never interchangeable', () => {
  it('binds the Space-scoped path and carries the ProjectResource id in the body', async () => {
    respond = () => ({ body: { spaceId: SPACE, projectId: PROJECT, projectEntityId: PROJECTION, patches: [] } });
    const r = await invoke(['project', 'link', PROJECT, '--space', SPACE]);
    expect(r.code).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe(bindPath('projects.link', { spaceId: SPACE }));
    expect((requests[0]?.body as Record<string, unknown>).projectId).toBe(PROJECT);
  });

  it('renders BOTH identities, each named for its own domain', async () => {
    respond = () => ({ body: { spaceId: SPACE, projectId: PROJECT, projectEntityId: PROJECTION, patches: [] } });
    const r = await invoke(['project', 'link', PROJECT, '--space', SPACE]);
    expect(r.stdout).toContain(PROJECT);
    expect(r.stdout).toContain(PROJECTION);
    expect(r.stdout).toMatch(/projectEntityId[^\n]*00000000-0000-7000-8000-0000000000dd/);
    expect(r.stdout).toMatch(/projectId[^\n]*00000000-0000-7000-8000-0000000000bb/);
  });

  it('when the node returns no projection id, it says so and NEVER substitutes the resource id', async () => {
    respond = () => ({ body: { spaceId: SPACE, projectId: PROJECT, patches: [] } });
    const r = await invoke(['project', 'link', PROJECT, '--space', SPACE]);
    expect(r.code).toBe(0);
    const projectionLine = r.stdout.split('\n').find((l) => l.includes('projectEntityId')) ?? '';
    expect(projectionLine).not.toContain(PROJECT);
    expect(projectionLine.length).toBeGreaterThan(0);
    // stderr names the separate domain as a CONTRACT fact — `projectEntityId`
    // has zero occurrences in packages/contract/src, so the result is complete
    // as specified and this is not a claim that the node misbehaved.
    expect(r.stderr).toMatch(/projection entity/i);
    // and it never prints the ProjectResource id where the projection id would go
    expect(r.stderr).not.toContain(PROJECT);
  });

  it('requires a Space in context', async () => {
    const r = await invoke(['project', 'link', PROJECT]);
    expect(r.code).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('tm8 project unlink', () => {
  it('§7.5: refuses without --yes and never reaches the network', async () => {
    const r = await invoke(['project', 'unlink', PROJECT, '--space', SPACE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(requests).toEqual([]);
  });

  it('binds DELETE with both path params and a required clientMutationId', async () => {
    respond = () => ({ body: { spaceId: SPACE, projectId: PROJECT, patches: [] } });
    const r = await invoke(['project', 'unlink', PROJECT, '--space', SPACE, '--yes']);
    expect(r.code).toBe(0);
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.path).toBe(bindPath('projects.unlink', { spaceId: SPACE, projectId: PROJECT }));
    expect(String((requests[0]?.body as Record<string, unknown>).clientMutationId)).toMatch(UUID_PATTERN);
  });
});

describe('tm8 project association correct (A04)', () => {
  it('binds the artifact command path and sends EXACTLY the frozen strict DTO', async () => {
    respond = () => ({ body: { artifactId: ARTIFACT, projectId: PROJECT, outcome: 'removed', edge: null } });
    const r = await invoke([
      'project', 'association', 'correct', ARTIFACT, '--project', PROJECT, '--expect-version', '3',
    ], { actorId: 'act_1' });
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe(bindPath('projects.associations.correct', { artifactId: ARTIFACT }));
    const body = requests[0]?.body as Record<string, unknown>;
    // CorrectProjectAssociationInputSchema is .strict() and has NO actorId
    // member: sending the ambient actor would be refused by the Server.
    expect(Object.keys(body).sort()).toEqual(['clientMutationId', 'expectedArtifactVersion', 'projectId']);
    expect(body.expectedArtifactVersion).toBe(3);
  });

  it('requires the version guard the frozen DTO requires', async () => {
    const r = await invoke(['project', 'association', 'correct', ARTIFACT, '--project', PROJECT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
    expect(requests).toEqual([]);
  });

  it('refuses `--project none` locally, naming the frozen DTO it cannot satisfy', async () => {
    const r = await invoke([
      'project', 'association', 'correct', ARTIFACT, '--project', 'none', '--expect-version', '1',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('projectId');
    expect(requests).toEqual([]);
  });

  it('renders the outcome, both ids, and the edge when one survives', async () => {
    respond = () => ({
      body: { artifactId: ARTIFACT, projectId: PROJECT, outcome: 'demoted', edge: { id: 'edg_1' } },
    });
    const r = await invoke([
      'project', 'association', 'correct', ARTIFACT, '--project', PROJECT, '--expect-version', '2',
    ]);
    expect(r.stdout).toContain('demoted');
    expect(r.stdout).toContain(ARTIFACT);
    expect(r.stdout).toContain(PROJECT);
  });
});

describe('server refusals keep their frozen exit codes', () => {
  it('a 501 is exit 8 and is never dressed up as a defect', async () => {
    respond = () => ({
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation projects.list is not implemented on this node',
          requestId: 'req_test',
          retryable: false,
        },
      },
    });
    const r = await invoke(['project', 'list']);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('not_implemented');
  });

  it('a version_conflict is exit 6', async () => {
    respond = () => ({
      status: 409,
      body: {
        error: { code: 'version_conflict', message: 'stale', requestId: 'req_test', retryable: false },
      },
    });
    const r = await invoke([
      'project', 'association', 'correct', ARTIFACT, '--project', PROJECT, '--expect-version', '1',
    ]);
    expect(r.code).toBe(6);
  });
});
