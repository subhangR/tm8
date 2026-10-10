import { ACTION_ROW_COLUMNS, type ActionRows, type OperationName } from '@tm8/contract';
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
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/config`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'limit', value: 7, clientMutationId: expect.any(String) } });
    await port.unsetConfig(fixtureTool, 'limit');
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/config/unset`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'limit' } });
    await port.setSecret(fixtureTool, 'token', 'private-value');
    expect(f.last()).toMatchObject({ method: 'POST', url: `/v2/tools/${fixtureTool.id}/secrets`, body: { toolId: fixtureTool.id, expectedVersion: 1, inputName: 'token', value: 'private-value' } });
    expect(f.last().body).not.toHaveProperty('secret');
    expect(f.last().body).not.toHaveProperty('label');
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

  it('gets run history from incoming executes edges and loads each pinned run', async () => {
    const fixture = createToolFixture();
    const { sessionId } = await fixture.port.run({ toolId: fixtureTool.id, expectedVersion: 1, clientMutationId: 'history-test', keepOpen: true });
    const run = await fixture.port.runGet(sessionId);
    const f = fakeFetch(() => ({ data: run }));
    const seam = graph();
    seam.connections = vi.fn(async () => ({ items: [{ type: 'executes', source: { id: sessionId }, target: { id: fixtureTool.id } }], nextCursor: 'next' })) as unknown as typeof seam.connections;
    const page = await createToolPort(createHttpClient({ fetch: f.fetch }), seam).history(fixtureTool.id, 'cursor');
    expect(seam.connections).toHaveBeenCalledWith(fixtureTool.id, { limit: 20, types: ['executes'], direction: 'incoming', cursor: 'cursor' });
    expect(f.last()).toMatchObject({ method: 'GET', url: `/v2/tool-runs/${sessionId}` });
    expect(page).toEqual({ items: [run], nextCursor: 'next' });
  });
});
