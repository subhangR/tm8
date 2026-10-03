import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/args.js';
import { COLLECTION_COMMANDS } from '../src/commands/collection.js';
import { createOutput } from '../src/output.js';
import { ApiError } from '../src/errors.js';
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
async function run(verb: string, args: string[], full = false) {
  const parsed = parseInvocation(['collection', verb, ...args]);
  let stdout = '';
  const out = createOutput({ format: 'json', receipts: full ? 'full' : 'receipt', streams: {
    stdout: chunk => { stdout += String(chunk); }, stderr: () => {},
  } });
  const ctx = { actor: undefined } as CommandContext['ctx'];
  const code = await COLLECTION_COMMANDS.find(command => command.path[1] === verb)!.run({
    path: ['collection', verb], args: parsed.positionals.slice(2), options: parsed.options, passthrough: [], ctx, out,
  });
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return { code, receipt: JSON.parse(stdout) };
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
it('reads whitespace-separated ids from a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-collection-'));
  try {
    const file = join(dir, 'ids.txt');
    writeFileSync(file, `${A}\n${B}\n`);
    const { receipt } = await run('add', [COLLECTION, '--from-file', file]);
    expect(receipt.results).toHaveLength(2);
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
