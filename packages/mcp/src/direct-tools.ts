import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { exec, execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';

import type { CatalogTransport } from './catalog-client.js';
import { DIRECT_TOOL_NAMES, type DirectToolName } from './modes.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface DirectToolDefinition {
  name: DirectToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });
const integerProp = (description: string, minimum: number, maximum: number): Record<string, unknown> => ({
  type: 'integer', description, minimum, maximum,
});
const annotations = (readOnlyHint: boolean, destructiveHint = false, openWorldHint = false) => ({
  readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint,
});

export const DIRECT_TOOLS: readonly DirectToolDefinition[] = [
  { name: 'repo_read_file', description: 'Read a UTF-8 file from the thread project checkout.', inputSchema: objectSchema({ path: stringProp('Project-relative path.'), offset: integerProp('First 1-based line.', 1, 1_000_000), limit: integerProp('Maximum lines.', 1, 5000) }, ['path']), annotations: annotations(true) },
  { name: 'repo_glob', description: 'List project-relative files matching a glob.', inputSchema: objectSchema({ pattern: stringProp('Glob such as packages/**/*.ts.'), limit: integerProp('Maximum paths.', 1, 2000) }, ['pattern']), annotations: annotations(true) },
  { name: 'repo_grep', description: 'Search project text with a regular expression and return path/line matches.', inputSchema: objectSchema({ query: stringProp('Regular expression.'), glob: stringProp('Optional file glob.'), limit: integerProp('Maximum matches.', 1, 1000) }, ['query']), annotations: annotations(true) },
  { name: 'repo_write', description: 'Write a UTF-8 file directly in the Build checkout.', inputSchema: objectSchema({ path: stringProp('Project-relative path.'), content: stringProp('Complete new content.') }, ['path', 'content']), annotations: annotations(false, true) },
  { name: 'repo_edit', description: 'Replace exact text directly in one project file.', inputSchema: objectSchema({ path: stringProp('Project-relative path.'), oldText: stringProp('Exact text to replace.'), newText: stringProp('Replacement text.'), replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' } }, ['path', 'oldText', 'newText']), annotations: annotations(false, true) },
  { name: 'repo_multi_edit', description: 'Preflight and apply several exact repository edits.', inputSchema: objectSchema({ edits: { type: 'array', minItems: 1, maxItems: 100, items: objectSchema({ path: stringProp('Project-relative path.'), oldText: stringProp('Exact text to replace.'), newText: stringProp('Replacement text.'), replaceAll: { type: 'boolean' } }, ['path', 'oldText', 'newText']) } }, ['edits']), annotations: annotations(false, true) },
  { name: 'repo_bash', description: 'Run a bounded shell command in the Build checkout. Deployment policy may require approval.', inputSchema: objectSchema({ command: stringProp('Shell command.'), timeoutMs: integerProp('Timeout in milliseconds.', 100, 60_000) }, ['command']), annotations: annotations(false, true) },
  { name: 'session_transcript', description: 'Read the largest supported bounded worker transcript window.', inputSchema: objectSchema({ sessionId: stringProp('Work-session entity id.'), last: integerProp('Newest entries.', 1, 200) }, ['sessionId']), annotations: annotations(true) },
  { name: 'session_tail', description: 'Read the newest live transcript window for a worker session.', inputSchema: objectSchema({ sessionId: stringProp('Work-session entity id.'), last: integerProp('Newest entries.', 1, 100) }, ['sessionId']), annotations: annotations(true) },
  { name: 'session_followup', description: 'Steer a worker by posting a durable message anchored to its session.', inputSchema: objectSchema({ sessionId: stringProp('Work-session entity id.'), body: stringProp('Follow-up instruction.') }, ['sessionId', 'body']), annotations: annotations(false) },
  { name: 'session_stop', description: 'Stop a running worker session.', inputSchema: objectSchema({ sessionId: stringProp('Work-session entity id.'), force: { type: 'boolean' } }, ['sessionId']), annotations: annotations(false, true) },
  { name: 'doc_create', description: 'Create a first-class Markdown doc graph entity.', inputSchema: objectSchema({ spaceId: stringProp('Space id.'), title: stringProp('Document title.'), body: stringProp('Markdown body.'), attachTo: stringProp('Optional entity id to attach the doc to.') }, ['spaceId', 'title', 'body']), annotations: annotations(false) },
  { name: 'doc_update', description: 'Update a first-class Markdown doc under a version guard.', inputSchema: objectSchema({ docId: stringProp('Doc entity id.'), expectedVersion: integerProp('Current entity version.', 1, 1_000_000), title: stringProp('Optional replacement title.'), body: stringProp('Replacement Markdown body.') }, ['docId', 'expectedVersion', 'body']), annotations: annotations(false) },
  { name: 'artifact_create', description: 'Create a versioned static-web artifact graph entity.', inputSchema: objectSchema({ spaceId: stringProp('Space id.'), name: stringProp('Artifact name.'), description: stringProp('Optional description.'), manifest: { type: 'object', additionalProperties: true }, files: { type: 'array', items: { type: 'object', additionalProperties: true } }, sourceWorkSessionId: stringProp('Optional producing session id.') }, ['spaceId', 'name', 'manifest']), annotations: annotations(false) },
  { name: 'web_fetch', description: 'Fetch an HTTP(S) page as capped readable text.', inputSchema: objectSchema({ url: stringProp('Public HTTP(S) URL.'), maxBytes: integerProp('Maximum response bytes.', 1024, 500_000) }, ['url']), annotations: annotations(true, false, true) },
  { name: 'web_search', description: 'Search the public web and return links and snippets.', inputSchema: objectSchema({ query: stringProp('Search query.'), limit: integerProp('Maximum results.', 1, 10) }, ['query']), annotations: annotations(true, false, true) },
  { name: 'memory_write', description: 'Write a durable Space memory graph entity.', inputSchema: objectSchema({ spaceId: stringProp('Space id.'), statement: stringProp('Decision or fact to remember.'), mechanism: stringProp('How it was established.'), subjectScope: stringProp('Scope the statement applies to.'), doesNotEstablish: stringProp('Explicit boundary of the claim.') }, ['spaceId', 'statement']), annotations: annotations(false) },
  { name: 'memory_search', description: 'Search recent Space memories by words in their title/excerpt.', inputSchema: objectSchema({ spaceId: stringProp('Space id.'), query: stringProp('Words to match.'), limit: integerProp('Maximum results.', 1, 50) }, ['spaceId', 'query']), annotations: annotations(true) },
  { name: 'git_branch', description: 'Read branch, upstream, head and remote for the chat checkout.', inputSchema: objectSchema({}), annotations: annotations(true) },
  { name: 'git_status', description: 'Read git status for this chat checkout or a named worker session.', inputSchema: objectSchema({ sessionId: stringProp('Optional worker session id.') }), annotations: annotations(true) },
  { name: 'git_diff', description: 'Read a capped diff for this chat checkout or a named worker session.', inputSchema: objectSchema({ sessionId: stringProp('Optional worker session id.'), maxBytes: integerProp('Maximum diff bytes.', 1024, 500_000) }), annotations: annotations(true) },
  { name: 'git_pr', description: 'Read pull-request links connected to a worker session or derive a compare URL for the chat branch.', inputSchema: objectSchema({ sessionId: stringProp('Optional worker session id.') }), annotations: annotations(true, false, true) },
] as const;

export interface DirectToolContext {
  transport: CatalogTransport;
  projectRoot?: string;
  fetchImpl?: typeof fetch;
}

export class DirectToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DirectToolError';
  }
}

export function isDirectTool(name: string): name is DirectToolName {
  return (DIRECT_TOOL_NAMES as readonly string[]).includes(name);
}

export async function callDirectTool(
  name: DirectToolName,
  raw: unknown,
  context: DirectToolContext,
): Promise<Record<string, unknown>> {
  const args = objectOf(raw);
  switch (name) {
    case 'repo_read_file': return repoReadFile(args, context);
    case 'repo_glob': return repoGlob(args, context);
    case 'repo_grep': return repoGrep(args, context);
    case 'repo_write': return repoWrite(args, context);
    case 'repo_edit': return repoEdit(args, context);
    case 'repo_multi_edit': return repoMultiEdit(args, context);
    case 'repo_bash': return repoBash(args, context);
    case 'session_transcript': return sessionTranscript(args, context, false);
    case 'session_tail': return sessionTranscript(args, context, true);
    case 'session_followup': return sessionFollowup(args, context);
    case 'session_stop': return sessionStop(args, context);
    case 'doc_create': return docCreate(args, context);
    case 'doc_update': return docUpdate(args, context);
    case 'artifact_create': return artifactCreate(args, context);
    case 'web_fetch': return webFetch(args, context);
    case 'web_search': return webSearch(args, context);
    case 'memory_write': return memoryWrite(args, context);
    case 'memory_search': return memorySearch(args, context);
    case 'git_branch': return gitBranch(context);
    case 'git_status': return gitStatus(args, context);
    case 'git_diff': return gitDiff(args, context);
    case 'git_pr': return gitPr(args, context);
  }
}

async function repoReadFile(args: Record<string, unknown>, context: DirectToolContext) {
  const path = requiredString(args.path, 'path');
  const target = await confinedExistingPath(context, path);
  const bytes = await readFile(target);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new DirectToolError('payload_too_large', `file exceeds ${MAX_FILE_BYTES} bytes`);
  const lines = bytes.toString('utf8').split('\n');
  const offset = integer(args.offset, 'offset', 1, 1_000_000) ?? 1;
  const limit = integer(args.limit, 'limit', 1, 5000) ?? 500;
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return result('repo_read_file', { path, offset, text: selected.join('\n'), totalLines: lines.length, bytes: bytes.byteLength, truncated: offset - 1 + selected.length < lines.length });
}

async function repoGlob(args: Record<string, unknown>, context: DirectToolContext) {
  const pattern = requiredString(args.pattern, 'pattern');
  const limit = integer(args.limit, 'limit', 1, 2000) ?? 500;
  const root = await projectRoot(context);
  const run = await execFileCapped('rg', ['--files', '--hidden', '-g', '!.git/**', '-g', pattern], root, 15_000, MAX_OUTPUT_BYTES, true);
  const all = run.stdout.split('\n').filter(Boolean).sort();
  return result('repo_glob', { pattern, paths: all.slice(0, limit), truncated: all.length > limit });
}

async function repoGrep(args: Record<string, unknown>, context: DirectToolContext) {
  const query = requiredString(args.query, 'query');
  const limit = integer(args.limit, 'limit', 1, 1000) ?? 200;
  const root = await projectRoot(context);
  const argv = ['--json', '--hidden', '-g', '!.git/**'];
  const glob = optionalString(args.glob, 'glob');
  if (glob) argv.push('-g', glob);
  argv.push('--', query, '.');
  const run = await execFileCapped('rg', argv, root, 20_000, MAX_OUTPUT_BYTES, true);
  const matches: Array<Record<string, unknown>> = [];
  for (const line of run.stdout.split('\n')) {
    if (!line || matches.length >= limit) continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.type !== 'match' || !event.data) continue;
    const path = ((event.data.path as { text?: string } | undefined)?.text ?? '').replace(/^\.\//, '');
    const text = (event.data.lines as { text?: string } | undefined)?.text?.replace(/\r?\n$/, '') ?? '';
    const sub = Array.isArray(event.data.submatches) ? event.data.submatches[0] as { start?: number } : undefined;
    matches.push({ path, line: event.data.line_number, column: (sub?.start ?? 0) + 1, text });
  }
  return result('repo_grep', { query, ...(glob ? { glob } : {}), matches, truncated: matches.length >= limit });
}

async function repoWrite(args: Record<string, unknown>, context: DirectToolContext) {
  const path = requiredString(args.path, 'path');
  const content = requiredString(args.content, 'content', true);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new DirectToolError('payload_too_large', `content exceeds ${MAX_FILE_BYTES} bytes`);
  const target = await confinedWritablePath(context, path);
  let previous: string | null = null;
  try { previous = await readFile(target, 'utf8'); } catch { /* new file */ }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return result('repo_write', { path, changed: previous !== content, bytes: Buffer.byteLength(content) });
}

async function repoEdit(args: Record<string, unknown>, context: DirectToolContext) {
  const path = requiredString(args.path, 'path');
  const oldText = requiredString(args.oldText, 'oldText');
  const newText = requiredString(args.newText, 'newText', true);
  const replaceAll = boolean(args.replaceAll, 'replaceAll') ?? false;
  const target = await confinedExistingPath(context, path);
  const current = await readFile(target, 'utf8');
  const next = applyExactEdit(current, oldText, newText, replaceAll, path);
  await writeFile(target, next.text, 'utf8');
  return result('repo_edit', { path, replacements: next.replacements, bytes: Buffer.byteLength(next.text) });
}

async function repoMultiEdit(args: Record<string, unknown>, context: DirectToolContext) {
  if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 100) {
    throw new DirectToolError('invalid_input', 'edits must contain 1..100 items');
  }
  const pending = new Map<string, { target: string; text: string; replacements: number }>();
  for (const [index, rawEdit] of args.edits.entries()) {
    const edit = objectOf(rawEdit, `edits[${index}]`);
    const path = requiredString(edit.path, `edits[${index}].path`);
    const target = await confinedExistingPath(context, path);
    const current = pending.get(path)?.text ?? await readFile(target, 'utf8');
    const applied = applyExactEdit(
      current,
      requiredString(edit.oldText, `edits[${index}].oldText`),
      requiredString(edit.newText, `edits[${index}].newText`, true),
      boolean(edit.replaceAll, `edits[${index}].replaceAll`) ?? false,
      path,
    );
    pending.set(path, { target, text: applied.text, replacements: (pending.get(path)?.replacements ?? 0) + applied.replacements });
  }
  for (const entry of pending.values()) await writeFile(entry.target, entry.text, 'utf8');
  return result('repo_multi_edit', { files: [...pending.entries()].map(([path, value]) => ({ path, replacements: value.replacements, bytes: Buffer.byteLength(value.text) })) });
}

