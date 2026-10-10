import { ACTION_ROW_COLUMNS, ToolConfigSetInputSchema, ToolRunInputSchema, ToolSecretBindInputSchema, ToolViewSchema, type ActionRows, type OperationName } from '@tm8/contract';
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../data/real/http';
import { fakeFetch } from '../data/real/test-support';
import { createToolPort } from './adapter';
import { fixtureTool, createToolFixture } from './fixture';

function actions(human = true): ActionRows {
  return { schema: 'tm8.actions.v2', actorId: fixtureTool.id, human, columns: ACTION_ROW_COLUMNS, capabilityEpoch: 'test', total: 4,
    rows: ['tools.update', 'tools.config.set', 'tools.secrets.bind', 'tools.run'].map(name => [name as OperationName, 'command', 'entity', 'public']) };
}
const graph = () => ({ actions: { list: vi.fn(async () => actions()) }, connections: vi.fn(async () => ({ items: [], nextCursor: null })) });

describe('tool operation transport', () => {
  it('uses the final versioned config and human secret operation routes and value payload', async () => {
    const f = fakeFetch(() => ({ data: {} }));
    const port = createToolPort(createHttpClient({ fetch: f.fetch }), graph());
    await port.setConfig(fixtureTool, 'limit', 7);
    expect(f.last()).toMatchObject({ method: 'PUT', url: `/v2/tools/${fixtureTool.id}/config`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'limit', value: 7, clientMutationId: expect.any(String) } });
    expect(ToolConfigSetInputSchema.safeParse(f.last().body).success).toBe(true);
    await port.unsetConfig(fixtureTool, 'limit');
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/config/unset`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'limit' } });
    await port.setSecret(fixtureTool, 'token', 'private-value');
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/secrets/bind`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'token', value: 'private-value' } });
    expect(f.last().body).not.toHaveProperty('secret');
    expect(f.last().body).not.toHaveProperty('label');
    expect(ToolSecretBindInputSchema.safeParse(f.last().body).success).toBe(true);
    await port.unsetSecret(fixtureTool, 'token');
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/secrets/unbind`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'token' } });
    expect(f.calls.every(call => call.headers?.['x-tm8-client'] === 'tm8-ui')).toBe(true);
  });

  it('keeps ephemeral run secrets in the authenticated body and exposes only the session pointer', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000020';
    const f = fakeFetch(() => ({ data: { sessionId, toolId: fixtureTool.id, toolVersion: 1, sourceSha256: fixtureTool.sourceSha256, keepOpen: true, reused: false, secrets: { token: 'accidental-server-echo' } } }));
    const port = createToolPort(createHttpClient({ fetch: f.fetch }), graph());
    const result = await port.run({ toolId: fixtureTool.id, expectedVersion: 1, clientMutationId: 'run-test', keepOpen: true, inputs: { limit: 3 }, secrets: { token: 'one-run-value' } });
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/run`, body: { expectedVersion: 1, keepOpen: true, inputs: { limit: 3 }, secrets: { token: 'one-run-value' } } });
    expect(f.last().url).not.toContain('one-run-value');
    expect(ToolRunInputSchema.safeParse(f.last().body).success).toBe(true);
    expect(result).toEqual({ sessionId });
  });

  it('hides secret writes for agents and refused discovery rows', async () => {
    const seam = graph();
    seam.actions.list = vi.fn(async () => actions(false));
    const port = createToolPort(createHttpClient({ fetch: fakeFetch(() => ({ data: {} })).fetch }), seam);
    expect(await port.permissions(fixtureTool.id)).toMatchObject({ setSecret: false, run: true });
    seam.actions.list = vi.fn(async () => { const result = actions(); result.rows = result.rows.map(row => row[0] === 'tools.secrets.bind' ? [...row.slice(0, 4), true] as ActionRows['rows'][number] : row); return result; });
    expect(await port.permissions(fixtureTool.id)).toMatchObject({ setSecret: false, run: true });
  });

  it('refuses launch review when source changed after the dialog was opened', async () => {
    const f = fakeFetch(() => ({ data: { ...fixtureTool, sourceSha256: 'b'.repeat(64) } }));
    await expect(createToolPort(createHttpClient({ fetch: f.fetch }), graph()).sourceChange(fixtureTool)).rejects.toThrow('Reload the tool and review the source');
  });

  it('reads the final strict view and source attribution without exposing secret values', async () => {
    const view = { ...fixtureTool, secretBindings: [{ inputName: 'token', credentialId: '00000000-0000-4000-8000-000000000003', keyHint: '…abcd', boundBy: null, boundAt: '2026-10-10T12:00:00Z' }],
      sourceChangedSinceViewerLastRun: { byActor: { id: fixtureTool.id, kind: 'member', displayName: 'Ada', isAgent: false }, at: '2026-10-10T12:00:00Z', fromSha: 'b'.repeat(64), toSha: fixtureTool.sourceSha256 } };
    expect(ToolViewSchema.safeParse(view).success).toBe(true);
    const f = fakeFetch(() => ({ data: view }));
    const port = createToolPort(createHttpClient({ fetch: f.fetch }), graph());
    expect(await port.get(fixtureTool.id)).toMatchObject({ executionVersion: 1, configRevision: 0, secretBindings: [{ keyHint: '…abcd', boundAt: '2026-10-10T12:00:00Z' }] });
    expect(await port.sourceChange(fixtureTool)).toEqual({ changedBy: 'Ada' });
    expect(f.last()).toMatchObject({ method: 'GET', url: `/v2/tools/${fixtureTool.id}` });
  });

  it('gets one paged history response with invoker metadata', async () => {
    const fixture = createToolFixture();
    const { sessionId } = await fixture.port.run({ toolId: fixtureTool.id, expectedVersion: 1, clientMutationId: 'history-test', keepOpen: true });
    const run = await fixture.port.runGet(sessionId);
    run.invoker = { id: fixtureTool.id, kind: 'member', displayName: 'Ada', isAgent: false };
    const f = fakeFetch(() => ({ data: { items: [run], nextCursor: 'next' } }));
    const seam = graph();
    const page = await createToolPort(createHttpClient({ fetch: f.fetch }), seam).history(fixtureTool.id, 'cursor');
    expect(f.calls).toHaveLength(1);
    expect(f.last()).toMatchObject({ method: 'GET', url: `/v2/tools/${fixtureTool.id}/runs?limit=20&cursor=cursor` });
    expect(seam.connections).not.toHaveBeenCalled();
    expect(page).toEqual({ items: [run], nextCursor: 'next' });
  });

  it.each(['unreadable', 'deleted'])('keeps visible history when an executes edge points to a %s run', async inaccessible => {
    const fixture = createToolFixture();
    const { sessionId } = await fixture.port.run({ toolId: fixtureTool.id, expectedVersion: 1, clientMutationId: 'visible-history', keepOpen: true });
    const run = await fixture.port.runGet(sessionId);
    const f = fakeFetch(call => {
      if (call.url.includes(`/tool-runs/${inaccessible}`)) return { status: inaccessible === 'deleted' ? 404 : 403, error: { code: inaccessible === 'deleted' ? 'not_found' : 'unauthorized', message: 'Run is unavailable' } };
      return { data: { items: [run], nextCursor: null } };
    });
    const seam = { ...graph(), connections: vi.fn(async () => ({ items: [sessionId, inaccessible].map(id => ({ type: 'executes', source: { id }, target: { id: fixtureTool.id } })), nextCursor: null })) };
    const history = await createToolPort(createHttpClient({ fetch: f.fetch }), seam).history(fixtureTool.id);
    expect(history.items).toEqual([run]);
    expect(f.calls).toHaveLength(1);
    expect(f.last()).toMatchObject({ method: 'GET', url: `/v2/tools/${fixtureTool.id}/runs?limit=20` });
    expect(seam.connections).not.toHaveBeenCalled();
  });
});
