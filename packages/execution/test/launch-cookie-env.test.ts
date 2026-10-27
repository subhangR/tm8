/**
 * Agents never see the launch cookie or its one-time URL (plan 01a0d9eb W2, K4).
 *
 * The cookie gates the loopback auto-owner arm; the URL that mints it is
 * printed by `tm8 open` to the human's terminal. If either reached a spawned
 * session — through its environment or its launch manifest — an agent could
 * redeem the URL or replay the cookie and be the node owner again, which is
 * exactly the hole W2 closes.
 *
 * Every composer is fed a parent environment that DOES carry launch-shaped
 * keys and values (a human who ran `tm8 open` in the shell that started the
 * server), and the child must carry none of them. Each refusal is paired with
 * a positive: a safe key from the same parent env does reach the child, so
 * the test cannot pass by the composer dropping everything.
 */
import { describe, expect, it } from 'vitest';

import { composeChatEnv } from '../src/runtime/chat-env.js';
import { composeShellEnv } from '../src/shell/shell-env.js';
import { composeEnv, composeManifest } from '../src/spawn/manifest.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const LAUNCH_URL = 'https://127.0.0.1:4610/launch/tm8l_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
const LAUNCH_COOKIE_VALUE = 'v1.1800000000.Zm9yZ2VkLW1hYy1mb3ItdGVzdA';

/** A parent env as polluted as a careless human could make it. */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/owner',
  USER: 'owner',
  TM8_LAUNCH_URL: LAUNCH_URL,
  TM8_LAUNCH_CODE: 'tm8l_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg',
  TM8_LAUNCH_COOKIE: LAUNCH_COOKIE_VALUE,
  TM8_AUTO_OWNER_COOKIE: 'required',
  HTTP_COOKIE: `__Host-tm8-launch=${LAUNCH_COOKIE_VALUE}`,
  BROWSER_URL: LAUNCH_URL,
};

/** Any trace of the launch URL, its code or the cookie, in a key or a value. */
function leaks(record: Record<string, unknown>): string[] {
  const found: string[] = [];
  const text = JSON.stringify(record);
  for (const needle of ['tm8l_', '__Host-tm8-launch', '/launch/', LAUNCH_COOKIE_VALUE, 'TM8_LAUNCH']) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

function context(): SpawnContext {
  return {
    spaceId: 'space-1',
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'tm-1',
      name: 'Draco',
      role: 'PTY engineer',
      identity: 'terminal seam',
      memories: [],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks: [],
  };
}

const request: SpawnRequest = { spaceId: 'space-1', teamMemberId: 'tm-1' };

const manifest = composeManifest({
  sessionId: 'sess-launch',
  request,
  context: context(),
  launch: { mode: 'worker', model: 'opus', agentTool: 'claude-code', permissionMode: 'acceptEdits' },
  workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
  command: 'claude',
  baseUrl: 'http://127.0.0.1:4610',
});

describe('the launch cookie never reaches an agent', () => {
  it('the agent spawn env carries no launch URL, code or cookie; positive — HOME does pass', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', PARENT_ENV);
    expect(leaks(env)).toEqual([]);
    expect(env.HOME).toBe('/home/owner');
  });

  it('the launch manifest carries no launch URL, code or cookie; positive — it names its session', () => {
    expect(leaks(manifest as unknown as Record<string, unknown>)).toEqual([]);
    expect(JSON.stringify(manifest)).toContain('sess-launch');
  });

  it('the chat agent env carries no launch URL, code or cookie; positive — HOME does pass', () => {
    const env = composeChatEnv(PARENT_ENV);
    expect(leaks(env)).toEqual([]);
    expect(env.HOME).toBe('/home/owner');
  });

  it('the terminal shell env carries no launch URL, code or cookie; positive — HOME does pass', () => {
    const env = composeShellEnv({ shell: '/bin/bash', parentEnv: PARENT_ENV, baseUrl: 'http://127.0.0.1:4610' });
    expect(leaks(env)).toEqual([]);
    expect(env.HOME).toBe('/home/owner');
  });

  it('the leak detector itself sees a planted launch URL (the check can fail)', () => {
    expect(leaks({ X: LAUNCH_URL })).not.toEqual([]);
    expect(leaks({ TM8_LAUNCH_COOKIE: 'x' })).not.toEqual([]);
  });
});
