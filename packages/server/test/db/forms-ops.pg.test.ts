/**
 * Forms W1 — the thirteen forms.* operations end to end, through the service
 * and the 211 doors, against a real scratch database.
 *
 * Pinned here, per op: the success path, every §6 error code the op can
 * answer, and the permission rules — author/admin for structure and
 * lifecycle, respondents humans-vs-anyone, draft privacy (a member and a
 * teammate cannot read another's draft through the HTTP read paths), and
 * that no raw 23505/22023 escapes as anything but the taxonomy.
 */
import { randomUUID } from 'node:crypto';

import {
  CollabError,
  FormResponsePageSchema,
  FormResponseViewSchema,
  OPERATIONS,
  isCollabError,
  type CommandResult,
  type FormResponsePage,
  type FormResponseView,
  type OperationName,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { buildDetail } from '../../src/facade/handlers/entities.js';
import { registerW2FormHandlers } from '../../src/facade/handlers/w2/forms.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { W2FormsService, type FormResponseSubmitted } from '../../src/facade/services/w2/forms.js';
import { createSavedViewsActionsService } from '../../src/facade/services/w2/saved-views-actions.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { claimsFor } from '../../src/facade/context.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

type Row = Record<string, any>;

interface World {
  space: string;
  otherSpace: string;
  m1: string; // owner (admin), identity 1
  m2: string; // plain member, identity 2
  m3: string; // plain member, identity 3
  teammate: string; // agent persona owned by m1
  session: string; // the teammate's live work session
  session2: string; // another live session in the space
  task: string; // the task the session is working_on
  task2: string; // an explicit attach target
}

const ID1 = 'forms-ops-1';
const ID2 = 'forms-ops-2';
const ID3 = 'forms-ops-3';

let database: W1ScratchDatabase;
let db: PgDb;
let owner: LoopbackOwner;
let service: W2FormsService;
let w: World;
const submitted: FormResponseSubmitted[] = [];

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

const human = (identityId: string): RequestIdentity => ({ kind: 'bearer', identityId, authKind: 'cli' });
const agent = (): RequestIdentity => ({
  kind: 'bearer', identityId: ID1, actorId: w.teammate, workSessionId: w.session, authKind: 'agent',
});
const OWNER: RequestIdentity = { kind: 'auto-owner', identityId: ID1, authKind: 'browser' };

function ctx(
  opName: OperationName, identity: RequestIdentity,
  params: Record<string, string> = {}, body?: unknown, query: Record<string, string> = {},
): RequestContext {
  const op = OPERATIONS.find((o) => o.name === opName)!;
  return {
    op, opName, params, query: new URLSearchParams(query), body,
    requestId: `req-${randomUUID()}`, identity, headers: {}, method: op.method, path: op.path,
  };
}

const cmid = () => `forms-${randomUUID()}`;

async function call<T = any>(
  handler: (c: RequestContext) => unknown, opName: OperationName, identity: RequestIdentity,
  params: Record<string, string> = {}, body?: unknown, query: Record<string, string> = {},
): Promise<T> {
  return (await handler(ctx(opName, identity, params, body, query))) as T;
}

/** The CollabError a call raises (fails the test when it succeeds). */
async function refusal(p: Promise<unknown>): Promise<CollabError> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').not.toBeNull();
  expect(isCollabError(error), String(error)).toBe(true);
  return error as CollabError;
}

async function sql(text: string, params: unknown[] = []): Promise<Row[]> {
  return database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    return (await c.query(text, params)).rows;
  });
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

const OPTIONS = [{ value: 'x', label: 'X', recommended: true }, { value: 'y', label: 'Y' }];
const QUESTIONS = [
  { key: 'pick', type: 'single_choice', title: 'Pick one', config: { options: OPTIONS } },
  { key: 'why', type: 'short_text', title: 'Why?', required: false, config: { maxLength: 40 } },
];

async function createForm(
  identity: RequestIdentity, extra: Row = {},
): Promise<CommandResult & { url: string; requestingSessionId: string | null; attachedTo: string[] }> {
  return call(service.create, 'forms.create', identity, {}, {
    clientMutationId: cmid(), spaceId: w.space, title: 'Pick the strategy', questions: QUESTIONS, ...extra,
  });
}

async function version(id: string): Promise<number> {
  return Number((await sql(`select version from public.entities where id = $1`, [id]))[0]!.version);
}

async function openForm(identity: RequestIdentity, extra: Row = {}): Promise<string> {
  const created = await createForm(identity, { open: true, ...extra });
  return created.entity!.id;
}

async function save(form: string, identity: RequestIdentity, answers: Row, extra: Row = {}): Promise<FormResponseView> {
  return call(service.responsesSave, 'forms.responses.save', identity, { formId: form },
    { clientMutationId: cmid(), answers, ...extra });
}

async function submit(form: string, identity: RequestIdentity, answers?: Row, extra: Row = {}): Promise<FormResponseView> {
  return call(service.responsesSubmit, 'forms.responses.submit', identity, { formId: form },
    { clientMutationId: cmid(), ...(answers ? { answers } : {}), ...extra });
}

async function list(form: string, identity: RequestIdentity, query: Record<string, string> = {}): Promise<FormResponsePage> {
  return call(service.responsesList, 'forms.responses.list', identity, { formId: form }, undefined, query);
}