async function repoBash(args: Record<string, unknown>, context: DirectToolContext) {
  const command = requiredString(args.command, 'command');
  const timeout = integer(args.timeoutMs, 'timeoutMs', 100, 60_000) ?? 15_000;
  const root = await projectRoot(context);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8' };
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: root, timeout, maxBuffer: MAX_OUTPUT_BYTES, env, shell: '/bin/bash' });
    return result('repo_bash', { exitCode: 0, stdout: cap(stdout), stderr: cap(stderr) });
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return result('repo_bash', { exitCode: typeof value.code === 'number' ? value.code : null, killed: value.killed === true, stdout: cap(value.stdout ?? ''), stderr: cap(value.stderr ?? '') });
  }
}

async function sessionTranscript(args: Record<string, unknown>, context: DirectToolContext, tail: boolean) {
  const sessionId = requiredString(args.sessionId, 'sessionId');
  const last = integer(args.last, 'last', 1, tail ? 100 : 200) ?? (tail ? 20 : 200);
  const data = await context.transport.invoke('execution.transcript', { params: { workSessionId: sessionId }, query: { last: String(last) } });
  return result(tail ? 'session_tail' : 'session_transcript', { data });
}

async function sessionFollowup(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = requiredString(args.sessionId, 'sessionId');
  const body = requiredString(args.body, 'body');
  const data = await context.transport.invoke('messages.post', { body: { anchorIds: [sessionId], body, clientMutationId: randomUUID() } });
  return result('session_followup', { data });
}

