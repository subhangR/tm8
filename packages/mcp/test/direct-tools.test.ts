import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CatalogTransport } from '../src/catalog-client.js';
import { Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = { invoke: async () => ({ ok: true }) };

describe('direct repository tools', () => {
  it('reads and directly edits within the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    await writeFile(join(root, 'one.txt'), 'alpha\nbeta\n', 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'build', projectRoot: root });

    const read = await router.call('repo_read_file', { path: 'one.txt' });
    expect(read.structuredContent).toMatchObject({ text: 'alpha\nbeta\n' });
    const edit = await router.call('repo_edit', { path: 'one.txt', oldText: 'beta', newText: 'gamma' });
    expect(edit.isError).toBeUndefined();
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('alpha\ngamma\n');
  });

  it('preflights multi-edit before writing any target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    await writeFile(join(root, 'one.txt'), 'one', 'utf8');
    await writeFile(join(root, 'two.txt'), 'two', 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'build', projectRoot: root });
    const result = await router.call('repo_multi_edit', { edits: [
      { path: 'one.txt', oldText: 'one', newText: 'changed' },
      { path: 'two.txt', oldText: 'missing', newText: 'changed' },
    ] });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'conflict' } } });
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('one');
  });

  it('rejects absolute, parent and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    const outside = await mkdtemp(join(tmpdir(), 'tm8-outside-'));
    await mkdir(join(root, 'dir'));
    await writeFile(join(outside, 'secret'), 'nope', 'utf8');
    await symlink(outside, join(root, 'escape'));
    const router = new Tm8ToolRouter(transport, { mode: 'ask', projectRoot: root });
    for (const path of ['/etc/passwd', '../outside', 'escape/secret']) {
      const result = await router.call('repo_read_file', { path });
      expect(result.isError, path).toBe(true);
    }
  });
});