async function detailFor(id: string, identity: RequestIdentity) {
  const c = ctx('entities.get', identity);
  return db.tx(claimsFor(owner, c), (q) => buildDetail(q, id, identity.identityId!));
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seed(): Promise<World> {
  return database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    const id = async () => (await c.query(`select internal.new_id()::text id`)).rows[0]!.id as string;
    const x: World = {
      space: await id(), otherSpace: await id(), m1: await id(), m2: await id(), m3: await id(),
      teammate: await id(), session: await id(), session2: await id(), task: await id(), task2: await id(),
    };
    for (const identity of [ID1, ID2, ID3]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
    }
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Forms ops', $2), ($3, 'Other', $2)`,
      [x.space, ID1, x.otherSpace]);
    const member = async (eid: string, identity: string, role: string) => {
      await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                     values ($1, $2, 'member', 'space', $1)`, [eid, x.space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, $4, $3)`, [eid, x.space, identity, role]);
    };
    await member(x.m1, ID1, 'owner');
    await member(x.m2, ID2, 'member');
    await member(x.m3, ID3, 'member');
    await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                   values ($1, $2, 'team_member', 'space', $3)`, [x.teammate, x.space, x.m1]);
    await c.query(`insert into public.team_members(entity_id, name, owner_member_id) values ($1, 'Agent', $2)`,
      [x.teammate, x.m1]);
    for (const s of [x.session, x.session2]) {
      await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                     values ($1, $2, 'work_session', 'space', $3)`, [s, x.space, x.teammate]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
                     values ($1, 'session', 'running', 'space', now())`, [s]);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
                     values ($1, $2, $3, 'participates_in', $2)`, [x.space, x.teammate, s]);
    }
    for (const t of [x.task, x.task2]) {
      await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                     values ($1, $2, 'task', 'space', $3)`, [t, x.space, x.m1]);
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'A task')`, [t]);
    }
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
                   values ($1, $2, $3, 'working_on', $4)`, [x.space, x.session, x.task, x.teammate]);
    return x;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('forms_ops');
  database.apply(migrationFiles());
  w = await seed();
  db = new PgDb({ databaseUrl: database.url });
  owner = { identityId: ID1, accountId: 'acct-forms', username: 'owner', isNodeAdmin: true, isOwner: true };
  const deps: FacadeDeps = { db, config: {} as FacadeDeps['config'], owner: async () => owner };
  service = new W2FormsService(deps, { onResponseSubmitted: (e) => { submitted.push(e); } });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers all thirteen forms.* operations, and the catalog has exactly those', () => {
    const registry = new HandlerRegistry();
    registerW2FormHandlers(registry, {} as FacadeDeps);
    const names = OPERATIONS.filter((o) => o.name.startsWith('forms.')).map((o) => o.name);
    expect(names).toHaveLength(13);
    for (const name of names) expect(registry.get(name), name).toBeTypeOf('function');
  });
});

describe('forms.create', () => {
  it('an agent: open by default, authored_from its verified session, attached to its working_on task, attention raised, url', async () => {
    const created = await createForm(agent(), { attachTo: [w.task2] });
    const id = created.entity!.id;
    expect(created.url).toBe(`/#/s/${w.space}/e/${id}`);
    expect(created.requestingSessionId).toBe(w.session);
    expect(new Set(created.attachedTo)).toEqual(new Set([w.task, w.task2]));
    expect(created.entity!.content).toMatchObject({ kind: 'form', status: 'open' });
    const content = created.entity!.content as Row;
    expect(content['questions'].map((q: Row) => q['key'])).toEqual(['pick', 'why']);
    expect(content['settings']).toMatchObject({ responses: 'per_member', respondents: 'humans', attentionPoints: 60 });

    const edges = await sql(`select type, dst_id, props from public.edges where src_id = $1 order by type, dst_id`, [id]);
    expect(edges.find((e) => e.type === 'authored_from')).toMatchObject({
      dst_id: w.session, props: expect.objectContaining({ attribution: 'verified', origin: 'materialized' }),
    });
    expect(edges.filter((e) => e.type === 'attached_to').map((e) => e.dst_id).sort()).toEqual([w.task, w.task2].sort());
    const attention = await sql(`select reason, points, status from public.attention_requests where entity_id = $1`, [id]);
    expect(attention).toEqual([{ reason: 'Form: Pick the strategy', points: 60, status: 'open' }]);
  });

  it('a human: draft by default; forSession writes the edge recorded_only; no attention while draft', async () => {
    const created = await createForm(human(ID2), { forSession: w.session2 });
    const id = created.entity!.id;
    expect((created.entity!.content as Row)['status']).toBe('draft');
    const edge = (await sql(`select dst_id, props from public.edges where src_id = $1 and type = 'authored_from'`, [id]))[0]!;
    expect(edge).toMatchObject({ dst_id: w.session2, props: expect.objectContaining({ attribution: 'recorded_only' }) });
    expect(await sql(`select 1 from public.attention_requests where entity_id = $1`, [id])).toHaveLength(0);
  });

  it('forSession must be a session the caller can message; an agent cannot name another session', async () => {
    expect((await refusal(createForm(human(ID2), { forSession: randomUUID() }))).code).toBe('not_found');
    expect((await refusal(createForm(human(ID2), { forSession: w.task }))).code).toBe('not_found');
    expect((await refusal(createForm(agent(), { forSession: w.session2 }))).code).toBe('invalid_input');
  });

  it('is idempotent on clientMutationId', async () => {
    const body = { clientMutationId: cmid(), spaceId: w.space, title: 'Once', questions: QUESTIONS };
    const a = await call<CommandResult>(service.create, 'forms.create', human(ID2), {}, body);
    const b = await call<CommandResult>(service.create, 'forms.create', human(ID2), {}, body);
    expect(b.entity!.id).toBe(a.entity!.id);
  });

  it('config the SQL arm refuses is a 422 with details.issues keyed by question', async () => {
    const e = await refusal(createForm(human(ID2), { questions: [
      { key: 'pick', type: 'single_choice', title: 'Pick', config: { options: [{ value: 'a', label: 'A' }] } },
    ] }));
    expect(e.code).toBe('form_answers_invalid');
    expect((e.details as Row)['issues']).toEqual([expect.objectContaining({ key: 'pick', code: 'invalid_config' })]);
  });

  it('a bad short_text pattern is refused by SQL (the server never compiles it on the request path)', async () => {
    const e = await refusal(createForm(human(ID2), { questions: [
      { key: 'code', type: 'short_text', title: 'Code', config: { pattern: '(' } },
    ] }));
    expect(e.code).toBe('form_answers_invalid');
    expect((e.details as Row)['issues'][0]).toMatchObject({ key: 'code', code: 'invalid_config' });
  });

  it('an unknown type, an unknown section and a duplicate key never leak a raw 23xxx', async () => {
    const unknownType = await refusal(createForm(human(ID2), { questions: [{ key: 'a', type: 'no_such', title: 'A' }] }));
    expect(unknownType.code).toBe('form_answers_invalid');
    const section = await refusal(createForm(human(ID2), { questions: [{ ...QUESTIONS[1], section: 'nope' }] }));
    expect(section.code).toBe('form_answers_invalid');
    expect((section.details as Row)['issues'][0]).toMatchObject({ key: 'why', code: 'unknown_section' });
    const dup = await refusal(createForm(human(ID2), { questions: [QUESTIONS[1], QUESTIONS[1]] }));
    expect(dup.code).toBe('conflict');
    expect((dup.details as Row)['reason']).toBe('form_key_taken');
  });

  it('a non-member cannot create in the space', async () => {
    const e = await refusal(call(service.create, 'forms.create', human(ID2), {}, {
      clientMutationId: cmid(), spaceId: w.otherSpace, title: 'X', questions: [],
    }));
    expect(['forbidden', 'not_found']).toContain(e.code);
  });
});

