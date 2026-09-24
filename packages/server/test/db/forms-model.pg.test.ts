/**
 * Migration 209 — the Forms W0 data model, exercised in the database itself.
 *
 * What is pinned here, and why each matters:
 *   - the kind row, the widened edges and the `entity_content` arm (a missing
 *     arm is the silent `{}` failure 011/091 describe);
 *   - question/section/settings constraints: the database is the authority
 *     (T-L4), the contract only mirrors it;
 *   - the amend model (W0 advisor ruling): revision chains, exactly one
 *     current row per lineage, the response limit per mode as ONE unique
 *     index, one draft per member, fork protection under real concurrency,
 *     immutability of submitted rows, and ONE freeze point for questions and
 *     the responses mode;
 *   - every refusal leaves with its own SQLSTATE, so the server maps it to
 *     the closed taxonomy without reading a message — and a raw 23505 never
 *     escapes the cores;
 *   - RLS: space-visible reads (decision 10), no direct writes for tm8_app.
 *
 * The per-type validator arms are covered case by case in
 * forms-parity.pg.test.ts, against the same fixture the contract runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let db: W1ScratchDatabase;

interface World {
  spaceA: string;
  spaceB: string;
  identity1: string;
  identity2: string;
  identity3: string;
  m1: string;
  m2: string;
  teammate: string;
  mB: string;
}
let w: World;

type Row = Record<string, any>;

/** Run as the schema owner (how W1's SECURITY DEFINER doors will run). */
async function owner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return db.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    return fn(c);
  });
}

async function sql(text: string, params: unknown[] = []): Promise<Row[]> {
  return owner(async (c) => (await c.query(text, params)).rows);
}

/** Assert a statement fails with this SQLSTATE (and constraint, when given). */
async function refused(p: Promise<unknown>, code: string, constraint?: string): Promise<any> {
  const error = await p.then(() => null, (e: unknown) => e as any);
  expect(error, `expected SQLSTATE ${code}`).not.toBeNull();
  expect(error.code, error.message).toBe(code);
  if (constraint) expect(error.constraint).toBe(constraint);
  return error;
}

async function seed(): Promise<World> {
  return owner(async (c) => {
    const ids = (await c.query(`select internal.new_id()::text a, internal.new_id()::text b,
      internal.new_id()::text c, internal.new_id()::text d, internal.new_id()::text e,
      internal.new_id()::text f, internal.new_id()::text g`)).rows[0]!;
    const x: World = {
      spaceA: ids.a, spaceB: ids.b, m1: ids.c, m2: ids.d, teammate: ids.e, mB: ids.f,
      identity1: 'forms-id-1', identity2: 'forms-id-2', identity3: 'forms-id-3',
    };
    for (const id of [x.identity1, x.identity2, x.identity3]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [id]);
    }
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Forms A', $2), ($3, 'Forms B', $4)`,
      [x.spaceA, x.identity1, x.spaceB, x.identity3]);
    const member = async (id: string, space: string, identity: string, role: string) => {
      await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                     values ($1, $2, 'member', null, 0, $1)`, [id, space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, $4, $3)`, [id, space, identity, role]);
    };
    await member(x.m1, x.spaceA, x.identity1, 'owner');
    await member(x.m2, x.spaceA, x.identity2, 'member');
    await member(x.mB, x.spaceB, x.identity3, 'owner');
    await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                   values ($1, $2, 'team_member', null, 0, $3)`, [x.teammate, x.spaceA, x.m1]);
    return x;
  });
}

const OPTIONS = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }];

/** A form with two questions (one required choice, one optional text). */
async function mintForm(opts: { settings?: Row; status?: string; space?: string; by?: string } = {}): Promise<string> {
  return owner(async (c) => {
    const id = (await c.query(`select internal.new_id()::text id`)).rows[0]!.id as string;
    await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                   values ($1, $2, 'form', null, 0, $3)`, [id, opts.space ?? w.spaceA, opts.by ?? w.m1]);
    await c.query(`insert into public.forms(entity_id, title, status, settings) values ($1, 'Pick', $2, $3::jsonb)`,
      [id, opts.status ?? 'open', JSON.stringify(opts.settings ?? {})]);
    await c.query(`insert into public.form_questions(form_id, key, position, type, title, required, config) values
      ($1, 'pick', 0, 'single_choice', 'Pick one', true, $2::jsonb),
      ($1, 'why', 1, 'short_text', 'Why?', false, '{"maxLength": 20}'::jsonb)`,
      [id, JSON.stringify({ options: OPTIONS })]);
    return id;
  });
}

