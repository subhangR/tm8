import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactManifestSchema } from '@tm8/contract';
import type { CatalogTransport } from '../src/catalog-client.js';
import { Tm8ToolRouter } from '../src/tools.js';

const transport: CatalogTransport = { invoke: async () => ({ ok: true }) };
const execFileAsync = promisify(execFile);

describe('direct repository tools', () => {
  it('normalizes bounded inline diagrams and exact annotated repository excerpts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-explain-'));
    await writeFile(join(root, 'flow.ts'), 'const one = 1;\nconst two = one + 1;\n', 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'explain', projectRoot: root });

    await expect(router.call('explain_diagram', {
      title: 'Request flow', source: 'flowchart LR\n  A --> B', caption: 'One hop.',
    })).resolves.toMatchObject({
      structuredContent: {
        tool: 'explain_diagram', presentation: 'mermaid', title: 'Request flow',
        source: 'flowchart LR\n  A --> B', caption: 'One hop.',
      },
    });
    await expect(router.call('explain_code', {
      path: 'flow.ts', startLine: 2, endLine: 2,
      highlights: [{ startLine: 2, endLine: 2, label: 'Derived value', tone: 'focus' }],
    })).resolves.toMatchObject({
      structuredContent: {
        tool: 'explain_code', presentation: 'code', sourceKind: 'repository',
        path: 'flow.ts', language: 'typescript', code: 'const two = one + 1;',
        startLine: 2, endLine: 2, totalLines: 3,
        highlights: [{ startLine: 2, endLine: 2, label: 'Derived value', tone: 'focus' }],
      },
    });
    await expect(router.call('explain_code', {
      path: 'flow.ts', code: 'fabricated()',
    })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'invalid_input' } },
    });
  });

  it('verifies persisted explanation edges and same-Space file assets before presenting them', async () => {
    const sourceId = '019f0000-0000-7000-8000-000000000101';
    const targetId = '019f0000-0000-7000-8000-000000000102';
    const edgeId = '019f0000-0000-7000-8000-000000000103';
    const fileId = '019f0000-0000-7000-8000-000000000104';
    const scoped: CatalogTransport = {
      invoke: async (operation, options) => {
        if (operation === 'entities.get') {
          const id = String(options?.params?.id);
          if (id === fileId) return {
            id, kind: 'file', spaceId: 'space-a',
            content: { kind: 'file', name: 'architecture.png', mimeType: 'image/png', sizeBytes: 4096 },
          };
          return { id, kind: 'task', spaceId: 'space-a' };
        }
        if (operation === 'entities.connections') return {
          items: [{
            id: edgeId, type: 'depends_on',
            source: { id: sourceId }, target: { id: targetId },
          }],
          nextCursor: null,
        };
        return { ok: true };
      },
    };
    const router = new Tm8ToolRouter(scoped, { mode: 'explain', spaceId: 'space-a' });
    const graph = {
      title: 'Dependency', focusNodeId: 'source',
      nodes: [
        { id: 'source', label: 'Source', entityId: sourceId, kind: 'task' },
        { id: 'target', label: 'Target', entityId: targetId, kind: 'task' },
        { id: 'idea', label: 'Why it matters' },
      ],
      edges: [
        { from: 'source', to: 'target', label: 'depends on', basis: 'persisted', edgeId, relationshipType: 'depends_on' },
        { from: 'target', to: 'idea', label: 'explains', basis: 'inferred' },
      ],
    };
    await expect(router.call('explain_graph', graph)).resolves.toMatchObject({
      structuredContent: {
        tool: 'explain_graph', presentation: 'focused_graph',
        edges: [
          { basis: 'persisted', edgeId, relationshipType: 'depends_on' },
          { basis: 'inferred' },
        ],
      },
    });
    await expect(router.call('explain_graph', {
      ...graph,
      edges: [{ ...graph.edges[0], edgeId: '019f0000-0000-7000-8000-000000000199' }],
    })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'conflict' } },
    });
    await expect(router.call('explain_asset', {
      fileEntityId: fileId, caption: 'The current architecture.', alt: 'Architecture graph',
    })).resolves.toMatchObject({
      structuredContent: {
        tool: 'explain_asset', presentation: 'asset', fileEntityId: fileId,
        name: 'architecture.png', mimeType: 'image/png', sizeBytes: 4096,
        title: 'architecture.png', alt: 'Architecture graph',
      },
    });
  });

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

  it('terminates catastrophic fallback grep expressions instead of blocking the MCP process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-'));
    await writeFile(join(root, 'hostile.txt'), `${'a'.repeat(64)}!\n`, 'utf8');
    const router = new Tm8ToolRouter(transport, { mode: 'ask', projectRoot: root });
    const started = Date.now();
    await expect(router.call('repo_grep', { query: '(a+)+$' })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'tool_timeout' } },
    });
    expect(Date.now() - started).toBeLessThan(3_000);
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

  it('strips credentials from the origin URL it reports back to the model', async () => {
    // PORTED, not written fresh. This assertion lived in the chat clone test in
    // packages/server (`provisions one persistent isolated Git clone per
    // thread`), which #479 deleted along with the clone machinery — and it was
    // the ONLY place a remote that actually carried credentials was asserted to
    // come back stripped. `safeGitRemote` still exists and still runs here,
    // feeding `git_branch` and `git_pr` output back to the model, so deleting
    // its only real exercise would have left a security-relevant sanitiser
    // covered by nothing. Review finding F10 on #479.
    //
    // The existing test above sets origin to a local path and asserts
    // `remote: null` — that proves the REJECTION arm. This proves the
    // STRIPPING arm, which is the one the function exists for.
    const root = await mkdtemp(join(tmpdir(), 'tm8-mcp-remote-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'seed\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: root });
    await execFileAsync('git', [
      'remote', 'add', 'origin', 'https://token:secret@github.com/subhangR/tm8.git',
    ], { cwd: root });

    const router = new Tm8ToolRouter(transport, { mode: 'ask', projectRoot: root });
    const result = await router.call('git_branch', {});
    expect(result.structuredContent).toMatchObject({
      remote: 'https://github.com/subhangR/tm8.git',
    });
    // Belt and braces: the secret must not survive anywhere in the payload the
    // model sees, not merely be absent from the field we happened to check.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('token:');
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

  it('builds a contract-valid artifact manifest from plain model-authored files', async () => {
    const bodies: Record<string, unknown>[] = [];
    const recording: CatalogTransport = {
      invoke: async (operation, options) => {
        if (operation === 'artifacts.create') bodies.push(options.body as Record<string, unknown>);
        return { id: 'artifact-1' };
      },
    };
    const router = new Tm8ToolRouter(recording, { mode: 'build', spaceId: 'space-a' });

    const created = await router.call('artifact_create', {
      spaceId: 'space-a',
      name: 'Harness registry prototype',
      files: [
        { path: 'styles/app.css', content: 'body{margin:0}' },
        { path: 'index.html', content: '<!doctype html><h1>hi</h1>' },
      ],
    });
    expect(created.isError).toBeUndefined();

    const body = bodies.at(-1)!;
    const manifest = ArtifactManifestSchema.parse(body.manifest);
    expect(manifest.entrypoint).toBe('index.html');
    // Byte-sorted, not author-supplied order — the server refuses to re-sort.
    expect(manifest.files.map((file) => file.path)).toEqual(['index.html', 'styles/app.css']);
    expect(manifest.files.map((file) => file.mediaType)).toEqual(['text/html', 'text/css']);

    // Every declared hash/size must describe the bytes actually shipped.
    const inline = body.files as { path: string; contentBase64: string }[];
    for (const file of manifest.files) {
      const bytes = Buffer.from(inline.find((f) => f.path === file.path)!.contentBase64, 'base64');
      expect(file.size).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('rejects artifact bundles it cannot describe honestly', async () => {
    const router = new Tm8ToolRouter(transport, { mode: 'build', spaceId: 'space-a' });
    const base = { spaceId: 'space-a', name: 'probe' };

    // No inferable entrypoint.
    await expect(router.call('artifact_create', {
      ...base, files: [{ path: 'app.js', content: 'x' }],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } });

    // Traversal path.
    await expect(router.call('artifact_create', {
      ...base, files: [{ path: '../escape.html', content: 'x' }],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } });

    // Un-inferable media type.
    await expect(router.call('artifact_create', {
      ...base, files: [{ path: 'index.html', content: 'x' }, { path: 'data.bin', content: 'x' }],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } });

    // Both bodies, or neither.
    await expect(router.call('artifact_create', {
      ...base, files: [{ path: 'index.html', content: 'x', contentBase64: 'eA==' }],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } });
  });

  it('blocks reserved IPv4/IPv6 destinations and revalidates redirects', async () => {
    const called: string[] = [];
    const dispatchers: unknown[] = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      called.push(url);
      dispatchers.push((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
      if (url === 'https://93.184.216.34/start') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    const router = new Tm8ToolRouter(transport, { mode: 'ask', fetchImpl });
    for (const url of [
      'http://100.64.0.1/', 'http://198.18.0.1/', 'http://192.0.0.1/',
      'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/',
      'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b:1::a9fe:a9fe]/',
      'http://[2002:7f00:1::]/', 'http://[2001:0:0:0:0:0:7f00:1]/',
    ]) {
      await expect(router.call('web_fetch', { url })).resolves.toMatchObject({
        isError: true, structuredContent: { error: { code: 'forbidden' } },
      });
    }
    const redirected = await router.call('web_fetch', { url: 'https://93.184.216.34/start' });
    expect(redirected).toMatchObject({ isError: true, structuredContent: { error: { code: 'forbidden' } } });
    expect(called).toEqual(['https://93.184.216.34/start']);
    expect(dispatchers[0]).toBeDefined();
  });
});
