import { describe, expect, it } from 'vitest';

import type { PreviewConfig } from '../../src/http/config.js';
import { gatePosture, projectFoldersPolicy } from '../../src/projects/node-policy.js';

/** Decision 29: only a loopback-only single node shares folders across spaces. */
const preview = (host: string): PreviewConfig => ({ host, port: 4613, origin: `http://${host}:4613` } as PreviewConfig);

describe('gatePosture(config)', () => {
  it('a single node with no public surface is loopback, and shares folders', () => {
    expect(gatePosture({ nodeMode: 'single' })).toBe('loopback');
    expect(gatePosture({})).toBe('loopback');
    expect(gatePosture({ nodeMode: 'single', extraAllowedHostnames: [], allowedOrigins: [] })).toBe('loopback');
    expect(projectFoldersPolicy(gatePosture({ nodeMode: 'single' }))).toBe('shared');
  });

  it('a loopback preview host keeps it loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(gatePosture({ nodeMode: 'single', preview: preview(host) })).toBe('loopback');
    }
  });

  it('every open door makes it open, and one space per folder', () => {
    const open = [
      { nodeMode: 'multi' as const },
      { nodeMode: 'single' as const, publicOrigin: 'https://tm8.example.com' },
      { nodeMode: 'single' as const, extraAllowedHostnames: ['tm8.lan'] },
      { nodeMode: 'single' as const, allowedOrigins: ['https://app.example.com'] },
      { nodeMode: 'single' as const, preview: preview('preview.example.com') },
    ];
    for (const config of open) {
      expect(gatePosture(config), JSON.stringify(config)).toBe('open');
      expect(projectFoldersPolicy(gatePosture(config))).toBe('one_space');
    }
  });
});