const PICK_X = { pick: { value: 'x' } };
const PICK_Y = { pick: { value: 'y' } };

async function submit(form: string, who: string, answers: Row | null = PICK_X, amendOf: string | null = null): Promise<Row> {
  return (await sql(`select * from internal.form_submit($1, $2, $3::jsonb, $4)`,
    [form, who, answers === null ? null : JSON.stringify(answers), amendOf]))[0]!;
}

async function saveDraft(form: string, who: string, answers: Row, amendOf: string | null = null): Promise<Row> {
  return (await sql(`select * from internal.form_save_draft($1, $2, $3::jsonb, $4)`,
    [form, who, JSON.stringify(answers), amendOf]))[0]!;
}

async function responses(form: string): Promise<Row[]> {
  return sql(`select id::text, respondent_id::text, status, revision, supersedes_id::text, lineage_key::text,
                     is_current, answers, version from public.form_responses where form_id = $1
               order by created_at, revision`, [form]);
}

beforeAll(async () => {
  db = await createW1ScratchDatabase('forms_model');
  db.apply(migrationFiles());
  w = await seed();
});

afterAll(async () => {
  await db?.destroy();
});

describe('the form kind', () => {
  it('is a core kind with the clipboard-list icon', async () => {
    const [row] = await sql(`select origin, icon from public.entity_kinds where kind = 'form' and space_id is null`);
    expect(row).toEqual({ origin: 'core', icon: 'clipboard-list' });
  });

  it('may be the source of authored_from (requesting session) and attached_to (task)', async () => {
    const rows = await sql(`select type from public.edge_types
                             where type in ('authored_from', 'attached_to') and 'form' = any(src_kinds) order by type`);
    expect(rows.map((r) => r.type)).toEqual(['attached_to', 'authored_from']);
  });

  it('hydrates through entity_content with sections and questions in order', async () => {
    const form = await mintForm({ settings: { responses: 'single' } });
    await sql(`insert into public.form_sections(form_id, key, position, title) values ($1, 'main', 0, 'Main')`, [form]);
    await sql(`update public.form_questions set section = 'main' where form_id = $1 and key = 'why'`, [form]);
    const [{ content }] = await sql(`select internal.entity_content($1) content`, [form]);
    expect(content).toMatchObject({
      title: 'Pick', status: 'open', settings: { responses: 'single' }, structure_version: 1,
      sections: [{ key: 'main', title: 'Main', position: 0 }],
      questions: [
        { key: 'pick', type: 'single_choice', required: true, position: 0, config: { options: OPTIONS } },
        { key: 'why', type: 'short_text', required: false, section: 'main', position: 1 },
      ],
    });
  });
});

