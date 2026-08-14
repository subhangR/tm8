import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CatalogTransport } from '../src/catalog-client.js';
import { Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = { invoke: async () => ({ ok: true }) };
const execFileAsync = promisify(execFile);

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

  it('refuses dangling-symlink writes and never creates the outside target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    const outside = await mkdtemp(join(tmpdir(), 'tm8-outside-'));
    const outsideTarget = join(outside, 'created-by-escape');
    await symlink(outsideTarget, join(root, 'dangling'));
    const router = new Tm8ToolRouter(transport, { mode: 'build', projectRoot: root });
    const result = await router.call('repo_write', { path: 'dangling', content: 'nope' });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'forbidden' } } });
    await expect(readFile(outsideTarget, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('implements glob and grep without a host ripgrep binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'one.ts'), 'const alpha = 1;\n', 'utf8');
    await writeFile(join(root, 'src', 'two.txt'), 'alpha\n', 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'ask', projectRoot: root });
    await expect(router.call('repo_glob', { pattern: 'src/**/*.ts' })).resolves.toMatchObject({
      structuredContent: { paths: ['src/one.ts'], truncated: false },
    });
    await expect(router.call('repo_grep', { query: 'alpha', glob: '**/*.ts' })).resolves.toMatchObject({
      structuredContent: { matches: [{ path: 'src/one.ts', line: 1, column: 7 }] },
    });
    await expect(router.call('repo_glob', { pattern: '!src/**' })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'invalid_input' } },
    });
  });

  it('returns a capped local git diff with an honest truncation flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-git-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, 'large.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'large.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', root], { cwd: root });
    await writeFile(join(root, 'large.txt'), 'changed\n'.repeat(20_000), 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'ask', projectRoot: root });
    const result = await router.call('git_diff', { maxBytes: 2048 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(String(result.structuredContent.diff))).toBeLessThanOrEqual(2048);
    expect(String(result.structuredContent.diff)).not.toBe('');
    await expect(router.call('git_branch', {})).resolves.toMatchObject({
      structuredContent: { remote: null },
    });
  });

  it('constrains docs and sessions to the thread Space and entity kind', async () => {
    const scopedTransport: CatalogTransport = {
      invoke: async (operation, options) => {
        if (operation === 'entities.get') {
          const id = options.params?.id;
          if (id === 'doc-ok') return { id, kind: 'doc', spaceId: 'space-a' };
          if (id === 'task-no') return { id, kind: 'task', spaceId: 'space-a' };
          return { id, kind: 'work_session', spaceId: 'space-b' };
        }
        return { ok: true };
      },
    };
    const router = new Tm8ToolRouter(scopedTransport, { mode: 'plan', spaceId: 'space-a' });
    const updated = await router.call('doc_update', { docId: 'doc-ok', expectedVersion: 1, body: 'ok' });
    expect(updated.isError).toBeUndefined();
    await expect(router.call('doc_update', { docId: 'task-no', expectedVersion: 1, body: 'no' })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'invalid_input' } },
    });
    const build = new Tm8ToolRouter(scopedTransport, { mode: 'build', spaceId: 'space-a' });
    await expect(build.call('session_transcript', { sessionId: 'session-b' })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'forbidden' } },
    });
  });

  it('blocks reserved IPv4/IPv6 destinations and revalidates redirects', async () => {
    const called: string[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = String(input);
      called.push(url);
      if (url === 'https://93.184.216.34/start') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    const router = new Tm8ToolRouter(transport, { mode: 'ask', fetchImpl });
    for (const url of [
      'http://100.64.0.1/', 'http://198.18.0.1/', 'http://192.0.0.1/',
      'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/',
    ]) {
      await expect(router.call('web_fetch', { url })).resolves.toMatchObject({
        isError: true, structuredContent: { error: { code: 'forbidden' } },
      });
    }
    const redirected = await router.call('web_fetch', { url: 'https://93.184.216.34/start' });
    expect(redirected).toMatchObject({ isError: true, structuredContent: { error: { code: 'forbidden' } } });
    expect(called).toEqual(['https://93.184.216.34/start']);
  });
});
