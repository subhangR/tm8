import { describe, expect, it } from 'vitest';

import { composeChatEnv } from './runtime/chat-env.js';
import { applySessionTmpdir } from './session-tmpdir.js';

describe('session TMPDIR', () => {
  it('points a spawned process at the managed dir, without leaking the TM8_ name', () => {
    const env = composeChatEnv({ PATH: '/usr/bin', TMPDIR: '/tmp', TM8_SESSION_TMPDIR: '/data/tmp' });
    expect(env.TMPDIR).toBe('/data/tmp');
    expect(env.TM8_SESSION_TMPDIR).toBeUndefined();
  });

  it('keeps the inherited TMPDIR when no managed dir is set, or it is not absolute', () => {
    const env: Record<string, string | undefined> = { TMPDIR: '/tmp' };
    applySessionTmpdir(env, {});
    applySessionTmpdir(env, { TM8_SESSION_TMPDIR: 'relative/tmp' });
    expect(env.TMPDIR).toBe('/tmp');
  });
});