async function sessionStop(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = requiredString(args.sessionId, 'sessionId');
  const data = await context.transport.invoke('execution.terminate', { params: { id: sessionId }, body: { force: boolean(args.force, 'force') ?? false } });
  return result('session_stop', { data });
}

async function docCreate(args: Record<string, unknown>, context: DirectToolContext) {
  const body: Record<string, unknown> = {
    spaceId: requiredString(args.spaceId, 'spaceId'), kind: 'doc',
    title: requiredString(args.title, 'title'),
    content: { kind: 'doc', body: requiredString(args.body, 'body', true), format: 'markdown' },
    clientMutationId: randomUUID(),
  };
  const attachTo = optionalString(args.attachTo, 'attachTo');
  if (attachTo) body.attachTo = { entityId: attachTo, edgeType: 'attached_to' };
  return result('doc_create', { data: await context.transport.invoke('entities.create', { body }) });
}

async function docUpdate(args: Record<string, unknown>, context: DirectToolContext) {
  const docId = requiredString(args.docId, 'docId');
  const body: Record<string, unknown> = {
    expectedVersion: requiredInteger(args.expectedVersion, 'expectedVersion', 1, 1_000_000),
    content: { kind: 'doc', body: requiredString(args.body, 'body', true), format: 'markdown' },
  };
  const title = optionalString(args.title, 'title');
  if (title) body.title = title;
  return result('doc_update', { data: await context.transport.invoke('entities.patch', { params: { id: docId }, body }) });
}