describe('structure constraints', () => {
  it('refuses a question type with no SQL arm, and an invalid config, as invalid input', async () => {
    const form = await mintForm();
    await refused(sql(`insert into public.form_questions(form_id, key, position, type, title)
                       values ($1, 'q', 5, 'yes_no', 'Q')`, [form]), '22023');
    const e = await refused(sql(`insert into public.form_questions(form_id, key, position, type, title, config)
                                 values ($1, 'q', 5, 'scale', 'Q', '{"max": 11}')`, [form]), '22023');
    expect(JSON.parse(e.detail)).toMatchObject({ reason: 'invalid_config', key: 'q' });
  });

  it('refuses a bad key, a duplicate position and a dangling section', async () => {
    const form = await mintForm();
    await refused(sql(`insert into public.form_questions(form_id, key, position, type, title)
                       values ($1, 'Bad', 5, 'short_text', 'Q')`, [form]), '23514');
    await refused(sql(`insert into public.form_questions(form_id, key, position, type, title)
                       values ($1, 'dup', 0, 'short_text', 'Q')`, [form]), '23505', 'form_questions_position_unique');
    await refused(sql(`insert into public.form_questions(form_id, key, position, type, title, section)
                       values ($1, 'q', 5, 'short_text', 'Q', 'nope')`, [form]), '23503', 'form_questions_section_fk');
  });

  it('a deferred position constraint lets a move swap two questions in one transaction', async () => {
    const form = await mintForm();
    await owner(async (c) => {
      await c.query('set constraints public.form_questions_position_unique deferred');
      await c.query(`update public.form_questions set position = 1 where form_id = $1 and key = 'pick'`, [form]);
      await c.query(`update public.form_questions set position = 0 where form_id = $1 and key = 'why'`, [form]);
    });
    const rows = await sql(`select key from public.form_questions where form_id = $1 order by position`, [form]);
    expect(rows.map((r) => r.key)).toEqual(['why', 'pick']);
  });

  it('deleting a section un-sections its questions', async () => {
    const form = await mintForm();
    await sql(`insert into public.form_sections(form_id, key, position, title) values ($1, 's', 0, 'S')`, [form]);
    await sql(`update public.form_questions set section = 's' where form_id = $1`, [form]);
    await sql(`delete from public.form_sections where form_id = $1`, [form]);
    const rows = await sql(`select section from public.form_questions where form_id = $1`, [form]);
    expect(rows.every((r) => r.section === null)).toBe(true);
  });

  it('validates settings (§3.3)', async () => {
    const form = await mintForm();
    await refused(sql(`update public.forms set settings = '{"responses": "many"}' where entity_id = $1`, [form]), '22023');
    await refused(sql(`update public.forms set settings = '{"expiresAt": "x"}' where entity_id = $1`, [form]), '22023');
    await refused(sql(`update public.forms set settings = '{"delivery": {"target": "x"}}' where entity_id = $1`, [form]), '22023');
    await refused(sql(`update public.forms set settings = '{"attentionPoints": 101}' where entity_id = $1`, [form]), '22023');
    await sql(`update public.forms set settings = '{"delivery": {"onSessionNotLive": "queue"}, "attentionPoints": 5}'
               where entity_id = $1`, [form]);
    const [{ eff }] = await sql(`select internal.form_settings_effective(settings) eff from public.forms where entity_id = $1`, [form]);
    expect(eff).toEqual({
      responses: 'per_member', respondents: 'humans', closeOnSubmit: false, allowAmend: true,
      delivery: { target: 'requesting_session', onSessionNotLive: 'queue' }, attentionPoints: 5,
    });
  });
});

