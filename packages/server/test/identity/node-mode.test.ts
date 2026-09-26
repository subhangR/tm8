/**
 * Node mode resolution (doc 15 §3.1, §3.2): the `<dataDir>/mode` file, the
 * `TM8_NODE_MODE` pin, and the aliases. What each mode does to the loopback
 * auto-owner arm is in test/identity/auto-owner.test.ts; the switch operation
 * is proven against Postgres in test/w3/node-mode-set.test.ts.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, resolveNodeMode } from '../../src/http/config.js';
import { normalizeNodeMode, readModeFile, writeModeFile } from '../../src/identity/node-mode.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-node-mode-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  TM8_DATABASE_URL: '',
  TM8_LAUNCH_BOOTSTRAP: '0',
  TM8_DATA_DIR: dataDir,
  ...extra,
});

describe('the mode file', () => {
  it('is absent until written, then holds one word at 0600', async () => {
    expect(readModeFile(dataDir)).toBeNull();
    const { path } = await writeModeFile(dataDir, 'peer');
    expect(path).toBe(join(dataDir, 'mode'));
    expect(await readFile(path, 'utf8')).toBe('peer\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(readModeFile(dataDir)).toEqual({ mode: 'peer', deprecatedAlias: false });
  });

  it('is replaced by rename: no sibling temp file is left behind', async () => {
    await writeModeFile(dataDir, 'personal');
    await writeModeFile(dataDir, 'server');
    await expect(stat(join(dataDir, 'mode.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readModeFile(dataDir)?.mode).toBe('server');
  });

  it('REFUSES corrupt content rather than defaulting to personal', async () => {
    await writeFile(join(dataDir, 'mode'), 'multiplayer\n');
    expect(() => readModeFile(dataDir)).toThrow(/must hold "personal", "peer" or "server"/);
    expect(() => loadConfig(env())).toThrow(ConfigError);
  });
});

describe('aliases', () => {
  it('maps single → personal and multi → server, flagged deprecated; nothing else', () => {
    expect(normalizeNodeMode('single')).toEqual({ mode: 'personal', deprecatedAlias: true });
    expect(normalizeNodeMode(' MULTI ')).toEqual({ mode: 'server', deprecatedAlias: true });
    expect(normalizeNodeMode('Peer')).toEqual({ mode: 'peer', deprecatedAlias: false });
    expect(normalizeNodeMode('on')).toBeNull();
    expect(normalizeNodeMode('')).toBeNull();
  });
});

describe('precedence: env over file over default', () => {
  it('defaults to personal, unset, when neither is present', () => {
    expect(resolveNodeMode(env(), dataDir)).toEqual({
      nodeMode: 'personal',
      nodeModeSource: 'default',
      nodeModeSet: false,
      nodeModeDeprecatedAlias: false,
    });
  });

  it('reads the file when the env is unset or blank', async () => {
    await writeModeFile(dataDir, 'server');
    expect(resolveNodeMode(env(), dataDir)).toMatchObject({ nodeMode: 'server', nodeModeSource: 'file', nodeModeSet: true });
    expect(resolveNodeMode(env({ TM8_NODE_MODE: '  ' }), dataDir)).toMatchObject({ nodeModeSource: 'file' });
  });

  it('lets the env pin win over the file', async () => {
    await writeModeFile(dataDir, 'personal');
    expect(resolveNodeMode(env({ TM8_NODE_MODE: 'server' }), dataDir)).toMatchObject({
      nodeMode: 'server',
      nodeModeSource: 'env',
    });
  });

  it('refuses an unrecognised env value at boot, naming the values and aliases', () => {
    expect(() => loadConfig(env({ TM8_NODE_MODE: 'multiplayer' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ TM8_NODE_MODE: 'on' }))).toThrow(/"personal", "peer" or "server".*"single"\/"multi"/);
  });

  it('an env value never reads the file: a pinned node boots even over a corrupt file', async () => {
    await writeFile(join(dataDir, 'mode'), 'garbage');
    expect(loadConfig(env({ TM8_NODE_MODE: 'peer' })).nodeMode).toBe('peer');
  });
});