async function artifactCreate(args: Record<string, unknown>, context: DirectToolContext) {
  const body: Record<string, unknown> = {
    spaceId: requiredString(args.spaceId, 'spaceId'), name: requiredString(args.name, 'name'),
    manifest: requiredObject(args.manifest, 'manifest'), clientMutationId: randomUUID(),
  };
  for (const key of ['description', 'files', 'sourceWorkSessionId'] as const) if (args[key] !== undefined) body[key] = args[key];
  return result('artifact_create', { data: await context.transport.invoke('artifacts.create', { body }) });
}

async function webFetch(args: Record<string, unknown>, context: DirectToolContext) {
  const maxBytes = integer(args.maxBytes, 'maxBytes', 1024, 500_000) ?? 200_000;
  const fetched = await fetchPublic(requiredString(args.url, 'url'), context.fetchImpl ?? fetch, maxBytes);
  return result('web_fetch', fetched);
}

async function webSearch(args: Record<string, unknown>, context: DirectToolContext) {
  const query = requiredString(args.query, 'query');
  const limit = integer(args.limit, 'limit', 1, 10) ?? 5;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const fetched = await fetchPublic(url, context.fetchImpl ?? fetch, 300_000, false);
  const html = fetched.raw;
  const links = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results = links.slice(0, limit).map((match) => ({ url: searchResultUrl(match[1] ?? ''), title: htmlToText(match[2] ?? '') }));
  return result('web_search', { query, results, provider: 'duckduckgo-html', truncated: links.length > limit });
}

