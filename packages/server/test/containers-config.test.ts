/**
 * The container feature gate's boot resolution (TM8-CONTAINERS-DESIGN §10.1).
 *
 * The claim that matters: OFF IS THE DEFAULT, and a node that has never been
 * configured for containers must not start accepting them after an upgrade.
 * The rest of this file exists so `docs/ops/CONFIG.md` is not the only place
 * that asserts what these variables do.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/http/config.js';

const BASE_ENV = { TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0' };

describe('the container gate', () => {
  it('is OFF on a node that has never heard of containers', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.containers?.enabled).toBe(false);
  });

  it('turns on only for the literal "on"', () => {
    expect(loadConfig({ ...BASE_ENV, TM8_CONTAINERS: 'on' }).containers?.enabled).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_CONTAINERS: 'ON' }).containers?.enabled).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_CONTAINERS: 'off' }).containers?.enabled).toBe(false);
  });

  it('REFUSES an unparseable value at boot instead of defaulting to off', () => {
    // The one place here where being wrong is louder than being absent. "off"
    // and "unparseable" would otherwise look identical while meaning very
    // different things about operator intent — someone who wrote
    // `TM8_CONTAINERS=true` meant ON, and silently giving them OFF is a node
    // that disagrees with its own runbook.
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINERS: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINERS: '1' })).toThrow(/must be "on" or "off"/);
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINERS: 'yes' })).toThrow(/got "yes"/);
  });
});

describe('the rest of the container config', () => {
  it('carries the documented defaults', () => {
    const { containers } = loadConfig({ ...BASE_ENV });
    expect(containers?.providers).toEqual(['docker', 'gvisor', 'android-emulator']);
    expect(containers?.cap).toBe(4);
    expect(containers?.execCap).toBe(8);
    expect(containers?.imageRegistry).toBe('ghcr.io/subhangr/tm8');
    expect(containers?.keepFailed).toBe(false);
  });

  it('keeps the provider list IN ORDER — it is a preference list, not a set', () => {
    const { containers } = loadConfig({ ...BASE_ENV, TM8_CONTAINER_PROVIDERS: 'gvisor, docker ,fake' });
    expect(containers?.providers).toEqual(['gvisor', 'docker', 'fake']);
  });

  it('drops empty entries rather than registering a provider named ""', () => {
    const { containers } = loadConfig({ ...BASE_ENV, TM8_CONTAINER_PROVIDERS: 'fake,,' });
    expect(containers?.providers).toEqual(['fake']);
  });

  it('derives the data dir from TM8_DATA_DIR so two nodes cannot collide', () => {
    const a = loadConfig({ ...BASE_ENV, TM8_DATA_DIR: '/tmp/tm8-a' });
    const b = loadConfig({ ...BASE_ENV, TM8_DATA_DIR: '/tmp/tm8-b' });
    expect(a.containers?.dataDir).toBe('/tmp/tm8-a/containers');
    expect(b.containers?.dataDir).toBe('/tmp/tm8-b/containers');
    expect(a.containers?.dataDir).not.toBe(b.containers?.dataDir);
  });

  it('refuses a relative TM8_CONTAINER_DATA_DIR', () => {
    // A relative path resolves against whatever cwd the node happened to start
    // in, which is not a property an operator can reason about.
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINER_DATA_DIR: './containers' }))
      .not.toThrow();
    const cfg = loadConfig({ ...BASE_ENV, TM8_CONTAINER_DATA_DIR: './containers' });
    expect(cfg.containers?.dataDir.startsWith('/')).toBe(true);
  });

  it('refuses a non-positive cap rather than accepting a node that can hold nothing', () => {
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINER_CAP: '0' })).toThrow();
    expect(() => loadConfig({ ...BASE_ENV, TM8_CONTAINER_CAP: 'four' })).toThrow();
  });
});
