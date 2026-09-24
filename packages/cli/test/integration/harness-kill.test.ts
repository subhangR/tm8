/**
 * The harness's `cli()` kill timer, against a child that genuinely does not exit.
 *
 * `events.poll paging ... --limit 1` went red in CI as a bare "Test timed out in
 * 120000ms" — no command, no step, no output — in ~16 of 72 runs. A child that
 * never exits is the shape that produces exactly that, and `cli()` had no timer
 * of its own. This drives the real built binary at a peer that sends headers and
 * then stalls mid-body, and requires the harness to kill it and NAME it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { assertBuilt, cli, CLI_KILLED_CODE } from './harness.js';

let stall: Server;
const sockets = new Set<Socket>();
let baseUrl = '';

beforeAll(async () => {
  await assertBuilt();
  stall = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":{"items":[');
  });
  stall.on('connection', (s) => { sockets.add(s); });
  await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => stall.close(() => resolve()));
});

it('kills a child that has not exited by its deadline, and names the command', async () => {
  const argv = ['event', 'list', '--space', '00000000-0000-7000-8000-0000000000a1', '--after', '0', '--limit', '1', '--format', 'json'];
  const t0 = Date.now();
  // 1s is below the client's own 15s per-request deadline, so the harness timer
  // is what ends this child, whatever the client does.
  const r = await cli(argv, { env: { TM8_BASE_URL: baseUrl } }, {}, { killAfterMs: 1_000 });
  expect(r.code).toBe(CLI_KILLED_CODE);
  expect(r.stderr).toContain('[harness] KILLED');
  expect(r.stderr).toContain(`tm8 ${argv.join(' ')}`);
  expect(r.stderr).toContain('did not exit within 1000ms');
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 30_000);
