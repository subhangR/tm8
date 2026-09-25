/**
 * `TM8_SPACE_SESSIONS` boot resolution (plan W0a).
 *
 * Read once at boot. `agents` is the default — an upgraded node pins its agent
 * sessions without opting in — `off` is the kill switch, and `enforce` is
 * accepted now so W3 can turn it on without a config change. What each mode
 * DOES is proven against Postgres in test/db/cross-space-token.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/http/config.js';

const BASE_ENV = { TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0' };

describe('TM8_SPACE_SESSIONS', () => {
  it('defaults to agents when unset or blank', () => {
    expect(loadConfig({ ...BASE_ENV }).spaceSessions).toBe('agents');
    expect(loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: ' ' }).spaceSessions).toBe('agents');
  });

  it('accepts off, agents and enforce, case-insensitively', () => {
    expect(loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: 'off' }).spaceSessions).toBe('off');
    expect(loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: 'Agents' }).spaceSessions).toBe('agents');
    expect(loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: 'ENFORCE' }).spaceSessions).toBe('enforce');
  });

  it('refuses anything else at boot instead of choosing a mode', () => {
    expect(() => loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: 'on' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, TM8_SPACE_SESSIONS: '0' })).toThrow(/got "0"/);
  });
});
