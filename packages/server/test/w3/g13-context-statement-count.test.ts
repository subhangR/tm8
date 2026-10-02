import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UNTAGGED, countStatements, type StatementCounter } from '../w2/context-statement-counter.js';
import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * M2/S2 — statements per `entities.context` read, against the production
 * composition root and a real PostgreSQL chain (c761 §10 test 8, c904 §5 test 8).
 *
 * The unit suite proves WHICH loaders run; this one records HOW MANY
 * statements a read costs on real data, by section tag, for the fixtures the
 * step reports on: a simple task, a task with 10 children of ~4 KB and a
 * message, and a running session with a `working_on` edge. The counts are
 * logged so the step's before/after table comes from a run, not an estimate.
 *
 * Statements outside the context handler (the request's identity resolution)
 * are untagged, so they are reported apart from the per-section counts.
 */
describe.sequential('W3.G13 entities.context statements per read (M2/S2)', () => {
  let harness: W3PublicServer;
  let counter: StatementCounter;
  const ids = { space: '', task: '', parent: '', session: '' };

  beforeAll(async () => {
    harness = await startW3PublicServer('g13stmt');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g13stmt-space',
        name: 'W3 G13 statement count Space',
      }),
    );
    ids.space = space.space.id;

    const task = async (
      key: string, title: string, description?: string, parentId?: string,
    ) =>
      successData<{ entity: { id: string } }>(
        await harness.request('POST', '/v2/entities', {
          clientMutationId: `w3-g13stmt-${key}`,
          spaceId: ids.space,
          kind: 'task',
          title,
          content: { priority: 'medium', ...(description ? { description } : {}) },
          ...(parentId ? { parentId } : {}),
        }),
      ).entity.id;

    ids.task = await task('simple', 'G13 simple task');
    ids.parent = await task('parent', 'G13 parent of ten');
    for (let index = 0; index < 10; index += 1) {
      await task(`child-${index}`, `G13 child ${index}`, 'c'.repeat(4000), ids.parent);
    }
    successData(await harness.request('POST', '/v2/messages', {
      clientMutationId: 'w3-g13stmt-msg',
      anchorIds: [ids.parent],
      body: 'G13 parent message',
    }));

    // A running session working on the simple task. Seeded as rows, as
    // pty-attach-authz does: a real spawn would need an execution runtime.
    const [creator] = await harness.rows<{ created_by: string }>(
      'select created_by from public.entities where id = $1', [ids.task],
    );
    const [session] = await harness.rows<{ id: string }>(
      `insert into public.entities(id, space_id, kind, created_by)
       values (gen_random_uuid(), $1, 'work_session', $2) returning id`,
      [ids.space, creator!.created_by],
    );
    ids.session = session!.id;
    await harness.rows(
      `insert into public.work_sessions(entity_id, title, status, share_mode, workdir_mode)
       values ($1, 'G13 session', 'running', 'space', 'scratch')`,
      [ids.session],
    );
    await harness.rows(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'working_on', $4)`,
      [ids.space, ids.session, ids.task, creator!.created_by],
    );

    counter = countStatements(harness.production.db!);
  }, 180_000);

  afterAll(async () => {
    counter?.restore();
    await harness?.close();
  }, 120_000);

  async function read(id: string, query = ''): Promise<{
    total: number; context: number; untagged: number; byTag: Record<string, number>;
  }> {
    counter.reset();
    const response = await harness.request('GET', `/v2/entities/${id}/context${query ? `?${query}` : ''}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const byTag = counter.byTag();
    const untagged = byTag[UNTAGGED] ?? 0;
    return { total: counter.total(), context: counter.total() - untagged, untagged, byTag };
  }

  it('records statements per read for each fixture, by section', async () => {
    const results: Record<string, Awaited<ReturnType<typeof read>>> = {
      'simple task · default': await read(ids.task),
      'simple task · sections=summary': await read(ids.task, 'sections=summary'),
      'task with 10 children · default': await read(ids.parent),
      'task with 10 children · sections=summary': await read(ids.parent, 'sections=summary'),
      'session · default': await read(ids.session),
      'session · sections=summary': await read(ids.session, 'sections=summary'),
    };
    // eslint-disable-next-line no-console
    console.log('[M2/S2 statements per entities.context read]', JSON.stringify(results, null, 2));

    for (const [name, result] of Object.entries(results)) {
      expect(result.context, `${name}: nothing was tagged`).toBeGreaterThan(0);
      if (name.endsWith('sections=summary')) {
        expect(Object.keys(result.byTag).filter((tag) => tag !== UNTAGGED).sort(), name)
          .toEqual(['root', 'seq', 'summary']);
      }
    }
    for (const fixture of ['simple task', 'task with 10 children', 'session']) {
      expect(results[`${fixture} · sections=summary`]!.total)
        .toBeLessThan(results[`${fixture} · default`]!.total);
    }
  });
});
