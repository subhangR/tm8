import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installedPluginsFor } from '../../src/skills/handlers.js';

// The launch ··· menu's Plugins list follows spawn's rule: the caller's
// credential home when it exists, otherwise the node's config home — never a
// union, so the menu offers only what the launch's one home carries.
describe('installedPluginsFor', () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  async function syncedHome(dir: string, names: string[]) {
    await mkdir(join(dir, 'plugins', 'synced', 'bucket'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', 'synced', 'bucket', 'manifest.json'),
      JSON.stringify({ plugins: names.map((name) => ({ name })) }),
    );
  }

  it('reads only the member home when it exists, like spawn', async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-installed-'));
    const identityId = '11111111-1111-4111-8111-111111111111';
    await syncedHome(join(root, 'data', 'credentials', identityId, 'anthropic'), ['sales', 'marketing']);
    await syncedHome(join(root, 'node'), ['sales', 'productivity']);
    expect(installedPluginsFor(join(root, 'data'), identityId, { CLAUDE_CONFIG_DIR: join(root, 'node') }))
      .toEqual(['marketing@synced', 'sales@synced']);
  });

  it('a caller with no credential home gets the node list', async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-installed-'));
    await syncedHome(join(root, 'node'), ['sales']);
    expect(installedPluginsFor(join(root, 'data'), '22222222-2222-4222-8222-222222222222', {
      CLAUDE_CONFIG_DIR: join(root, 'node'),
    })).toEqual(['sales@synced']);
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or blank', async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-installed-'));
    await syncedHome(join(root, 'home', '.claude'), ['ops']);
    expect(installedPluginsFor(join(root, 'data'), '33333333-3333-4333-8333-333333333333', {
      HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: '  ',
    })).toEqual(['ops@synced']);
  });
});
