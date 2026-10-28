import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { knownAgentConfigDirs } from '../src/transcript/agent-config-dirs.js';

const temporaryRoots: string[] = [];

async function credentialRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tm8-agent-config-dirs-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'credentials', 'id_alice'), { recursive: true });
  await mkdir(join(root, 'credentials', 'id_bob'), { recursive: true });
  await mkdir(join(root, 'credentials', 'not-an-identity'), { recursive: true });
  await mkdir(join(root, 'credentials', 'group', 'id_nested'), { recursive: true });
  await writeFile(join(root, 'credentials', 'id_not_a_directory'), 'not a directory');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('knownAgentConfigDirs', () => {
  it.each([
    ['claude-code', '.claude'],
    ['codex', '.codex'],
    ['gemini', '.gemini'],
    ['hermes', '.hermes'],
    ['cursor', '.cursor'],
  ] as const)('reads the %s node directory from the provider table', async (agentTool, dir) => {
    await expect(knownAgentConfigDirs({ agentTool, home: '/node-home' }))
      .resolves.toEqual([join('/node-home', dir)]);
  });

  it('uses explicit configDir homes for Claude/Codex and dot-dirs for HOME-scoped tools', async () => {
    const dataDir = await credentialRoot();

    await expect(knownAgentConfigDirs({
      agentTool: 'claude-code',
      dataDir,
      home: '/node-home',
    })).resolves.toEqual([
      join(dataDir, 'credentials', 'id_alice', 'anthropic'),
      join(dataDir, 'credentials', 'id_bob', 'anthropic'),
      join('/node-home', '.claude'),
    ]);

    await expect(knownAgentConfigDirs({
      agentTool: 'cursor',
      dataDir,
      home: '/node-home',
    })).resolves.toEqual([
      join(dataDir, 'credentials', 'id_alice', '.cursor'),
      join(dataDir, 'credentials', 'id_bob', '.cursor'),
      join('/node-home', '.cursor'),
    ]);
  });

  it('stays finite: it reads only direct id_* children and never recursively discovers one', async () => {
    const dataDir = await credentialRoot();
    const dirs = await knownAgentConfigDirs({
      agentTool: 'gemini',
      dataDir,
      home: '/node-home',
    });

    expect(dirs).toEqual([
      join(dataDir, 'credentials', 'id_alice', '.gemini'),
      join(dataDir, 'credentials', 'id_bob', '.gemini'),
      join('/node-home', '.gemini'),
    ]);
    expect(dirs.some((dir) => dir.includes('id_nested'))).toBe(false);
  });

  describe('a Codex session\'s isolated CODEX_HOME', () => {
    const SESSION = '44444444-4444-4444-8444-444444444444';
    const sessionHome = (dataDir: string): string =>
      join(dataDir, 'manifests', 'mcp-homes', SESSION, 'codex');

    it('leads the candidates, ahead of identity homes and the node home', async () => {
      const dataDir = await credentialRoot();
      await expect(knownAgentConfigDirs({
        agentTool: 'codex',
        dataDir,
        home: '/node-home',
        sessionId: SESSION,
      })).resolves.toEqual([
        sessionHome(dataDir),
        join(dataDir, 'credentials', 'id_alice', 'openai'),
        join(dataDir, 'credentials', 'id_bob', 'openai'),
        join('/node-home', '.codex'),
      ]);
    });

    it('is still a candidate on a node with no credentials directory', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'tm8-agent-config-dirs-'));
      temporaryRoots.push(dataDir);
      await expect(knownAgentConfigDirs({
        agentTool: 'codex',
        dataDir,
        home: '/node-home',
        sessionId: SESSION,
      })).resolves.toEqual([sessionHome(dataDir), join('/node-home', '.codex')]);
    });

    it('is never derived for another tool, a non-uuid id, or without a data dir', async () => {
      const dataDir = await credentialRoot();
      const claude = await knownAgentConfigDirs({ agentTool: 'claude-code', dataDir, home: '/node-home', sessionId: SESSION });
      expect(claude.some((dir) => dir.includes('mcp-homes'))).toBe(false);
      const traversal = await knownAgentConfigDirs({ agentTool: 'codex', dataDir, home: '/node-home', sessionId: '../../etc' });
      expect(traversal.some((dir) => dir.includes('mcp-homes'))).toBe(false);
      await expect(knownAgentConfigDirs({ agentTool: 'codex', home: '/node-home', sessionId: SESSION }))
        .resolves.toEqual([join('/node-home', '.codex')]);
    });
  });

  it('preserves the historical Claude node fallback for an unknown tool', async () => {
    await expect(knownAgentConfigDirs({ agentTool: 'echo-agent', home: '/node-home' }))
      .resolves.toEqual([join('/node-home', '.claude')]);
  });
});
