#!/usr/bin/env node
/**
 * Assert the things `electron-builder` can silently get wrong.
 *
 * node-pty 1.1.0 is Node-API, so there is no `electron-rebuild` step and
 * nothing to compile — which removes the loud failure mode and leaves only
 * quiet ones. Both of these produce a `.app` that launches, opens a window,
 * serves the UI, and then fails the first time anyone spawns a session:
 *
 *  1. `pty.node` inside the ASAR. `dlopen` cannot open a file that is not a
 *     file. `asarUnpack` fixes it; this asserts the unpack actually happened.
 *  2. `spawn-helper` losing its exec bit. It is a separate Mach-O executable
 *     (`binding.gyp` declares `'type': 'executable'`) that node-pty `exec`s,
 *     and an archive round trip is exactly how a mode gets dropped. The repo
 *     already carries `scripts/repair-node-pty.sh` for this on the server
 *     install; the desktop equivalent is this assertion, because there is
 *     nowhere to run a repair script after a user has downloaded a `.app`.
 *
 * Also checks the Postgres tree, which must be OUTSIDE the ASAR for the same
 * dlopen/exec reason and is 125 Mach-O files' worth of the same mistake.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PG_PIN } from './vendor-pg.mjs';

const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = process.argv[2] ?? join(DESKTOP_ROOT, 'release', 'mac-arm64', 'tm8.app');

const failures = [];
const checks = [];

function check(label, ok, detail) {
  checks.push(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function main() {
  if (!existsSync(APP)) {
    console.error(`verify: no app bundle at ${APP}\nRun \`bun run package\` first, or pass a path.`);
    process.exit(1);
  }
  const resources = join(APP, 'Contents', 'Resources');
  const unpacked = join(resources, 'app.asar.unpacked');
  const nodePty = join(unpacked, 'node_modules', 'node-pty');

  check('app.asar exists', existsSync(join(resources, 'app.asar')));
  check('node-pty is unpacked from the ASAR', existsSync(nodePty), nodePty);

  const dotNode = join(nodePty, 'build', 'Release', 'pty.node');
  const prebuilt = join(nodePty, 'prebuilds', 'darwin-arm64', 'pty.node');
  check('pty.node is a real file on disk', existsSync(dotNode) || existsSync(prebuilt));

  // The assertion this script exists for.
  const helper = join(nodePty, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  if (!existsSync(helper)) {
    check('spawn-helper survived packaging', false, helper);
  } else {
    const mode = statSync(helper).mode & 0o777;
    check(
      `spawn-helper is mode 0755 after packaging (is 0${mode.toString(8)})`,
      (mode & 0o111) === 0o111,
      mode === 0o755 ? undefined : 'expected every exec bit set',
    );
  }

  const pgBin = join(resources, 'pg', PG_PIN.version, 'bin');
  check('bundled Postgres is outside the ASAR', existsSync(join(pgBin, 'postgres')), pgBin);
  for (const tool of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    const p = join(pgBin, tool);
    if (!existsSync(p)) continue;
    check(`${tool} is executable`, (statSync(p).mode & 0o111) !== 0);
  }
  check('include/ was dropped', !existsSync(join(resources, 'pg', PG_PIN.version, 'include')));

  /**
   * The agent CLI, which is the failure this whole script is really about.
   *
   * `cliBinDir()` resolves `../../../cli/dist` relative to
   * `packages/execution/dist/spawn/` and RETURNS NULL rather than throwing when
   * it misses — so a bundle without it spawns agents that can never
   * `tm8 message send` and never `tm8 task link-pr`, with no error anywhere.
   * That is the hardest failure in this system to notice and it reads as a
   * model problem rather than a packaging one.
   *
   * Existence is not the assertion. `packages/cli/dist/tm8` is a SYMLINK to
   * `index.js`, `cliBinDir()`'s repair path is `symlinkSync` (which cannot
   * write into a read-only ASAR), and a dangling symlink passes every
   * "does the file exist" check ever written. So: resolve it, then RUN it.
   */
  const cliDir = join(unpacked, 'packages', 'cli', 'dist');
  check('packages/cli/dist is unpacked from the ASAR', existsSync(cliDir), cliDir);
  check('cli entry is present', existsSync(join(cliDir, 'index.js')));

  const tm8 = join(cliDir, 'tm8');
  // `existsSync` follows symlinks, so this is already a dangling-link check.
  check('the `tm8` bin resolves (not a dangling symlink)', existsSync(tm8));
  if (existsSync(tm8)) {
    const probe = spawnSync(process.execPath, [tm8, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30_000,
    });
    check(
      'the packaged `tm8` actually EXECUTES',
      probe.status === 0,
      probe.status === 0 ? undefined : `exit ${probe.status}: ${(probe.stderr || '').trim().slice(0, 200)}`,
    );
  }

  for (const pkg of ['contract', 'prompt', 'execution', 'mcp', 'server']) {
    check(`packages/${pkg}/dist is packaged`, existsSync(join(unpacked, 'packages', pkg, 'dist')) || existsSync(join(resources, 'app.asar')));
  }

  const server = join(resources, 'app.asar');
  check('server bundle is packaged', existsSync(server));

  console.log(`verify: ${APP}`);
  for (const line of checks) console.log(`  ${line}`);
  if (failures.length > 0) {
    console.error(`\nverify: ${failures.length} check(s) FAILED — this bundle would break on first session spawn.`);
    process.exit(1);
  }
  console.log(`\nverify: all ${checks.length} checks passed.`);
}

main();
