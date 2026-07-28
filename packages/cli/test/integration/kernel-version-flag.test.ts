/**
 * THE COLLISION FIX, measured on the BUILT BINARY against a REAL Server.
 *
 * The unit tests prove `parseInvocation` now routes `--version` correctly. They
 * cannot prove the thing that actually mattered, because the defect was an
 * INTERACTION between the parser and `run()`: `run()` checks `globals.version`
 * FIRST, so a mis-parse short-circuited the whole dispatch and exited 0 before
 * any command, any context resolution, or any request existed.
 *
 * That is only observable end-to-end. Before the fix, every row below printed
 * `0.1.0` and exited 0 — including the published A16 invocation.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: the Server's answer to the A16
 * preview. Whether that row is composed on this node is another slot's result
 * and this test must not smuggle in a claim about it. The load-bearing property
 * here is that the CLI REACHED the Server at all instead of answering a
 * different question locally — so the assertion is on the exit code NOT being
 * the version banner, and the Server's actual answer is recorded verbatim.
 */
import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('kernel-version-flag');
}, 120_000);

afterAll(async () => {
  // Teardown on the FAILURE path too, not only on success.
  await server?.stop();
});

const VERSION_BANNER = /^\s*0\.\d+\.\d+\s*$/;

describe('the built CLI, against a real Server', () => {
  it('bare `tm8 --version` still prints the version and exits 0', async () => {
    const r = await cli(['--version'], server);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(VERSION_BANNER);
  });

  it('`kind list --version 3` RUNS THE COMMAND instead of printing the version', async () => {
    for (const argv of [
      ['kind', 'list', '--version', '3'],
      ['kind', 'list', '--version=3'],
    ]) {
      const r = await cli(argv, server);
      const label = argv.join(' ');
      // The precise regression: exit 0 with the version banner on stdout.
      expect(r.stdout, label).not.toMatch(VERSION_BANNER);
      expect(r.code, label).not.toBe(0);
      // stdout is data only; every diagnostic went to stderr.
      expect(r.stderr.length, label).toBeGreaterThan(0);
    }
  });

  it('the published A16 invocation reaches the Server rather than short-circuiting', async () => {
    const argv = ['interaction-profile', 'preview', '44444444-4444-7444-8444-444444444444', '--version', '3'];
    const r = await cli(argv, server);
    // eslint-disable-next-line no-console
    console.log(`[A16] exit=${r.code} stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim().slice(0, 240))}`);
    expect(r.stdout).not.toMatch(VERSION_BANNER);
    expect(r.code).not.toBe(0);
  });

  it('an ambiguous `--version` before a command refuses on stderr, naming the collision', async () => {
    const r = await cli(['--version', 'kind', 'list'], server);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--version');
    // Nothing diagnostic reached stdout (output law §7).
    expect(r.stdout.trim()).toBe('');
  });

  it('PROBE: this suite can SEE the pre-fix behaviour it claims is gone', async () => {
    // The matcher above is a negative assertion, so it must be shown capable of
    // firing. `--version` alone still produces exactly the banner the broken
    // rows used to produce — same regex, same stream, opposite verdict.
    const r = await cli(['--version'], server);
    expect(r.stdout).toMatch(VERSION_BANNER);
    expect(r.code).toBe(0);
  });

  it('reports its bind identity and a coherent chain', async () => {
    // eslint-disable-next-line no-console
    console.log(`[kernel-version-flag] chain bind-start ${server.bindStart.files}/${server.bindStart.digest}`);
    await server.assertBindCoherent();
  });
});
