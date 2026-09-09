import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demux } from '../src/docker.mjs';
import { KeyedLock, WorkspaceBroker, validId } from '../src/broker.mjs';
import { isPublicAddress, createEgressProxy } from '../src/egress.mjs';

test('egress refuses host, metadata, private and IPv6 transition addresses', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fc00::1', '224.1.2.3']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('140.82.113.3'), true);
});
test('egress rejects DNS answers containing internal addresses', async () => {
  const proxy = createEgressProxy({ lookup: async () => ['8.8.8.8', '127.0.0.1'] });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: proxy.address().port, path: 'http://rebind.example/' }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
});
test('resource names cannot become paths or Docker selectors', () => {
  for (const value of ['../etc', '-v /:/host', '', 'user-name']) assert.throws(() => validId(value));
  const broker = new WorkspaceBroker({ machineId: 'b0a1c7ea-7b10-4e55-a540-000000000001' });
  assert.throws(() => broker.assertOwner({ Config: { Labels: { 'tm8.account': 'other' } } }, 'workspace', 'account'), /identity_mismatch/);
});
test('repository locks serialize mutations and release on failure', async () => {
  const locks = new KeyedLock(); let active = 0, max = 0;
  await Promise.allSettled(Array.from({ length: 25 }, (_, i) => locks.run('repository', async () => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (i % 3 === 0) throw new Error('simulated failure');
  })));
  assert.equal(max, 1); assert.equal(locks.tails.size, 0);
});
test('Docker multiplexed output is decoded without confusing stderr for protocol data', () => {
  const frame = (channel, value) => { const head = Buffer.alloc(8); head[0] = channel; head.writeUInt32BE(value.length, 4); return Buffer.concat([head, Buffer.from(value)]); };
  const result = demux(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, 'put')]));
  assert.equal(result.stdout.toString(), 'output'); assert.equal(result.stderr.toString(), 'err');
  assert.throws(() => demux(Buffer.from([1, 0])), /Truncated/);
});