describe('forms.update and canEdit agree (author or space admin)', () => {
  it('a plain member who is not the author: canEdit false AND 403 on every structure/lifecycle door', async () => {
    const created = await createForm(human(ID2));
    const id = created.entity!.id;
    const v = await version(id);
    expect((await detailFor(id, human(ID3))).capabilities.canEdit).toBe(false);
    expect((await detailFor(id, human(ID2))).capabilities.canEdit).toBe(true);
    expect((await detailFor(id, OWNER)).capabilities.canEdit).toBe(true); // space admin
    for (const [handler, op, params, body] of [
      [service.update, 'forms.update', { formId: id }, { title: 'Hijack' }],
      [service.questionsAdd, 'forms.questions.add', { formId: id }, { question: { key: 'z', type: 'short_text', title: 'Z' } }],
      [service.questionsUpdate, 'forms.questions.update', { formId: id, questionKey: 'why' }, { title: 'Z' }],
      [service.questionsRemove, 'forms.questions.remove', { formId: id, questionKey: 'why' }, {}],
      [service.questionsMove, 'forms.questions.move', { formId: id, questionKey: 'why' }, { after: null }],
      [service.transition, 'forms.transition', { formId: id }, { to: 'open' }],
    ] as const) {
      const e = await refusal(call(handler, op, human(ID3), params, { clientMutationId: cmid(), expectedVersion: v, ...body }));
      expect(e.code, op).toBe('forbidden');
    }
    // The space admin may.
    const updated = await call<CommandResult>(service.update, 'forms.update', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: v, title: 'Renamed by admin' });
    expect(updated.entity!.title).toBe('Renamed by admin');
  });

  it('title, description, settings (sparse merge) under expectedVersion; stale version is 409', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    const v = await version(id);
    const r = await call<CommandResult>(service.update, 'forms.update', human(ID2), { formId: id }, {
      clientMutationId: cmid(), expectedVersion: v, description: 'Why we ask',
      settings: { responses: 'single', delivery: { onSessionNotLive: 'queue' } },
    });
    expect((r.entity!.content as Row)['settings']).toMatchObject({
      responses: 'single', delivery: { target: 'requesting_session', onSessionNotLive: 'queue' },
    });
    expect((await sql(`select settings from public.forms where entity_id = $1`, [id]))[0]!.settings)
      .toEqual({ responses: 'single', delivery: { onSessionNotLive: 'queue' } }); // stored sparse
    const stale = await refusal(call(service.update, 'forms.update', human(ID2), { formId: id },
      { clientMutationId: cmid(), expectedVersion: v, title: 'late' }));
    expect(stale.code).toBe('version_conflict');
  });

  it('sections replace the list, bump structure_version, and a dropped section releases its questions', async () => {
    const id = (await createForm(human(ID2), {
      sections: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }],
      questions: [{ ...QUESTIONS[1], section: 'b' }],
    })).entity!.id;
    const before = (await sql(`select structure_version from public.forms where entity_id = $1`, [id]))[0]!.structure_version;
    await call(service.update, 'forms.update', human(ID2), { formId: id }, {
      clientMutationId: cmid(), expectedVersion: await version(id), sections: [{ key: 'c', title: 'C' }, { key: 'a', title: 'A2' }],
    });
    expect(await sql(`select key, position, title from public.form_sections where form_id = $1 order by position`, [id]))
      .toEqual([{ key: 'c', position: 0, title: 'C' }, { key: 'a', position: 1, title: 'A2' }]);
    expect((await sql(`select section from public.form_questions where form_id = $1`, [id]))[0]!.section).toBeNull();
    expect((await sql(`select structure_version from public.forms where entity_id = $1`, [id]))[0]!.structure_version)
      .toBe(before + 1);
  });

  it('a cancelled form refuses edits (form_not_open)', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    await call(service.transition, 'forms.transition', human(ID2), { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), to: 'cancelled' });
    const e = await refusal(call(service.update, 'forms.update', human(ID2), { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), title: 'x' }));
    expect(e.code).toBe('form_not_open');
  });
});