describe('submit and save: status, respondents, answers', () => {
  it('refuses a form that is not open (TFN01)', async () => {
    const form = await mintForm({ status: 'draft' });
    await refused(submit(form, w.m1), 'TFN01');
    await refused(saveDraft(form, w.m1, PICK_X), 'TFN01');
  });

  it('refuses teammates unless respondents = anyone, and outsiders always (TFR01)', async () => {
    const humans = await mintForm();
    await refused(submit(humans, w.teammate), 'TFR01');
    await refused(submit(humans, w.mB), 'TFR01');
    const anyone = await mintForm({ settings: { respondents: 'anyone' } });
    expect((await submit(anyone, w.teammate)).status).toBe('submitted');
  });

  it('refuses invalid answers with TFA01 and the issue list in DETAIL', async () => {
    const form = await mintForm();
    const e = await refused(submit(form, w.m1, { pick: { value: 'z' }, why: { text: 'x'.repeat(21) } }), 'TFA01');
    expect(JSON.parse(e.detail)).toEqual({
      reason: 'form_answers_invalid',
      issues: [
        { key: 'pick', code: 'not_an_option', message: expect.any(String) },
        { key: 'why', code: 'too_long', message: expect.any(String) },
      ],
    });
    await refused(submit(form, w.m1, {}), 'TFA01');
  });

  it('a draft validates partially, bumps its version, and is what submit sends', async () => {
    const form = await mintForm();
    const first = await saveDraft(form, w.m1, { why: { text: 'because' } });
    expect(first).toMatchObject({ status: 'draft', is_current: false, revision: 1, version: 1 });
    await refused(saveDraft(form, w.m1, { why: { text: 'x'.repeat(21) } }), 'TFA01');
    const second = await saveDraft(form, w.m1, { pick: { value: 'y' }, why: { text: 'because' } });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);

    const submitted = await submit(form, w.m1, null);
    expect(submitted).toMatchObject({ id: first.id, status: 'submitted', is_current: true, answers: { pick: { value: 'y' }, why: { text: 'because' } } });
    expect(submitted.questions_snapshot.questions.map((q: Row) => q.key)).toEqual(['pick', 'why']);
    expect(submitted.submitted_at).not.toBeNull();
  });
});

