import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/args.js';
import { COLLECTION_COMMANDS } from '../src/commands/collection.js';
import { createOutput } from '../src/output.js';
import { ApiError, ProtocolError, TransportError } from '../src/errors.js';
import { deriveMutationId } from '../src/mutation.js';
import type { CommandContext } from '../src/run.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../src/discovery/observe.js', () => ({ clientFor: () => ({}), observedInvoke: invoke }));
const COLLECTION = '11111111-1111-7111-8111-111111111111';
const A = '22222222-2222-7222-8222-222222222222';
const B = '33333333-3333-7333-8333-333333333333';
const MUTATION = '44444444-4444-7444-8444-444444444444';
beforeEach(() => {
  invoke.mockReset().mockImplementation(async (_client, _op, request) => ({
    edge: { id: 'edge-id', source: { id: COLLECTION }, target: { id: request.body.entityId ?? request.params.entityId }, type: 'contains' },
    undo: { token: 'undo-token' },
  }));
});
async function run(verb: string, args: string[], full = false, format: 'json' | 'human' = 'json') {
  const parsed = parseInvocation(['collection', verb, ...args]);
  let stdout = '';
  const out = createOutput({ format, receipts: full ? 'full' : 'receipt', streams: {
    stdout: chunk => { stdout += String(chunk); }, stderr: () => {},
  } });
  const ctx = { actor: parsed.globals.as === undefined ? undefined : { value: parsed.globals.as } } as CommandContext['ctx'];
  const code = await COLLECTION_COMMANDS.find(command => command.path[1] === verb)!.run({
    path: ['collection', verb], args: parsed.positionals.slice(2), options: parsed.options, passthrough: [], ctx, out, argv: parsed.argv,
  });
  if (format === 'json') expect(stdout.trim().split('\n')).toHaveLength(1);
  return { code, receipt: format === 'json' ? JSON.parse(stdout) : undefined, stdout };
}
it.each(['add', 'remove'])('%s returns the standard receipt with membership and undo', async verb => {
  const { receipt } = await run(verb, [COLLECTION, A, ...(verb === 'remove' ? ['--yes'] : [])]);
  expect(receipt).toMatchObject({ schemaVersion: 'tm8.receipt.v1', op: `collection.${verb}`, ok: true,
    id: COLLECTION, entityId: A, refs: [{ id: 'edge-id', type: 'contains', to: A }], undo: { token: 'undo-token' } });
});
it('adds each distinct id in order and emits one receipt with stable replay identities', async () => {
  const args = [COLLECTION, A, B, A, '--mutation-id', MUTATION];
  const first = await run('add', args);
  expect(first.receipt.results.map((r: { entityId: string }) => r.entityId)).toEqual([A, B]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.map(call => call[2].body.clientMutationId)).toEqual([A, B].map(id => deriveMutationId(MUTATION, `collection.add/${COLLECTION}/${id}`)));
  const second = await run('add', args);
  expect(second.receipt).toEqual(first.receipt);
});
it('reports a partial failure without hiding successful ids', async () => {
  invoke.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'No access', 'request', false, {}));
  const { code, receipt } = await run('add', [COLLECTION, A, B]);
  expect(code).toBe(4);
  expect(receipt.ok).toBe(false);
  expect(receipt.results[0]).toMatchObject({ entityId: A, ok: false, error: { code: 'forbidden' } });
  expect(receipt.results[1]).toMatchObject({ entityId: B, ok: true });
  expect(receipt.mutationId).toBeTypeOf('string');
});
it('retries one uncertain item with its original identity while preserving single-add semantics', async () => {
  invoke.mockRejectedValueOnce(new TransportError('response lost'));
  const { receipt } = await run('add', [COLLECTION, A, B, '--mutation-id', MUTATION]);
  const sentId = invoke.mock.calls[0]![2].body.clientMutationId;
  const itemRetry = parseInvocation(receipt.results[0].next.split(' ').slice(1));
  expect(itemRetry.positionals).toEqual(['collection', 'add', COLLECTION, A]);
  expect(itemRetry.options.value('mutation-id')).toBe(sentId);
  await run('add', itemRetry.argv.slice(2));
  expect(invoke.mock.calls[2]![2].body.clientMutationId).toBe(sentId);
  // The batch id still means the original whole batch, not a one-item subset.
  await run('add', parseInvocation(receipt.next.split(' ').slice(1)).argv.slice(2));
  expect(invoke.mock.calls[3]![2].body.clientMutationId).toBe(sentId);
  await run('add', [COLLECTION, A, '--mutation-id', MUTATION]);
  expect(invoke.mock.calls[5]![2].body.clientMutationId).toBe(MUTATION);
});
it.each([200, 503])('reports malformed HTTP %i outcomes as unknown with a safe retry', async status => {
  invoke.mockRejectedValueOnce(new ProtocolError('malformed response', status));
  const { code, receipt } = await run('add', [COLLECTION, A, B]);
  expect(code).not.toBe(0);
  expect(receipt.results[0]).toMatchObject({ entityId: A, ok: false, outcome: 'unknown',
    error: { code: 'protocol', status, outcome: 'unknown', retryable: true } });
  expect(receipt.results[0].next).toContain(`--mutation-id ${receipt.results[0].mutationId}`);
  expect(receipt.results[1].ok).toBe(true);
});
it('keeps an explicit nonretryable server refusal nonambiguous', async () => {
  invoke.mockRejectedValueOnce(new ApiError(500, 'upstream_unavailable', 'rolled back', 'request', false, {}));
  const { receipt } = await run('add', [COLLECTION, A, B]);
  expect(receipt.results[0]).not.toHaveProperty('outcome');
  expect(receipt.results[0].error).not.toHaveProperty('outcome');
});
it('shows generated batch and item replay identities plus uncertainty in human output', async () => {
  invoke.mockRejectedValueOnce(new TransportError('response lost'));
  const { code, stdout } = await run('add', [COLLECTION, A, B], false, 'human');
  expect(code).not.toBe(0);
  const sentId = invoke.mock.calls[0]![2].body.clientMutationId;
  expect(stdout).toMatch(/batch mutationId: [0-9a-f-]{36}/);
  expect(stdout).toContain(`replay whole batch: tm8 collection add ${COLLECTION} ${A} ${B} --mutation-id `);
  expect(stdout).toContain(`${A} · outcome: unknown`);
  expect(stdout).toContain(`retry this item: tm8 collection add ${COLLECTION} ${A} --mutation-id ${sentId}`);
});
it('preserves explicit server, space and actor on per-item replay commands', async () => {
  invoke.mockRejectedValueOnce(new TransportError('response lost'));
  const { receipt } = await run('add', [COLLECTION, A, B, '--server', 'remote', '--space', 'linked', '--as', B]);
  expect(receipt.results[0].next).toContain(`tm8 --server remote --space linked --as ${B} collection add ${COLLECTION} ${A}`);
  expect(receipt.next).toContain(`tm8 --server remote --space linked --as ${B} collection add ${COLLECTION} ${A} ${B}`);
});
it('reads whitespace-separated ids from a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-collection-'));
  try {
    const file = join(dir, 'ids.txt');
    writeFileSync(file, `\uFEFF${A}\r\n\t${B}\n${A}\n`);
    const { receipt } = await run('add', [COLLECTION, A, '--from-file', file]);
    expect(receipt.results.map((result: { entityId: string }) => result.entityId)).toEqual([A, B]);
    expect(receipt.next).toContain(`collection add ${COLLECTION} ${A} ${B} --mutation-id `);
    expect(receipt.next).not.toContain('--from-file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('validates bulk position and extra remove ids before any write', async () => {
  await expect(run('add', [COLLECTION, A, B, '--position', '1'])).rejects.toThrow('adding one entity');
  await expect(run('remove', [COLLECTION, A, B, '--yes'])).rejects.toThrow('exactly one');
  expect(invoke).not.toHaveBeenCalled();
});
it('retains the full result on explicit --full', async () => {
  // Full JSON is pretty-printed by Output, so inspect the command directly.
  const parsed = parseInvocation(['collection', 'add', COLLECTION, A]);
  let stdout = '';
  const out = createOutput({ format: 'json', receipts: 'full', streams: { stdout: c => { stdout += String(c); }, stderr: () => {} } });
  await COLLECTION_COMMANDS[0]!.run({ path: ['collection', 'add'], args: [COLLECTION, A], options: parsed.options,
    passthrough: [], ctx: {} as CommandContext['ctx'], out });
  expect(JSON.parse(stdout)).toHaveProperty('edge');
});