describe('forms.questions.*', () => {
  const order = async (id: string) =>
    (await sql(`select key from public.form_questions where form_id = $1 order by position`, [id])).map((r) => r.key);
  const structure = async (id: string) =>
    Number((await sql(`select structure_version from public.forms where entity_id = $1`, [id]))[0]!.structure_version);

  it('add: appended, after a key, or first; each bumps structure_version', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    const q = (key: string) => ({ key, type: 'long_text', title: key.toUpperCase() });
    const add = async (key: string, after?: string | null) => call(service.questionsAdd, 'forms.questions.add', human(ID2),
      { formId: id }, { clientMutationId: cmid(), expectedVersion: await version(id), question: q(key),
        ...(after === undefined ? {} : { after }) });
    const s0 = await structure(id);
    await add('end');
    await add('mid', 'pick');
    await add('first', null);
    expect(await order(id)).toEqual(['first', 'pick', 'mid', 'why', 'end']);
    expect(await structure(id)).toBe(s0 + 3);
    expect((await refusal(add('pick'))).code).toBe('conflict'); // duplicate key: never a raw 23505
    expect((await refusal(add('zz', 'nope'))).code).toBe('not_found');
  });

  it('update: partial; bad config is 422; an unknown key is 404', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    await call(service.questionsUpdate, 'forms.questions.update', human(ID2), { formId: id, questionKey: 'why' },
      { clientMutationId: cmid(), expectedVersion: await version(id), title: 'Why, really?', help: 'Be brief' });
    expect((await sql(`select title, help, required from public.form_questions where form_id = $1 and key = 'why'`, [id]))[0])
      .toEqual({ title: 'Why, really?', help: 'Be brief', required: false });
    const bad = await refusal(call(service.questionsUpdate, 'forms.questions.update', human(ID2),
      { formId: id, questionKey: 'why' }, { clientMutationId: cmid(), expectedVersion: await version(id), config: { maxLength: 9999 } }));
    expect(bad.code).toBe('form_answers_invalid');
    expect((bad.details as Row)['issues'][0]).toMatchObject({ key: 'why', code: 'invalid_config' });
    const missing = await refusal(call(service.questionsUpdate, 'forms.questions.update', human(ID2),
      { formId: id, questionKey: 'nope' }, { clientMutationId: cmid(), expectedVersion: await version(id), title: 'x' }));
    expect(missing.code).toBe('not_found');
  });

  it('move and remove renumber densely', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    await call(service.questionsMove, 'forms.questions.move', human(ID2), { formId: id, questionKey: 'why' },
      { clientMutationId: cmid(), expectedVersion: await version(id) });
    expect(await order(id)).toEqual(['why', 'pick']);
    await call(service.questionsMove, 'forms.questions.move', human(ID2), { formId: id, questionKey: 'why' },
      { clientMutationId: cmid(), expectedVersion: await version(id), after: 'pick' });
    expect(await order(id)).toEqual(['pick', 'why']);
    await call(service.questionsRemove, 'forms.questions.remove', human(ID2), { formId: id, questionKey: 'pick' },
      { clientMutationId: cmid(), expectedVersion: await version(id) });
    expect(await sql(`select key, position from public.form_questions where form_id = $1`, [id]))
      .toEqual([{ key: 'why', position: 0 }]);
    expect((await refusal(call(service.questionsRemove, 'forms.questions.remove', human(ID2),
      { formId: id, questionKey: 'pick' }, { clientMutationId: cmid(), expectedVersion: await version(id) }))).code).toBe('not_found');
  });

  it('a structure edit prunes draft answers that no longer validate and keeps the rest', async () => {
    const id = await openForm(human(ID1));
    await save(id, human(ID2), { pick: { value: 'y' }, why: { text: 'a fairly long reason' } });
    // Tighten `why` below the saved answer's length, and drop option `y`.
    await call(service.questionsUpdate, 'forms.questions.update', OWNER, { formId: id, questionKey: 'why' },
      { clientMutationId: cmid(), expectedVersion: await version(id), config: { maxLength: 5 } });
    await call(service.questionsUpdate, 'forms.questions.update', OWNER, { formId: id, questionKey: 'pick' },
      { clientMutationId: cmid(), expectedVersion: await version(id),
        config: { options: [{ value: 'x', label: 'X' }, { value: 'z', label: 'Z' }] } });
    const draft = (await list(id, human(ID2), { respondent: 'me' })).items[0]!;
    expect(draft.status).toBe('draft');
    expect(draft.answers).toEqual({});
    expect(draft.structureVersion).toBe(Number((await sql(`select structure_version from public.forms where entity_id = $1`, [id]))[0]!.structure_version));
  });

  it('frozen after the first SUBMITTED response (form_structure_frozen), for questions and sections', async () => {
    const id = await openForm(human(ID1));
    await submit(id, human(ID2), { pick: { value: 'x' } });
    const add = await refusal(call(service.questionsAdd, 'forms.questions.add', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), question: { key: 'late', type: 'long_text', title: 'Late' } }));
    expect(add.code).toBe('form_structure_frozen');
    const sections = await refusal(call(service.update, 'forms.update', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), sections: [{ key: 's', title: 'S' }] }));
    expect(sections.code).toBe('form_structure_frozen');
    const mode = await refusal(call(service.update, 'forms.update', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), settings: { responses: 'unlimited' } }));
    expect(mode.code).toBe('form_structure_frozen');
    // Title is not structure.
    await call(service.update, 'forms.update', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), title: 'Still fine' });
  });
});