describe('the amend model', () => {
  it('per_member: a revision chain 1 -> 2 -> 3, with exactly one current row', async () => {
    const form = await mintForm();
    const r1 = await submit(form, w.m1, PICK_X);
    const r2 = await submit(form, w.m1, PICK_Y);
    const r3 = await submit(form, w.m1, PICK_X);
    const rows = await responses(form);
    expect(rows.map((r) => [r.revision, r.supersedes_id, r.is_current])).toEqual([
      [1, null, false], [2, r1.id, false], [3, r2.id, true],
    ]);
    expect(new Set(rows.map((r) => r.lineage_key))).toEqual(new Set([w.m1]));
    expect(r3.id).toBe(rows[2]!.id);

    // Another member is another slot: two current rows, one per member.
    await submit(form, w.m2, PICK_Y);
    const current = await sql(`select respondent_id::text from public.form_responses where form_id = $1 and is_current
                               order by respondent_id`, [form]);
    expect(current.map((r) => r.respondent_id).sort()).toEqual([w.m1, w.m2].sort());
  });

  it('an amend goes through a draft that supersedes the current revision', async () => {
    const form = await mintForm();
    const r1 = await submit(form, w.m1, PICK_X);
    const draft = await saveDraft(form, w.m1, PICK_Y);
    expect(draft).toMatchObject({ status: 'draft', revision: 2, supersedes_id: r1.id, is_current: false });
    // Revision 1 stays current until the amend is submitted.
    expect((await responses(form)).find((r) => r.id === r1.id)!.is_current).toBe(true);
    const r2 = await submit(form, w.m1, null);
    expect(r2).toMatchObject({ id: draft.id, revision: 2, is_current: true });
    expect((await responses(form)).filter((r) => r.is_current)).toHaveLength(1);
  });

  it('allowAmend = false refuses the amend at save and at submit (TFL01)', async () => {
    const form = await mintForm({ settings: { allowAmend: false } });
    await submit(form, w.m1);
    await refused(saveDraft(form, w.m1, PICK_Y), 'TFL01');
    await refused(submit(form, w.m1, PICK_Y), 'TFL01');
  });

  it('single: one current response on the whole form; its respondent may amend', async () => {
    const form = await mintForm({ settings: { responses: 'single' } });
    // Members draft in parallel and race; the loser gets the limit.
    await saveDraft(form, w.m1, PICK_X);
    await saveDraft(form, w.m2, PICK_Y);
    const r1 = await submit(form, w.m1, null);
    expect(r1.lineage_key).toBe(form);
    await refused(submit(form, w.m2, null), 'TFL01');
    await refused(saveDraft(form, w.m2, PICK_Y), 'TFL01');
    const r2 = await submit(form, w.m1, PICK_Y);
    expect(r2).toMatchObject({ revision: 2, supersedes_id: r1.id });
  });

  it('unlimited: independent chains, each with its own current row; amend names its chain', async () => {
    const form = await mintForm({ settings: { responses: 'unlimited' } });
    const a1 = await submit(form, w.m1, PICK_X);
    const b1 = await submit(form, w.m1, PICK_Y);
    expect(a1.lineage_key).toBe(a1.id);
    expect(b1.lineage_key).toBe(b1.id);
    const a2 = await submit(form, w.m1, PICK_Y, a1.id);
    expect(a2).toMatchObject({ revision: 2, supersedes_id: a1.id, lineage_key: a1.id });
    expect((await responses(form)).filter((r) => r.is_current).map((r) => r.id).sort()).toEqual([a2.id, b1.id].sort());
    // Amending a superseded revision is a version conflict.
    await refused(submit(form, w.m1, PICK_X, a1.id), '40001');
    // Someone else's response is not yours to amend.
    await refused(submit(form, w.m2, PICK_X, b1.id), 'TFR01');
  });

  it('one draft per member: under unlimited an amend draft blocks a new chain (TFD01)', async () => {
    const form = await mintForm({ settings: { responses: 'unlimited' } });
    const a1 = await submit(form, w.m1, PICK_X);
    const draft = await saveDraft(form, w.m1, PICK_Y, a1.id);
    const e = await refused(saveDraft(form, w.m1, PICK_X), 'TFD01');
    expect(JSON.parse(e.detail)).toMatchObject({ reason: 'form_draft_in_flight', draftId: draft.id, supersedesId: a1.id });
    // The in-flight draft was not overwritten.
    expect((await responses(form)).find((r) => r.id === draft.id)!.answers).toEqual(PICK_Y);
    // And the index itself holds for a writer that bypasses the cores.
    await refused(sql(`insert into public.form_responses(form_id, respondent_id, status) values ($1, $2, 'draft')`,
      [form, w.m1]), '23505', 'form_responses_one_draft_per_member');
  });

  it('the one_current index is the limit, and the cores never leak its 23505', async () => {
    const form = await mintForm();
    await submit(form, w.m1);
    const snapshot = JSON.stringify({ questions: [] });
    await refused(sql(`insert into public.form_responses(form_id, respondent_id, status, is_current, submitted_at, questions_snapshot)
                       values ($1, $2, 'submitted', true, now(), $3::jsonb)`, [form, w.m1, snapshot]),
    '23505', 'form_responses_one_current');
  });

  it('two concurrent amends of revision N: exactly one wins, the other is a version conflict', async () => {
    const form = await mintForm({ settings: { responses: 'unlimited' } });
    const n = await submit(form, w.m1, PICK_X);
    const a = await db.pool.connect();
    const b = await db.pool.connect();
    try {
      await a.query('begin; set local role tm8_graph_owner');
      await b.query('begin; set local role tm8_graph_owner');
      const call = `select id::text from internal.form_submit($1, $2, $3::jsonb, $4)`;
      const first = await a.query(call, [form, w.m1, JSON.stringify(PICK_Y), n.id]);
      // B waits on the form-row lock A holds…
      const second = b.query(call, [form, w.m1, JSON.stringify(PICK_Y), n.id]).then(() => null, (e: any) => e);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('commit');
      // …and then finds revision N no longer current.
      const error = await second;
      expect(error?.code).toBe('40001');
      await b.query('rollback');
      expect(first.rows[0]!.id).toBeDefined();
    } finally {
      a.release();
      b.release();
    }
    const rows = await responses(form);
    expect(rows.filter((r) => r.supersedes_id === n.id)).toHaveLength(1);
    expect(rows.filter((r) => r.is_current)).toHaveLength(1);
  });

  it('a revision is superseded at most once, even by a writer that bypasses the cores', async () => {
    const form = await mintForm();
    const n = await submit(form, w.m1);
    const insert = `insert into public.form_responses(form_id, respondent_id, status, is_current, submitted_at,
                      questions_snapshot, supersedes_id) values ($1, $2, 'submitted', false, now(), '{}'::jsonb, $3)`;
    await sql(insert, [form, w.m1, n.id]);
    await refused(sql(insert, [form, w.m1, n.id]), '23505', 'form_responses_one_successor');
  });

  it('the chain is derived: revision, lineage and respondent come from the superseded row', async () => {
    const form = await mintForm();
    const n = await submit(form, w.m1);
    const [row] = await sql(`insert into public.form_responses(form_id, respondent_id, status, supersedes_id, revision, lineage_key)
                             values ($1, $2, 'draft', $3, 7, internal.new_id()) returning revision, lineage_key::text`,
    [form, w.m1, n.id]);
    expect(row).toEqual({ revision: 2, lineage_key: w.m1 });
    await sql(`delete from public.form_responses where form_id = $1 and status = 'draft'`, [form]);
    await refused(sql(`insert into public.form_responses(form_id, respondent_id, status, supersedes_id)
                       values ($1, $2, 'draft', $3)`, [form, w.m2, n.id]), '23514');
  });

  it('submit re-derives a first-revision draft\'s stale lineage_key under the form lock (M1)', async () => {
    // The race: a draft saved while a responses-mode change commits keeps the
    // OLD mode's key, and the re-key trigger never saw the uncommitted row.
    // Reproduced deterministically by writing the stale key behind the
    // trigger's back, as the table owner.
    const form = await mintForm({ settings: { responses: 'single' } });
    const draft = await saveDraft(form, w.m1, PICK_X);
    expect(draft.lineage_key).toBe(form);
    await owner(async (c) => {
      await c.query('alter table public.form_responses disable trigger form_responses_before_update');
      await c.query(`update public.form_responses set lineage_key = respondent_id where id = $1`, [draft.id]);
      await c.query('alter table public.form_responses enable trigger form_responses_before_update');
    });
    const submitted = await submit(form, w.m1, null);
    expect(submitted).toMatchObject({ id: draft.id, lineage_key: form, is_current: true });
    // …so the limit enforces the CURRENT mode: a second member is refused.
    await refused(submit(form, w.m2, PICK_Y), 'TFL01');
  });

  it('two first saves racing on one member land in the same draft (S2)', async () => {
    const form = await mintForm();
    const a = await db.pool.connect();
    const b = await db.pool.connect();
    try {
      await a.query('begin; set local role tm8_graph_owner');
      await b.query('begin; set local role tm8_graph_owner');
      const call = `select id::text, version from internal.form_save_draft($1, $2, $3::jsonb, null)`;
      const first = await a.query(call, [form, w.m1, JSON.stringify(PICK_X)]);
      // B's insert waits on A's uncommitted draft in the unique index…
      const second = b.query(call, [form, w.m1, JSON.stringify(PICK_Y)]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await a.query('commit');
      // …then saves INTO it instead of refusing.
      const secondRows = await second;
      await b.query('commit');
      expect(secondRows.rows[0]!.id).toBe(first.rows[0]!.id);
    } finally {
      a.release();
      b.release();
    }
    const rows = await responses(form);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'draft', answers: PICK_Y, version: 2 });
  });

  it('drafts are never current', async () => {
    const form = await mintForm();
    await refused(sql(`insert into public.form_responses(form_id, respondent_id, status, is_current)
                       values ($1, $2, 'draft', true)`, [form, w.m1]), '23514', 'form_responses_current_is_submitted');
  });
});

