import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, type PreviewConfig } from '../../src/http/config.js';
import { gatePosture, projectFoldersPolicy } from '../../src/projects/node-policy.js';

/** Decision 29: only a loopback-only personal (formerly `single`) node shares folders across spaces. */
const preview = (host: string): PreviewConfig => ({ host, port: 4613, origin: `http://${host}:4613` } as PreviewConfig);

describe('gatePosture(config)', () => {
  it('a single node with no public surface is loopback, and shares folders', () => {
    expect(gatePosture({ nodeMode: 'personal' })).toBe('loopback');
    expect(gatePosture({})).toBe('loopback');
    expect(gatePosture({ nodeMode: 'personal', extraAllowedHostnames: [], allowedOrigins: [] })).toBe('loopback');
    expect(projectFoldersPolicy(gatePosture({ nodeMode: 'personal' }))).toBe('shared');
  });

  it('a loopback preview host keeps it loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(gatePosture({ nodeMode: 'personal', preview: preview(host) })).toBe('loopback');
    }
  });

  it('every open door makes it open, and one space per folder', () => {
    const open = [
      { nodeMode: 'server' as const },
      // Peer lets other people sign in: not this machine's gate alone.
      { nodeMode: 'peer' as const },
      { nodeMode: 'personal' as const, publicOrigin: 'https://tm8.example.com' },
      { nodeMode: 'personal' as const, extraAllowedHostnames: ['tm8.lan'] },
      { nodeMode: 'personal' as const, allowedOrigins: ['https://app.example.com'] },
      { nodeMode: 'personal' as const, preview: preview('preview.example.com') },
    ];
    for (const config of open) {
      expect(gatePosture(config), JSON.stringify(config)).toBe('open');
      expect(projectFoldersPolicy(gatePosture(config))).toBe('one_space');
    }
  });

  /**
   * Node modes (doc 15) through the real config: `single` is a deprecated alias
   * that normalises to `personal`, so a loopback `TM8_NODE_MODE=single` node
   * (the prod spelling) keeps decision 29's shared posture exactly as before;
   * `multi` normalises to `server` and stays one space per folder.
   */
  it('the single/multi aliases keep their posture through loadConfig', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-node-policy-mode-'));
    try {
      const env = (mode: string) => ({ TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0', TM8_DATA_DIR: dataDir, TM8_NODE_MODE: mode });
      expect(gatePosture(loadConfig(env('single')))).toBe('loopback');
      expect(gatePosture(loadConfig(env('personal')))).toBe('loopback');
      expect(gatePosture(loadConfig(env('multi')))).toBe('open');
      expect(gatePosture(loadConfig(env('peer')))).toBe('open');
      expect(gatePosture(loadConfig(env('server')))).toBe('open');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