describe('forms.transition', () => {
  const transition = async (id: string, to: string, identity: RequestIdentity = human(ID2), reason?: string) =>
    call<CommandResult>(service.transition, 'forms.transition', identity, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), to, ...(reason ? { reason } : {}) });
  const attention = async (id: string) =>
    (await sql(`select status from public.attention_requests where entity_id = $1 order by created_at`, [id])).map((r) => r.status);

  it('draft → open raises attention; close resolves it; reopen raises a new one', async () => {
    const id = (await createForm(human(ID2), { settings: { attentionPoints: 80 } })).entity!.id;
    await transition(id, 'open');
    expect(await sql(`select reason, points from public.attention_requests where entity_id = $1`, [id]))
      .toEqual([{ reason: 'Form: Pick the strategy', points: 80 }]);
    await transition(id, 'closed');
    expect(await attention(id)).toEqual(['resolved']);
    const reopened = await transition(id, 'open');
    expect((reopened.entity!.content as Row)['status']).toBe('open');
    expect((reopened.entity!.content as Row)['closedAt']).toBeNull();
    expect(await attention(id)).toEqual(['resolved', 'open']);
  });

  it('an illegal transition is 409 conflict (form_transition_invalid)', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    const e = await refusal(transition(id, 'closed'));
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ reason: 'form_transition_invalid', from: 'draft', to: 'closed' });
    await transition(id, 'cancelled');
    expect((await refusal(transition(id, 'open'))).code).toBe('conflict');
  });

  it('cancel posts a form_cancelled message to the requester and on the form', async () => {
    const id = await openForm(agent());
    await transition(id, 'cancelled', OWNER, 'no longer needed');
    const messages = await sql(`select anchor_id, body from public.messages where message_batch_id = $1 order by anchor_id`,
      [`form_cancelled:${id}`]);
    expect(messages.map((m) => m.anchor_id).sort()).toEqual([w.session, id].sort());
    expect(messages[0]!.body).toMatch(/^form_cancelled: Pick the strategy\nform: .*\nreason: no longer needed$/);
    expect(await attention(id)).toEqual(['resolved']);
  });
});

describe('forms.responses.save', () => {
  it('upserts the caller\'s draft with partial validation, and versions against the RESPONSE', async () => {
    const id = await openForm(human(ID1));
    const first = FormResponseViewSchema.parse(await save(id, human(ID2), { why: { text: 'because' } }));
    expect(first).toMatchObject({ status: 'draft', revision: 1, isCurrent: false, deliveries: [], respondentName: ID2 });
    const second = await save(id, human(ID2), { pick: { value: 'x' } }, { responseVersion: first.version });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version + 1);
    const stale = await refusal(save(id, human(ID2), {}, { responseVersion: first.version }));
    expect(stale.code).toBe('version_conflict');
  });

  it('refusals: invalid answers 422 (issues), not open 409, agents under humans 403', async () => {
    const id = await openForm(human(ID1));
    const bad = await refusal(save(id, human(ID2), { pick: { value: 'nope' } }));
    expect(bad.code).toBe('form_answers_invalid');
    expect((bad.details as Row)['issues']).toEqual([expect.objectContaining({ key: 'pick', code: 'not_an_option' })]);
    const agentSave = await refusal(save(id, agent(), { pick: { value: 'x' } }));
    expect(agentSave.code).toBe('form_respondent_not_allowed');
    const draftForm = (await createForm(human(ID1))).entity!.id;
    expect((await refusal(save(draftForm, human(ID2), {}))).code).toBe('form_not_open');
  });

  it('respondents: anyone admits a teammate', async () => {
    const id = await openForm(human(ID1), { settings: { respondents: 'anyone' } });
    const view = await save(id, agent(), { pick: { value: 'x' } });
    expect(view.respondentId).toBe(w.teammate);
    expect(view.respondentName).toBe('Agent');
  });

  it('unlimited: an amend draft in flight makes a new-chain save 409 conflict that NAMES the draft, never an overwrite', async () => {
    const id = await openForm(human(ID1), { settings: { responses: 'unlimited' } });
    const one = await submit(id, human(ID2), { pick: { value: 'x' } });
    const amend = await save(id, human(ID2), { pick: { value: 'y' } }, { amendOf: one.id });
    expect(amend.supersedesId).toBe(one.id);
    const e = await refusal(save(id, human(ID2), { pick: { value: 'x' } }));
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ reason: 'form_draft_in_flight', draftId: amend.id, supersedesId: one.id });
    expect((await sql(`select answers from public.form_responses where id = $1`, [amend.id]))[0]!.answers)
      .toEqual({ pick: { value: 'y' } });
  });
});