describe('submitted responses are immutable history', () => {
  it('refuses edits to a submitted row except is_current true -> false and message_id', async () => {
    const form = await mintForm();
    const r = await submit(form, w.m1);
    await refused(sql(`update public.form_responses set answers = '{}' where id = $1`, [r.id]), '23514');
    await refused(sql(`update public.form_responses set status = 'draft', submitted_at = null, questions_snapshot = null
                       where id = $1`, [r.id]), '23514');
    await refused(sql(`update public.form_responses set lineage_key = internal.new_id() where id = $1`, [r.id]), '23514');
    await refused(sql(`update public.form_responses set respondent_id = $2 where id = $1`, [r.id, w.m2]), '23514');
    await refused(sql(`delete from public.form_responses where id = $1`, [r.id]), '23514');
    await sql(`update public.form_responses set is_current = false where id = $1`, [r.id]);
    await refused(sql(`update public.form_responses set is_current = true where id = $1`, [r.id]), '23514');
  });

  it('a draft can be discarded; a whole form takes its history with it', async () => {
    const form = await mintForm();
    await submit(form, w.m1);
    const d = await saveDraft(form, w.m1, PICK_Y);
    await sql(`delete from public.form_responses where id = $1`, [d.id]);
    await sql(`delete from public.entities where id = $1`, [form]);
    expect(await sql(`select 1 from public.form_responses where form_id = $1`, [form])).toHaveLength(0);
  });
});

