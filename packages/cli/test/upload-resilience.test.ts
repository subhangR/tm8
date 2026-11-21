import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/args.js';
import { resolveContext } from '../src/context.js';
import { createOutput } from '../src/output.js';
import { ARTIFACT_COMMANDS } from '../src/commands/artifact.js';
import { FILE_COMMANDS } from '../src/commands/file.js';
import type { CommandModule } from '../src/run.js';

const SPACE = '00000000-0000-7000-8000-0000000000aa';
const UPLOAD = '00000000-0000-7000-8000-0000000000bb';
const ENTITY = '00000000-0000-7000-8000-0000000000cc';
const ROOT = '00000000-0000-7000-8000-0000000000dd';
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function drive(modules: readonly CommandModule[], argv: string[], baseUrl: string) {
  const parsed = parseInvocation(argv);
  const mod = modules.find((m) => m.path.every((part, i) => part === parsed.positionals[i]))!;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = resolveContext({ globals: parsed.globals, session: { baseUrl, spaceId: SPACE }, config: {} });
  const out = createOutput({ format: parsed.globals.format, quiet: false, streams: {
    stdout: (chunk) => { stdout.push(String(chunk)); }, stderr: (chunk) => { stderr.push(String(chunk)); },
  } });
  const code = await mod.run({ path: mod.path, args: parsed.positionals.slice(mod.path.length), options: parsed.options, passthrough: parsed.passthrough, ctx, out });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function listen(respond: (path: string, body: unknown, raw: Buffer) => { status?: number; data?: unknown; lost?: boolean; error?: unknown }) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: unknown;
      try { body = JSON.parse(raw.toString()); } catch { body = undefined; }
      const answer = respond(new URL(req.url!, 'http://test').pathname, body, raw);
      if (answer.lost) { req.socket.destroy(); return; }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.error ? { error: answer.error } : { data: answer.data ?? {}, requestId: 'retry-test' }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

describe('CLI upload recovery over HTTP', () => {
  it.each([false, true])('recovers a lost artifact receipt with one mutation (revision=%s)', async (revision) => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-publish-retry-')); dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Finished work</title>');
    const bodies: unknown[] = [];
    let created = 0;
    const baseUrl = await listen((_path, body) => {
      bodies.push(body);
      if (bodies.length === 1) { created += 1; return { lost: true }; }
      return { data: { entity: { id: ENTITY, title: 'Finished work', kind: 'artifact', version: revision ? 4 : 1 }, patches: [] } };
    });
    const args = ['artifact', 'publish', dir, '--mutation-id', ROOT, '--when-to-use', 'Open when reviewing delivery', '--summary', 'Finished bundle'];
    if (revision) args.push('--artifact', ENTITY, '--expect-version', '3');
    const result = await drive(ARTIFACT_COMMANDS, args, baseUrl);
    expect(result.code).toBe(0);
    expect(created).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({ clientMutationId: ROOT });
    expect(result.stderr).toContain('retry 2/4');
  });

  it('retries a file transfer and completion with the original grant and completion id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-file-retry-')); dirs.push(dir);
    const path = join(dir, 'result.txt'); writeFileSync(path, 'finished result');
    const completionBodies: unknown[] = [];
    const byteBodies: Buffer[] = [];
    let inits = 0;
    let aborts = 0;
    const baseUrl = await listen((url, body, raw) => {
      if (url.endsWith('/content')) {
        byteBodies.push(raw);
        return byteBodies.length === 1 ? { status: 503, error: { code: 'upstream_unavailable', message: 'try later', requestId: 'r', retryable: true } } : { status: 204 };
      }
      if (url.endsWith('/complete')) {
        completionBodies.push(body);
        if (completionBodies.length === 1) return { lost: true };
        return { data: { entity: { id: ENTITY, kind: 'file', title: 'result.txt' }, patches: [] } };
      }
      if (url.endsWith('/abort')) { aborts += 1; return {}; }
      inits += 1;
      return { data: { uploadId: UPLOAD, uploadUrl: `/v2/files/uploads/${UPLOAD}/content`, token: 'grant', expiresAt: '2030-01-01T00:00:00Z', maxSizeBytes: 1000 } };
    });
    const result = await drive(FILE_COMMANDS, ['file', 'upload', path, '--mutation-id', ROOT], baseUrl);
    expect(result.code).toBe(0);
    expect(inits).toBe(1);
    expect(aborts).toBe(0);
    expect(byteBodies).toHaveLength(2);
    expect(byteBodies[1]).toEqual(byteBodies[0]);
    expect(completionBodies).toHaveLength(2);
    expect(completionBodies[1]).toEqual(completionBodies[0]);
  });
});
