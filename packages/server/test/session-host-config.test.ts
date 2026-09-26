/**
 * `TM8_SESSION_HOST` boot resolution (task 01a0db31).
 *
 * On by default for a server install — its agents survive a restart — and off
 * by default for the desktop app, which quits with its agents. `0`/`1` override
 * either; anything else refuses to boot rather than guessing.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/http/config.js';

const BASE_ENV = { TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0' };

describe('TM8_SESSION_HOST', () => {
  it('defaults on for the server profile and off for desktop', () => {
    expect(loadConfig({ ...BASE_ENV }).sessionHost).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_SESSION_HOST: ' ' }).sessionHost).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TM8_DESKTOP: '1' }).sessionHost).toBe(false);
  });

  it('0 and 1 override the profile default', () => {
    expect(loadConfig({ ...BASE_ENV, TM8_SESSION_HOST: '0' }).sessionHost).toBe(false);
    expect(loadConfig({ ...BASE_ENV, TM8_DESKTOP: '1', TM8_SESSION_HOST: '1' }).sessionHost).toBe(true);
  });

  it('refuses anything else at boot', () => {
    expect(() => loadConfig({ ...BASE_ENV, TM8_SESSION_HOST: 'yes' })).toThrow(ConfigError);
  });
});