describe('one freeze point: the first SUBMITTED response (decision 7)', () => {
  it('drafts do not freeze; a mode change re-keys the drafts', async () => {
    const form = await mintForm();
    const d1 = await saveDraft(form, w.m1, PICK_X);
    const d2 = await saveDraft(form, w.m2, PICK_Y);
    expect(d1.lineage_key).toBe(w.m1);
    await sql(`insert into public.form_questions(form_id, key, position, type, title) values ($1, 'more', 2, 'long_text', 'More')`, [form]);
    await sql(`update public.form_questions set title = 'Pick exactly one' where form_id = $1 and key = 'pick'`, [form]);

    await sql(`update public.forms set settings = '{"responses": "unlimited"}' where entity_id = $1`, [form]);
    let rows = await responses(form);
    expect(rows.find((r) => r.id === d1.id)!.lineage_key).toBe(d1.id);
    expect(rows.find((r) => r.id === d2.id)!.lineage_key).toBe(d2.id);

    await sql(`update public.forms set settings = '{"responses": "single"}' where entity_id = $1`, [form]);
    rows = await responses(form);
    expect(rows.every((r) => r.lineage_key === form)).toBe(true);
  });

  it('after the first submit, questions and the responses mode refuse with TFS01', async () => {
    const form = await mintForm();
    await submit(form, w.m1);
    await refused(sql(`insert into public.form_questions(form_id, key, position, type, title)
                       values ($1, 'more', 2, 'long_text', 'More')`, [form]), 'TFS01');
    await refused(sql(`update public.form_questions set title = 'Changed' where form_id = $1 and key = 'pick'`, [form]), 'TFS01');
    await refused(sql(`delete from public.form_questions where form_id = $1 and key = 'why'`, [form]), 'TFS01');
    await refused(sql(`update public.forms set settings = '{"responses": "unlimited"}' where entity_id = $1`, [form]), 'TFS01');
    // Other settings stay editable.
    await sql(`update public.forms set settings = '{"attentionPoints": 90}' where entity_id = $1`, [form]);
  });
});

