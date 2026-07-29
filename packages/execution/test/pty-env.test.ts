import { describe, expect, it, vi } from 'vitest';

const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }));

import { PtyHostService } from '../src/pty/PtyHostService.js';

describe('PtyHostService child environment boundary', () => {
  it('passes the caller allowlist exactly and never merges process.env', () => {
    const proc = {
      pid: 123,
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
    };
    ptyMock.spawn.mockReturnValue(proc);
    const host = new PtyHostService({ defaultShell: '/bin/sh' });
    const childEnv = {
      PATH: '/usr/bin:/bin',
      TM8_SESSION_ID: 'session-1',
      OPENAI_API_KEY: 'provider-key',
    };

    host.spawn({
      sessionId: 'session-1',
      command: 'agent-wrapper',
      cwd: '/tmp',
      env: childEnv,
    });

    const options = ptyMock.spawn.mock.calls[0]?.[2];
    expect(options?.env).toEqual(childEnv);
    expect(options?.env).not.toHaveProperty('DATABASE_URL');
    expect(options?.env).not.toHaveProperty('TM8_DATABASE_URL');
    host.shutdownAll();
  });
});