describe('forms.responses.submit', () => {
  it('one transaction: stored, snapshot frozen, message on [session, form], delivery pending, attention resolved, hook after commit', async () => {
    const id = await openForm(agent());
    submitted.length = 0;
    const view = FormResponseViewSchema.parse(await submit(id, human(ID2), { pick: { value: 'x' }, why: { text: 'cheap' } }));
    expect(view).toMatchObject({ status: 'submitted', revision: 1, isCurrent: true, supersedesId: null });
    expect(view.questionsSnapshot!.questions.map((q) => q.key)).toEqual(['pick', 'why']);
    expect(view.deliveries).toEqual([expect.objectContaining({ workSessionId: w.session, status: 'pending', attempts: 0 })]);

    const messages = await sql(`select m.entity_id, m.anchor_id, m.author_id, m.body from public.messages m
                                 where m.message_batch_id = $1`, [`form_response:${view.id}`]);
    expect(messages.map((m) => m.anchor_id).sort()).toEqual([w.session, id].sort());
    expect(new Set(messages.map((m) => m.author_id))).toEqual(new Set([w.m2]));
    expect(view.messageId).toBe(messages.find((m) => m.anchor_id === w.session)!.entity_id);
    expect(messages[0]!.body).toBe([
      'Form: Pick the strategy',
      '1. [pick] Pick one → x ("X") [recommended]',
      '2. [why] Why? → cheap',
    ].join('\n'));
    expect(await sql(`select status from public.attention_requests where entity_id = $1`, [id]))
      .toEqual([{ status: 'resolved' }]);
    expect(submitted).toEqual([{ formId: id, responseId: view.id, messageId: view.messageId, workSessionId: w.session }]);
  });

  it('is idempotent: the same clientMutationId returns the same response and posts nothing twice', async () => {
    const id = await openForm(agent());
    const body = { clientMutationId: cmid(), answers: { pick: { value: 'y' } } };
    const a = await call<FormResponseView>(service.responsesSubmit, 'forms.responses.submit', human(ID2), { formId: id }, body);
    const b = await call<FormResponseView>(service.responsesSubmit, 'forms.responses.submit', human(ID2), { formId: id }, body);
    expect(b.id).toBe(a.id);
    expect(await sql(`select 1 from public.messages where message_batch_id = $1`, [`form_response:${a.id}`])).toHaveLength(2);
    expect(await sql(`select 1 from public.form_deliveries where response_id = $1`, [a.id])).toHaveLength(1);
  });

  it('submits the saved draft when no answers are sent; required missing is 422', async () => {
    const id = await openForm(human(ID1));
    await save(id, human(ID2), { why: { text: 'only why' } });
    const e = await refusal(submit(id, human(ID2)));
    expect(e.code).toBe('form_answers_invalid');
    expect((e.details as Row)['issues']).toEqual([expect.objectContaining({ key: 'pick', code: 'required' })]);
    await save(id, human(ID2), { pick: { value: 'x' }, why: { text: 'only why' } });
    const view = await submit(id, human(ID2));
    expect(view.answers).toEqual({ pick: { value: 'x' }, why: { text: 'only why' } });
  });

  it('amend: revision 2 supersedes 1, the body leads with the changed answers, and it is re-delivered', async () => {
    const id = await openForm(agent());
    const one = await submit(id, human(ID2), { pick: { value: 'x' }, why: { text: 'a' } });
    const two = await submit(id, human(ID2), { pick: { value: 'y' }, why: { text: 'a' } });
    expect(two).toMatchObject({ revision: 2, supersedesId: one.id, isCurrent: true, lineageKey: one.lineageKey });
    expect((await call<FormResponseView>(service.responsesGet, 'forms.responses.get', human(ID2), { responseId: one.id })).isCurrent)
      .toBe(false);
    const body = (await sql(`select body from public.messages where entity_id = $1`, [two.messageId]))[0]!.body as string;
    expect(body.split('\n').slice(0, 3)).toEqual(['Form: Pick the strategy', 'Changed (1):', '1. [pick] Pick one → y ("Y")']);
    expect(two.deliveries).toHaveLength(1);
  });

  it('allowAmend false: a second submit is form_response_limit', async () => {
    const id = await openForm(human(ID1), { settings: { allowAmend: false } });
    await submit(id, human(ID2), { pick: { value: 'x' } });
    expect((await refusal(submit(id, human(ID2), { pick: { value: 'y' } }))).code).toBe('form_response_limit');
  });

  it('single: a second member gets form_response_limit; closeOnSubmit closes the form', async () => {
    const id = await openForm(human(ID1), { settings: { responses: 'single', closeOnSubmit: true } });
    await submit(id, human(ID2), { pick: { value: 'x' } });
    const content = (await detailFor(id, human(ID3))).content as Row;
    expect(content['status']).toBe('closed');
    expect((await refusal(submit(id, human(ID3), { pick: { value: 'x' } }))).code).toBe('form_not_open');

    const open = await openForm(human(ID1), { settings: { responses: 'single' } });
    await submit(open, human(ID2), { pick: { value: 'x' } });
    expect((await refusal(submit(open, human(ID3), { pick: { value: 'x' } }))).code).toBe('form_response_limit');
  });

  it('a form with no requesting session stores the response and posts on the form only, with no delivery row', async () => {
    const id = await openForm(human(ID1));
    const view = await submit(id, human(ID2), { pick: { value: 'x' } });
    expect(view.deliveries).toEqual([]);
    expect((await sql(`select anchor_id from public.messages where entity_id = $1`, [view.messageId]))[0]!.anchor_id).toBe(id);
  });

  it('a long body is cut at 10k with a fetch pointer naming the response', async () => {
    const id = await openForm(agent(), { questions: [
      { key: 'essay', type: 'long_text', title: 'Essay', config: { maxLength: 20000 } },
    ] });
    const view = await submit(id, human(ID2), { essay: { text: 'word '.repeat(3000) } });
    const body = (await sql(`select body from public.messages where entity_id = $1`, [view.messageId]))[0]!.body as string;
    expect([...body].length).toBeLessThanOrEqual(10000);
    expect(body.endsWith(`Full response: tm8 form response get ${view.id} --format json`)).toBe(true);
    expect(view.answers).toEqual({ essay: { text: 'word '.repeat(3000) } });
  });

  it('a structure edit between render and submit cannot slip through: the door checks the basis', async () => {
    const id = await openForm(human(ID1));
    // The door refuses a basis rendered for another structure_version.
    const e = await refusal(db.tx(claimsFor(owner, ctx('forms.responses.submit', human(ID2))), (q) =>
      q.rpc('submit_form_response', [id, JSON.stringify({ pick: { value: 'x' } }), null, null,
        JSON.stringify({ structureVersion: 999, supersedesId: null }), 'Form: x', false, null, cmid()])));
    expect(e.code).toBe('version_conflict');
    expect((e.details as Row)['reason']).toBe('form_structure_changed');
  });
});

