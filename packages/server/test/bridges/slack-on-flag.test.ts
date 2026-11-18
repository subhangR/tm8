/**
 * One meaning of "on" for TM8_SLACK_RUNTIME everywhere it is read: the server
 * (isOn, slack-runtime.ts), deploy.sh (tm8_is_on, deploy/prod/env.sh) and
 * doctor (isOn, scripts/lib/env.mjs). They disagreed once: `Yes`, `ON` or a
 * CRLF-edited `1\r` turned the server's runtime on while deploy skipped its
 * `npm ci`. This runs all three over one table.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isOn } from '../../src/bridges/runtime/slack-runtime.js';
// @ts-expect-error: a plain .mjs launcher module, no type declarations.
import { isOn as scriptsIsOn } from '../../../../scripts/lib/env.mjs';

const REPO = resolve(__dirname, '../../../..');

const TABLE: [string, boolean][] = [
  ['1', true], ['true', true], ['TRUE', true], ['Yes', true], ['ON', true], ['on', true],
  [' on ', true], ['1\r', true], ['\ttrue\r', true],
  ['0', false], ['false', false], ['no', false], ['off', false], ['', false], ['  ', false],
  ['2', false], ['yes please', false], ['tru', false], ['o n', false],
];

function shellAnswers(values: string[]): boolean[] {
  const script = 'source "$0/deploy/prod/env.sh" >/dev/null 2>&1; for v in "$@"; do if tm8_is_on "$v"; then echo 1; else echo 0; fi; done';
  const r = spawnSync('bash', ['-c', script, REPO, ...values], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_BRIDGES_ENV_FILE: join(REPO, 'does-not-exist.env') },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim().split('\n').map((l) => l === '1');
}

describe('the on/off rule for TM8_SLACK_RUNTIME', () => {
  it('is the same in the server, deploy.sh and doctor', () => {
    const values = TABLE.map(([v]) => v);
    const want = TABLE.map(([, on]) => on);
    expect(values.map((v) => isOn(v))).toEqual(want);
    expect(values.map((v) => (scriptsIsOn as (v: string) => boolean)(v))).toEqual(want);
    expect(shellAnswers(values)).toEqual(want);
    expect(isOn(undefined)).toBe(false);
  });
});