async function memoryWrite(args: Record<string, unknown>, context: DirectToolContext) {
  const statement = requiredString(args.statement, 'statement');
  const content: Record<string, unknown> = { statement };
  for (const key of ['mechanism', 'subjectScope', 'doesNotEstablish'] as const) {
    const value = optionalString(args[key], key);
    if (value) content[key] = value;
  }
  const data = await context.transport.invoke('entities.create', { body: {
    spaceId: requiredString(args.spaceId, 'spaceId'), kind: 'memory', title: statement.slice(0, 200),
    content, clientMutationId: randomUUID(),
  } });
  return result('memory_write', { data });
}

async function memorySearch(args: Record<string, unknown>, context: DirectToolContext) {
  const query = requiredString(args.query, 'query').toLowerCase();
  const limit = integer(args.limit, 'limit', 1, 50) ?? 10;
  const data = await context.transport.invoke('collections.query', { body: {
    spaceId: requiredString(args.spaceId, 'spaceId'), kinds: ['memory'], sort: 'updatedAt_desc', limit: 100,
  } });
  const page = data as { page?: { items?: Array<Record<string, unknown>> } };
  const terms = query.split(/\s+/).filter(Boolean);
  const hits = (page.page?.items ?? []).map((item) => {
    const haystack = `${String(item.title ?? '')} ${String(item.excerpt ?? '')}`.toLowerCase();
    return { item, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return result('memory_search', { query, items: hits.map((hit) => hit.item) });
}

async function gitBranch(context: DirectToolContext) {
  const root = await projectRoot(context);
  const [branch, upstream, head, remote] = await Promise.all([
    git(root, ['branch', '--show-current']), git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true),
    git(root, ['rev-parse', 'HEAD']), git(root, ['remote', 'get-url', 'origin'], true),
  ]);
  return result('git_branch', { branch: branch.trim(), upstream: upstream.trim() || null, head: head.trim(), remote: remote.trim() || null });
}

async function gitStatus(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  if (sessionId) return result('git_status', { data: await context.transport.invoke('execution.gitStatus', { params: { workSessionId: sessionId } }) });
  const root = await projectRoot(context);
  return result('git_status', { status: await git(root, ['status', '--short', '--branch']) });
}

async function gitDiff(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  const maxBytes = integer(args.maxBytes, 'maxBytes', 1024, 500_000) ?? 200_000;
  if (sessionId) return result('git_diff', { data: await context.transport.invoke('execution.gitDiff', { params: { workSessionId: sessionId }, query: { maxBytes: String(maxBytes) } }) });
  const root = await projectRoot(context);
  const diff = await git(root, ['diff', '--no-ext-diff'], true, maxBytes);
  return result('git_diff', { diff: cap(diff, maxBytes), truncated: Buffer.byteLength(diff) >= maxBytes });
}

async function gitPr(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  if (sessionId) {
    const session = await context.transport.invoke('entities.get', { params: { id: sessionId } }) as { spaceId?: unknown };
    if (typeof session.spaceId !== 'string') throw new DirectToolError('upstream_error', 'session read returned no Space id');
    const data = await context.transport.invoke('graph.query', { body: {
      spaceId: session.spaceId, focusId: sessionId, hops: 2, kinds: ['pull_request'], limit: 50,
    } });
    return result('git_pr', { data });
  }
  const root = await projectRoot(context);
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  const remote = (await git(root, ['remote', 'get-url', 'origin'], true)).trim();
  const repository = githubRepository(remote);
  return result('git_pr', { branch, remote: remote || null, pullRequestUrl: null, compareUrl: repository && branch ? `https://github.com/${repository}/compare/${encodeURIComponent(branch)}?expand=1` : null });
}

async function projectRoot(context: DirectToolContext): Promise<string> {
  if (!context.projectRoot) throw new DirectToolError('project_unavailable', 'this thread has no unambiguous linked project checkout');
  try { return await realpath(context.projectRoot); } catch { throw new DirectToolError('project_unavailable', 'the thread project checkout is unavailable'); }
}

function validateRelativePath(path: string): void {
  if (path.includes('\0') || isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new DirectToolError('invalid_input', 'path must be project-relative and may not contain ..');
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function confinedExistingPath(context: DirectToolContext, path: string): Promise<string> {
  validateRelativePath(path);
  const root = await projectRoot(context);
  const target = await realpath(resolve(root, path));
  if (!inside(root, target)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
  return target;
}

async function confinedWritablePath(context: DirectToolContext, path: string): Promise<string> {
  validateRelativePath(path);
  const root = await projectRoot(context);
  const target = resolve(root, path);
  if (!inside(root, target)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
  try {
    const existing = await realpath(target);
    if (!inside(root, existing)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
    return existing;
  } catch (error) {
    if (error instanceof DirectToolError) throw error;
    let parent = dirname(target);
    for (;;) {
      try {
        const realParent = await realpath(parent);
        if (!inside(root, realParent)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
        return target;
      } catch (parentError) {
        if (parentError instanceof DirectToolError) throw parentError;
        const next = dirname(parent);
        if (next === parent) throw new DirectToolError('forbidden', 'no confined parent exists');
        parent = next;
      }
    }
  }
}

function applyExactEdit(text: string, oldText: string, newText: string, replaceAll: boolean, path: string) {
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new DirectToolError('conflict', `oldText was not found in ${path}`);
  if (!replaceAll && count !== 1) throw new DirectToolError('conflict', `oldText occurs ${count} times in ${path}; set replaceAll or provide more context`);
  return { text: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText), replacements: replaceAll ? count : 1 };
}

async function execFileCapped(command: string, argv: string[], cwd: string, timeout: number, maxBuffer: number, allowNoMatches = false) {
  try {
    return await execFileAsync(command, argv, { cwd, timeout, maxBuffer, encoding: 'utf8' });
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string };
    if (allowNoMatches && value.code === 1) return { stdout: value.stdout ?? '', stderr: value.stderr ?? '' };
    throw new DirectToolError('tool_failed', `${command} failed: ${cap(value.stderr ?? String(error))}`);
  }
}

async function git(root: string, argv: string[], allowFailure = false, maxBuffer = MAX_OUTPUT_BYTES): Promise<string> {
  try { return (await execFileAsync('git', argv, { cwd: root, timeout: 20_000, maxBuffer, encoding: 'utf8' })).stdout; }
  catch (error) {
    if (allowFailure) return '';
    const value = error as { stderr?: string };
    throw new DirectToolError('git_failed', cap(value.stderr ?? String(error)));
  }
}

async function fetchPublic(urlText: string, fetchImpl: typeof fetch, maxBytes: number, extract = true) {
  let url: URL;
  try { url = new URL(urlText); }
  catch { throw new DirectToolError('invalid_input', 'url must be a valid absolute HTTP(S) URL'); }
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    await validatePublicUrl(url);
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'tm8-chat/1.0', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new DirectToolError('upstream_error', `redirect ${response.status} had no location`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new DirectToolError('upstream_error', `web request returned ${response.status}`, response.status >= 500);
    const bytes = await readResponseCapped(response, maxBytes);
    const raw = Buffer.from(bytes).toString('utf8');
    const contentType = response.headers.get('content-type') ?? '';
    return { url: url.toString(), status: response.status, contentType, bytes: bytes.byteLength, raw, text: extract && contentType.includes('html') ? htmlToText(raw) : raw };
  }
  throw new DirectToolError('upstream_error', 'web request exceeded the redirect limit');
}

async function readResponseCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new DirectToolError('payload_too_large', `web response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DirectToolError('payload_too_large', `web response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function validatePublicUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DirectToolError('invalid_input', 'URL must be public HTTP(S) without embedded credentials');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new DirectToolError('forbidden', 'URL resolves to a local or private address');
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}

function htmlToText(html: string): string {
  return decodeHtml(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtml(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)));
}

function searchResultUrl(href: string): string {
  const decoded = decodeHtml(href);
  try {
    const url = new URL(decoded, 'https://html.duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ?? url.toString();
  } catch {
    return decoded;
  }
}

function githubRepository(remote: string): string | null {
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function result(tool: string, data: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 'tm8.mcp.result.v1', tool, ...data };
}

function cap(value: string, bytes = MAX_OUTPUT_BYTES): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= bytes ? value : `${buffer.subarray(0, bytes).toString('utf8')}\n…truncated…`;
}

function objectOf(raw: unknown, field = 'tool arguments'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DirectToolError('invalid_input', `${field} must be an object`);
  return raw as Record<string, unknown>;
}

function requiredObject(raw: unknown, field: string): Record<string, unknown> {
  return objectOf(raw, field);
}

function requiredString(raw: unknown, field: string, emptyAllowed = false): string {
  if (typeof raw !== 'string' || (!emptyAllowed && raw.trim() === '')) throw new DirectToolError('invalid_input', `${field} must be ${emptyAllowed ? 'a string' : 'a non-empty string'}`);
  return raw;
}

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  return requiredString(raw, field);
}

function integer(raw: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < minimum || (raw as number) > maximum) throw new DirectToolError('invalid_input', `${field} must be an integer from ${minimum} to ${maximum}`);
  return raw as number;
}

function requiredInteger(raw: unknown, field: string, minimum: number, maximum: number): number {
  const value = integer(raw, field, minimum, maximum);
  if (value === undefined) throw new DirectToolError('invalid_input', `${field} is required`);
  return value;
}

function boolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new DirectToolError('invalid_input', `${field} must be a boolean`);
  return raw;
}