describe('forms.responses.discard', () => {
  it('deletes the caller\'s draft; idempotent; version-guarded; never touches submitted rows', async () => {
    const id = await openForm(human(ID1), { settings: { responses: 'unlimited' } });
    const discard = (extra: Row = {}) => call<Row>(service.responsesDiscard, 'forms.responses.discard', human(ID2),
      { formId: id }, { clientMutationId: cmid(), ...extra });
    expect(await discard()).toEqual({ formId: id, discarded: false, responseId: null });
    const one = await submit(id, human(ID2), { pick: { value: 'x' } });
    const draft = await save(id, human(ID2), { pick: { value: 'y' } }, { amendOf: one.id });
    expect((await refusal(discard({ responseVersion: draft.version + 5 }))).code).toBe('version_conflict');
    expect(await discard({ responseVersion: draft.version })).toEqual({ formId: id, discarded: true, responseId: draft.id });
    // The dead end the op exists for is gone: a new chain can start.
    const fresh = await save(id, human(ID2), { pick: { value: 'x' } });
    expect(fresh.supersedesId).toBeNull();
    expect((await sql(`select status from public.form_responses where id = $1`, [one.id]))[0]!.status).toBe('submitted');
  });
});

describe('reads: forms.responses.list / get / mine, and draft privacy', () => {
  it('a member, the space owner and a teammate cannot read another member\'s draft through the HTTP ops', async () => {
    const id = await openForm(human(ID1), { settings: { respondents: 'anyone' } });
    const draft = await save(id, human(ID2), { pick: { value: 'x' } });
    for (const other of [human(ID3), OWNER, agent()]) {
      expect((await refusal(call(service.responsesGet, 'forms.responses.get', other, { responseId: draft.id }))).code)
        .toBe('not_found');
      expect((await list(id, other, { respondent: 'me' })).items.map((i) => i.id)).not.toContain(draft.id);
      expect((await list(id, other)).items.map((i) => i.id)).not.toContain(draft.id);
    }
    expect((await call<FormResponseView>(service.responsesGet, 'forms.responses.get', human(ID2), { responseId: draft.id })).id)
      .toBe(draft.id);
  });

  it('default = current submitted revisions newest first, keyset-paged; respondent=me = current + draft; lineageKey = history', async () => {
    const id = await openForm(human(ID1));
    const a1 = await submit(id, human(ID2), { pick: { value: 'x' } });
    const a2 = await submit(id, human(ID2), { pick: { value: 'y' } });
    const b1 = await submit(id, human(ID3), { pick: { value: 'x' } });
    const c = await submit(id, OWNER, { pick: { value: 'y' } });

    const first = FormResponsePageSchema.parse(await list(id, human(ID3), { limit: '2' }));
    expect(first.items.map((i) => i.id)).toEqual([c.id, b1.id]);
    const second = await list(id, human(ID3), { limit: '2', cursor: first.nextCursor! });
    expect(second.items.map((i) => i.id)).toEqual([a2.id]);
    expect(second.nextCursor).toBeNull();

    const draft = await save(id, human(ID2), { pick: { value: 'x' } });
    const mine = await list(id, human(ID2), { respondent: 'me' });
    expect(mine.items.map((i) => i.id).sort()).toEqual([a2.id, draft.id].sort());

    const history = await list(id, human(ID3), { lineageKey: a1.lineageKey });
    expect(history.items.map((i) => [i.revision, i.id])).toEqual([[1, a1.id], [2, a2.id]]);

    const wrong = await refusal(list(id, human(ID3), { limit: '2', cursor: (await list(id, human(ID3), { lineageKey: a1.lineageKey, limit: '1' })).nextCursor! }));
    expect(wrong.code).toBe('invalid_cursor');
    expect((await refusal(list(id, human(ID3), { respondent: 'them' }))).code).toBe('invalid_input');
    expect((await refusal(list(randomUUID(), human(ID3)))).code).toBe('not_found');
  });

  it('mine: every submitted revision of the caller across the space, newest first; spaceId required', async () => {
    const f1 = await openForm(human(ID1));
    const f2 = await openForm(human(ID1));
    const r1 = await submit(f1, human(ID3), { pick: { value: 'x' } });
    const r2 = await submit(f2, human(ID3), { pick: { value: 'y' } });
    const r3 = await submit(f1, human(ID3), { pick: { value: 'y' } });
    const page = FormResponsePageSchema.parse(await call(service.responsesMine, 'forms.responses.mine', human(ID3),
      {}, undefined, { spaceId: w.space, limit: '3' }));
    expect(page.items.map((i) => i.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(page.items.every((i) => i.respondentId === w.m3)).toBe(true);
    expect((await refusal(call(service.responsesMine, 'forms.responses.mine', human(ID3)))).code).toBe('invalid_input');
  });
});

describe('entity-context: a form reads as a form', () => {
  it('title, state and content from the universal reads', async () => {
    const id = await openForm(agent(), { description: 'Help me choose' });
    const detail = await detailFor(id, human(ID2));
    expect(detail.title).toBe('Pick the strategy');
    expect(detail.excerpt).toBe('Help me choose');
    expect(detail.state).toEqual({ kind: 'form', status: 'open', questionCount: 2 });
    expect(detail.content).toMatchObject({ kind: 'form', status: 'open', description: 'Help me choose', structureVersion: 1 });
  });
});

describe('actions.list: forms.* cases follow the form status', () => {
  async function actions(id: string, identity: RequestIdentity): Promise<string[]> {
    const registry = new HandlerRegistry();
    const deps: FacadeDeps = { db, config: {} as FacadeDeps['config'], owner: async () => owner };
    registerW2FormHandlers(registry, deps);
    const discovery = createSavedViewsActionsService(deps, registry);
    const rows = await discovery.listActions(ctx('actions.list', identity, {}, undefined, { contextEntityId: id }));
    return (rows as { actions: Array<{ operation: string }> }).actions.map((r) => r.operation).filter((o) => o.startsWith('forms.'));
  }
  const EDIT = ['forms.questions.add', 'forms.questions.move', 'forms.questions.remove', 'forms.questions.update',
    'forms.transition', 'forms.update'];

  it('draft: the author edits and opens; a non-author member sees no edit verbs and cannot respond yet', async () => {
    const id = (await createForm(human(ID2))).entity!.id;
    const author = await actions(id, human(ID2));
    expect(author).toEqual(expect.arrayContaining(EDIT));
    expect(author).not.toContain('forms.responses.submit');
    expect(author[0]).toBe('forms.transition'); // most relevant first on a draft
    const other = await actions(id, human(ID3));
    for (const op of EDIT) expect(other).not.toContain(op);
  });

  it('open: members discover submit/save; an agent under humans does not; frozen hides question verbs; a draft adds discard', async () => {
    const id = await openForm(human(ID1));
    const member = await actions(id, human(ID3));
    expect(member.slice(0, 2)).toEqual(['forms.responses.submit', 'forms.responses.save']);
    expect(member).not.toContain('forms.responses.discard');
    expect(await actions(id, agent())).not.toContain('forms.responses.submit');
    await save(id, human(ID3), { pick: { value: 'x' } });
    expect(await actions(id, human(ID3))).toContain('forms.responses.discard');
    await submit(id, human(ID2), { pick: { value: 'x' } });
    const admin = await actions(id, OWNER);
    expect(admin).toContain('forms.transition');
    expect(admin).toContain('forms.update');
    expect(admin).not.toContain('forms.questions.add');
  });

  it('closed: reopen via transition, no submit; cancelled: nothing but reads', async () => {
    const id = await openForm(human(ID1));
    await call(service.transition, 'forms.transition', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), to: 'closed' });
    const closed = await actions(id, OWNER);
    expect(closed).toContain('forms.transition');
    expect(closed).not.toContain('forms.responses.submit');
    await call(service.transition, 'forms.transition', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), to: 'open' });
    await call(service.transition, 'forms.transition', OWNER, { formId: id },
      { clientMutationId: cmid(), expectedVersion: await version(id), to: 'cancelled' });
    expect(await actions(id, OWNER)).toEqual(['forms.responses.list']);
  });
});