describe('RLS: space-visible reads, no direct writes (decision 10)', () => {
  async function asIdentity<T>(identity: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return db.transaction(async (c) => {
      await c.query('set local role tm8_app');
      await c.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                            set_config('tm8.node_admin', 'false', true)`, [identity]);
      return fn(c);
    });
  }

  it('a member of the space reads the form, its questions, responses and deliveries; an outsider reads none', async () => {
    const form = await mintForm();
    const r = await submit(form, w.m1);
    const session = (await sql(`select internal.new_id()::text id`))[0]!.id as string;
    await sql(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
               values ($1, $2, 'work_session', null, 0, $3)`, [session, w.spaceA, w.m1]);
    await sql(`insert into public.form_deliveries(response_id, work_session_id) values ($1, $2)`, [r.id, session]);

    const counts = (c: PoolClient) => c.query(`select
        (select count(*) from public.forms where entity_id = $1)::int forms,
        (select count(*) from public.form_questions where form_id = $1)::int questions,
        (select count(*) from public.form_responses where form_id = $1)::int responses,
        (select count(*) from public.form_deliveries where response_id = $2)::int deliveries`, [form, r.id]);

    // Member 2 did not respond, and still sees the response: space-visible.
    expect((await asIdentity(w.identity2, counts)).rows[0]).toEqual({ forms: 1, questions: 2, responses: 1, deliveries: 1 });
    expect((await asIdentity(w.identity3, counts)).rows[0]).toEqual({ forms: 0, questions: 0, responses: 0, deliveries: 0 });
  });

  it('a draft is private to its respondent; the submitted revision is space-visible (M2)', async () => {
    const form = await mintForm();
    const r1 = await submit(form, w.m1, PICK_X);
    const draft = await saveDraft(form, w.m1, PICK_Y);
    const session = (await sql(`select internal.new_id()::text id`))[0]!.id as string;
    await sql(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
               values ($1, $2, 'work_session', null, 0, $3)`, [session, w.spaceA, w.m1]);
    // A delivery row on a draft cannot happen in the product; it pins that the
    // deliveries policy carries the same restriction through its join.
    await sql(`insert into public.form_deliveries(response_id, work_session_id) values ($1, $3), ($2, $3)`,
      [r1.id, draft.id, session]);

    const seen = (c: PoolClient) => c.query(`select
        array(select id::text from public.form_responses where form_id = $1 order by revision) responses,
        array(select response_id::text from public.form_deliveries where work_session_id = $2
               order by response_id) deliveries`, [form, session]);

    const byOther = (await asIdentity(w.identity2, seen)).rows[0]!;
    expect(byOther.responses).toEqual([r1.id]);
    expect(byOther.deliveries).toEqual([r1.id]);

    const byRespondent = (await asIdentity(w.identity1, seen)).rows[0]!;
    expect(byRespondent.responses).toEqual([r1.id, draft.id]);
    expect([...byRespondent.deliveries].sort()).toEqual([r1.id, draft.id].sort());

    // An agent reading as the teammate it acts for sees only its own drafts.
    const byActor = (await db.transaction(async (c) => {
      await c.query('set local role tm8_app');
      await c.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', $2, true),
                            set_config('tm8.node_admin', 'false', true)`, [w.identity2, w.teammate]);
      return seen(c);
    })).rows[0]!;
    expect(byActor.responses).toEqual([r1.id]);
  });

  it('tm8_app cannot write any form table directly', async () => {
    const form = await mintForm();
    for (const stmt of [
      `update public.forms set title = 'x' where entity_id = '${form}'`,
      `insert into public.form_questions(form_id, key, position, type, title) values ('${form}', 'q', 9, 'short_text', 'Q')`,
      `insert into public.form_responses(form_id, respondent_id) values ('${form}', '${w.m1}')`,
      `delete from public.form_deliveries`,
    ]) {
      await refused(asIdentity(w.identity1, (c) => c.query(stmt)), '42501');
    }
  });
});

describe('form_deliveries (the W2 outbox)', () => {
  it('only a spawned delivery names a spawned session', async () => {
    const form = await mintForm();
    const r = await submit(form, w.m1);
    await refused(sql(`insert into public.form_deliveries(response_id, work_session_id, status, spawned_session_id)
                       values ($1, $2, 'pending', $2)`, [r.id, w.m1]), '23514', 'form_deliveries_spawned');
  });
});
