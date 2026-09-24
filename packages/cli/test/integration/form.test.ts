/**
 * `tm8 form` against the REAL Server (Forms W1 CLI) — the built binary, a
 * freshly migrated scratch database, and every forms.* op the noun binds:
 *
 *   create (--for-session) → question add → open → submit → response get/list/mine
 *   → amend (a second submit is revision 2) → draft save → discard (idempotent)
 *   → the freeze → close → cancel refused → submit on a closed form refused.
 *
 * The caller is the harness's local owner — a HUMAN member — so a form starts as
 * a draft (§5) and the owner may answer it (respondents: humans). The requesting
 * session is a `work_session` row inserted directly: the harness has no PTY host
 * and no spawn, and `--for-session` only needs the row and the right to message
 * it. Run with --no-file-parallelism.
 */
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindPath, FORM_QUESTION_TYPE_NAMES } from '@tm8/contract';

import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';
import { uuidv7 } from '../../src/mutation.js';

let server: RealServer;
let spaceId = '';
let sessionId = '';

async function psql(database: string, sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const admin = new URL(
    process.env.TM8_W4_ADMIN_DATABASE_URL ??
      process.env.TM8_MIGRATION_DATABASE_URL ??
      `postgres://${process.env.TM8_PG_USER ?? 'tm8'}@127.0.0.1:${process.env.TM8_PG_PORT ?? '5442'}/postgres`,
  );
  if (database) admin.pathname = `/${database}`;
  return await new Promise((resolve) => {
    const child = spawn('psql', ['-w', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', admin.href, '-c', sql], {
      env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function scratchDatabase(): Promise<string> {
  const r = await psql('', `select datname from pg_database where datname like 'tm8_w4_forms_cli_${process.pid}_%'`);
  const names = r.stdout.trim().split('\n').filter(Boolean);
  if (names.length !== 1) throw new Error(`expected one scratch database for pid ${process.pid}, got ${JSON.stringify(names)}`);
  return String(names[0]);
}

async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return cli(argv, server);
}

/** A json-format invocation that must succeed; returns the parsed DTO. */
async function ok<T = Record<string, unknown>>(argv: readonly string[]): Promise<T> {
  const r = await tm8([...argv, '--format', 'json']);
  if (r.code !== 0) throw new Error(`tm8 ${argv.join(' ')} -> ${r.code}\n${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

interface FormResult { entity: { id: string; version: number; content: { status: string; questions: unknown[] } } }
interface View {
  id: string; status: string; revision: number; isCurrent: boolean; supersedesId: string | null;
  lineageKey: string; version: number; answers: Record<string, unknown>;
  deliveries: { workSessionId: string; status: string }[];
}
interface Page { items: View[]; nextCursor: string | null }

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('forms-cli');
  const res = await fetch(new URL(bindPath('spaces.create', {}), server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'forms cli probe', clientMutationId: uuidv7() }),
  });
  const json = (await res.json()) as { data?: { space?: { id?: string } } };
  spaceId = json.data?.space?.id ?? '';
  if (!spaceId) throw new Error(`fixture spaces.create ${res.status}: ${JSON.stringify(json)}`);

  // A task to copy space_id/created_by from (the member row the owner acts as).
  const task = await fetch(new URL(bindPath('entities.create', {}), server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId: uuidv7(), spaceId, kind: 'task', title: 'forms anchor' }),
  });
  const taskJson = (await task.json()) as { data?: { entity?: { id?: string } } };
  const anchorId = taskJson.data?.entity?.id ?? '';
  if (!anchorId) throw new Error(`fixture entities.create ${task.status}: ${JSON.stringify(taskJson)}`);

  // The requesting session: a running, space-shared work_session row.
  sessionId = uuidv7();
  const db = await scratchDatabase();
  const r = await psql(
    db,
    `insert into public.entities(id, space_id, kind, visibility, created_by)
       select '${sessionId}', space_id, 'work_session', 'space', created_by from public.entities where id = '${anchorId}';
     insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ('${sessionId}', 'forms cli session', 'running', 'space', now());`,
  );
  if (r.code !== 0) throw new Error(`work_session fixture: ${r.stderr}`);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe('tm8 form — end to end on a real Server', () => {
  let formId = '';
  let version = 0;
  let first: View;
  let second: View;

  it('create: shorthand + --for-session, a human-created form starts as a draft', async () => {
    const created = await ok<FormResult & { url: string; requestingSessionId: string | null }>([
      'form', 'create', '--space', spaceId, '--title', 'Migration plan',
      '--question', 'strategy:single_choice:Which approach?:online=Online backfill*,dual=Dual write',
      '--question', 'notes:long_text:Anything to watch for?', '--optional', 'notes',
      '--for-session', sessionId,
    ]);
    formId = created.entity.id;
    version = created.entity.version;
    expect(created.entity.content.status).toBe('draft');
    expect(created.entity.content.questions).toHaveLength(2);
    expect(created.requestingSessionId).toBe(sessionId);
    expect(created.url).toContain(formId);
  });

  it('the human receipt prints the form id and the url', async () => {
    const r = await tm8(['form', 'create', '--space', spaceId, '--title', 'Receipt probe', '--question', 'a:long_text:A']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^form [0-9a-f-]{36}  v\d+  draft/m);
    expect(r.stdout).toMatch(/url: http:\/\/127\.0\.0\.1:\d+\/#\/s\//);
  });

  it('an invalid spec exits 2 locally', async () => {
    const r = await tm8(['form', 'create', '--space', spaceId, '--title', 'Bad', '--question', 'r:scale:Rate:a,b']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/r\.config\s+unrecognized_keys/);
  });

  it('question add, then open, each chaining the form version', async () => {
    const added = await ok<FormResult>(['form', 'question', 'add', formId, '--expect-version', String(version), '--question', 'rate:scale:How risky?']);
    expect(added.entity.content.questions).toHaveLength(3);
    const opened = await ok<FormResult>(['form', 'open', formId, '--expect-version', String(added.entity.version)]);
    expect(opened.entity.content.status).toBe('open');
    version = opened.entity.version;
  });

  it('a stale --expect-version is a version conflict (exit 6)', async () => {
    const r = await tm8(['form', 'question', 'add', formId, '--expect-version', '1', '--question', 'late:long_text:Late']);
    expect(r.code).toBe(6);
  });

  it('submit validates locally (exit 2, nothing stored) before it submits', async () => {
    const r = await tm8(['form', 'submit', formId, '--answers', '{"strategy":{"value":"nope"}}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/strategy\s+not_an_option/);
    expect(r.stderr).toMatch(/rate\s+required/);
  });

  it('submit stores revision 1 and records a delivery to the requesting session', async () => {
    first = await ok<View>(['form', 'submit', formId, '--answers', '{"strategy":{"value":"online"},"rate":{"number":4}}']);
    expect(first.status).toBe('submitted');
    expect(first.revision).toBe(1);
    expect(first.isCurrent).toBe(true);
    expect(first.deliveries.map((d) => d.workSessionId)).toEqual([sessionId]);
  });

  it('response get / list / mine all see it', async () => {
    const got = await ok<View>(['form', 'response', 'get', first.id]);
    expect(got.answers).toEqual({ strategy: { value: 'online' }, rate: { number: 4 } });
    const human = await tm8(['form', 'response', 'get', first.id]);
    expect(human.stdout).toContain('[strategy] Which approach? → online ("Online backfill") [recommended]');

    const list = await ok<Page>(['form', 'response', 'list', formId]);
    expect(list.items.map((i) => i.id)).toEqual([first.id]);
    const mine = await ok<Page>(['form', 'response', 'mine', '--space', spaceId]);
    expect(mine.items.map((i) => i.id)).toContain(first.id);
  });

  it('amend: a second submit is revision 2 superseding revision 1; --lineage shows the history', async () => {
    second = await ok<View>(['form', 'submit', formId, '--answers', '{"strategy":{"value":"dual"},"rate":{"number":2}}']);
    expect(second.revision).toBe(2);
    expect(second.supersedesId).toBe(first.id);
    const current = await ok<Page>(['form', 'response', 'list', formId]);
    expect(current.items.map((i) => i.id)).toEqual([second.id]);
    const history = await ok<Page>(['form', 'response', 'list', formId, '--lineage', second.lineageKey]);
    expect(history.items.map((i) => i.revision)).toEqual([1, 2]);
  });

  it('draft save, then discard (idempotent)', async () => {
    const draft = await ok<View>(['form', 'response', 'save', formId, '--answers', '{"strategy":{"value":"online"}}']);
    expect(draft.status).toBe('draft');
    const mineHere = await ok<Page>(['form', 'response', 'list', formId, '--respondent', 'me']);
    expect(mineHere.items.map((i) => i.status).sort()).toEqual(['draft', 'submitted']);

    const gone = await ok<{ discarded: boolean }>(['form', 'response', 'discard', formId, '--response-version', String(draft.version)]);
    expect(gone.discarded).toBe(true);
    const again = await ok<{ discarded: boolean }>(['form', 'response', 'discard', formId]);
    expect(again.discarded).toBe(false);
  });

  it('the structure is frozen after the first submitted response', async () => {
    const detail = await ok<{ version: number }>(['entity', 'get', formId, '--full']);
    const r = await tm8(['form', 'question', 'add', formId, '--expect-version', String(detail.version), '--question', 'late:long_text:Late']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('form_structure_frozen');
    version = detail.version;
  });

  it('close; cancel on a closed form is refused with the lifecycle hint; submit on it is form_not_open', async () => {
    const closed = await ok<FormResult>(['form', 'close', formId, '--expect-version', String(version)]);
    expect(closed.entity.content.status).toBe('closed');
    const cancel = await tm8(['form', 'cancel', formId, '--expect-version', String(closed.entity.version)]);
    expect(cancel.code).toBe(6);
    expect(cancel.stderr).toContain('form_transition_invalid');
    expect(cancel.stderr).toContain('closed->open');
    const late = await tm8(['form', 'submit', formId, '--answers', '{"strategy":{"value":"online"},"rate":{"number":1}}']);
    expect(late.code).toBe(6);
    expect(late.stderr).toContain('form_not_open');
    const reopened = await ok<FormResult>(['form', 'reopen', formId, '--expect-version', String(closed.entity.version)]);
    expect(reopened.entity.content.status).toBe('open');
  });

  it('the built binary\'s `tm8 help form` teaches every registry type', async () => {
    const r = await tm8(['help', 'form']);
    expect(r.code).toBe(0);
    for (const type of FORM_QUESTION_TYPE_NAMES) expect(r.stdout).toContain(type);
    expect(r.stdout).toContain('tm8 form wait');
  });
});
