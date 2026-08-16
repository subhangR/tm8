import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { exec, execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { glob as globFiles } from 'tinyglobby';
import { Agent } from 'undici';

import type { CatalogTransport } from './catalog-client.js';
import { DIRECT_TOOL_NAMES, type DirectToolName } from './modes.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_GREP_SCAN_BYTES = 50 * 1024 * 1024;
const MAX_GREP_FILE_MS = 1_000;
const MAX_GREP_TOTAL_MS = 5_000;
const MAX_GREP_LINE_CHARS = 16_384;
const MAX_GREP_RESULT_CHARS = 4_096;
const MAX_EXPLANATION_BYTES = 128 * 1024;
const MAX_EXPLANATION_LINES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const GREP_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const expression = new RegExp(workerData.query);
  parentPort.on('message', ({ text, limit }) => {
    const matches = [];
    let inputTruncated = false;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
      const line = lines[index];
      const candidate = line.length > workerData.maxLineChars
        ? line.slice(0, workerData.maxLineChars)
        : line;
      inputTruncated ||= candidate.length !== line.length;
      expression.lastIndex = 0;
      const match = expression.exec(candidate);
      if (!match) continue;
      const clean = line.replace(/\r$/, '');
      matches.push({
        line: index + 1,
        column: (match.index || 0) + 1,
        text: clean.slice(0, workerData.maxResultChars),
        textTruncated: clean.length > workerData.maxResultChars,
      });
    }
    parentPort.postMessage({ matches, inputTruncated });
  });
`;

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
  {
    name: 'explain_diagram',
    description: 'Present a bounded Mermaid diagram inline in Chat. This does not create a durable entity; use doc_create for a durable diagram.',
    inputSchema: objectSchema({
      title: stringProp('Short visible diagram title.'),
      source: stringProp('Mermaid source. Do not wrap it in a Markdown fence.'),
      caption: stringProp('Optional explanation below the diagram.'),
    }, ['title', 'source']),
    annotations: annotations(true),
  },
  {
    name: 'explain_graph',
    description: 'Present a focused node-edge explanation inline. Persisted edges must carry real tm8 edge ids and are verified; inferred edges are drawn distinctly.',
    inputSchema: objectSchema({
      title: stringProp('Short visible graph title.'),
      caption: stringProp('Optional explanation below the graph.'),
      focusNodeId: stringProp('Optional local node id to place at the center.'),
      nodes: {
        type: 'array', minItems: 1, maxItems: 16,
        items: objectSchema({
          id: stringProp('Local id used by edges in this presentation.'),
          label: stringProp('Visible node label.'),
          description: stringProp('Optional short node description.'),
          entityId: stringProp('Optional real tm8 entity id. Real entities are clickable.'),
          kind: stringProp('Optional tm8 entity kind or concept kind label.'),
        }, ['id', 'label']),
      },
      edges: {
        type: 'array', maxItems: 32,
        items: objectSchema({
          from: stringProp('Source local node id.'),
          to: stringProp('Target local node id.'),
          label: stringProp('Visible relationship label.'),
          basis: { type: 'string', enum: ['persisted', 'inferred'], description: 'Whether this is a stored tm8 edge or an explanatory inference.' },
          edgeId: stringProp('Required for persisted links: the real tm8 edge id.'),
          relationshipType: stringProp('Required for persisted links: the stored tm8 edge type.'),
        }, ['from', 'to', 'label', 'basis']),
      },
    }, ['title', 'nodes', 'edges']),
    annotations: annotations(true),
  },
  {
    name: 'explain_code',
    description: 'Present an exact repository excerpt or clearly-labelled illustrative code inline with line numbers, syntax colour, highlights and annotations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: stringProp('Optional visible title.'),
        path: stringProp('Project-relative repository path. Supply path or code, never both.'),
        code: stringProp('Illustrative source text. Supply code or path, never both.'),
        language: stringProp('Optional syntax language; inferred from path when omitted.'),
        startLine: integerProp('First repository line, or first displayed illustrative line.', 1, 1_000_000),
        endLine: integerProp('Last repository line. At most 500 lines are displayed.', 1, 1_000_000),
        highlights: {
          type: 'array', maxItems: 24,
          items: objectSchema({
            startLine: integerProp('First highlighted displayed line.', 1, 1_000_000),
            endLine: integerProp('Last highlighted displayed line.', 1, 1_000_000),
            label: stringProp('Optional annotation shown with the range.'),
            tone: { type: 'string', enum: ['focus', 'note', 'warning'] },
          }, ['startLine', 'endLine']),
        },
      },
      oneOf: [{ required: ['path'] }, { required: ['code'] }],
      additionalProperties: false,
    },
    annotations: annotations(true),
  },
  {
    name: 'explain_asset',
    description: 'Present a same-Space tm8 file inline as a safe image/media preview or downloadable file card.',
    inputSchema: objectSchema({
      fileEntityId: stringProp('Real tm8 file entity id in this Chat Space.'),
      title: stringProp('Optional visible title; defaults to the stored filename.'),
      caption: stringProp('Optional explanation below the asset.'),
      alt: stringProp('Accessible alternative text; defaults to the stored filename.'),
    }, ['fileEntityId']),
    annotations: annotations(true),
  },
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
  spaceId?: string;
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
    case 'explain_diagram': return explainDiagram(args);
    case 'explain_graph': return explainGraph(args, context);
    case 'explain_code': return explainCode(args, context);
    case 'explain_asset': return explainAsset(args, context);
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
  const bytes = await readFileCapped(target);
  const lines = bytes.toString('utf8').split('\n');
  const offset = integer(args.offset, 'offset', 1, 1_000_000) ?? 1;
  const limit = integer(args.limit, 'limit', 1, 5000) ?? 500;
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return result('repo_read_file', { path, offset, text: selected.join('\n'), totalLines: lines.length, bytes: bytes.byteLength, truncated: offset - 1 + selected.length < lines.length });
}

async function repoGlob(args: Record<string, unknown>, context: DirectToolContext) {
  const pattern = requiredString(args.pattern, 'pattern');
  validateGlobPattern(pattern, 'pattern');
  const limit = integer(args.limit, 'limit', 1, 2000) ?? 500;
  const root = await projectRoot(context);
  const all = (await globFiles(pattern, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['.git/**'],
  })).sort();
  return result('repo_glob', { pattern, paths: all.slice(0, limit), truncated: all.length > limit });
}

async function repoGrep(args: Record<string, unknown>, context: DirectToolContext) {
  const query = requiredString(args.query, 'query');
  const limit = integer(args.limit, 'limit', 1, 1000) ?? 200;
  const root = await projectRoot(context);
  const glob = optionalString(args.glob, 'glob');
  if (glob) validateGlobPattern(glob, 'glob');
  try { new RegExp(query); }
  catch { throw new DirectToolError('invalid_input', 'query must be a valid JavaScript regular expression'); }
  const paths = (await globFiles(glob ?? '**/*', {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['.git/**'],
  })).sort();
  const matches: Array<Record<string, unknown>> = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  let truncated = false;
  const deadline = Date.now() + MAX_GREP_TOTAL_MS;
  const worker = new Worker(GREP_WORKER_SOURCE, {
    eval: true,
    workerData: { query, maxLineChars: MAX_GREP_LINE_CHARS, maxResultChars: MAX_GREP_RESULT_CHARS },
  });
  try {
    for (const path of paths) {
      if (matches.length >= limit || scannedBytes >= MAX_GREP_SCAN_BYTES) { truncated = true; break; }
      const target = await confinedExistingPath(context, path);
      let bytes: Buffer;
      try { bytes = await readFileCapped(target); }
      catch (error) {
        if (error instanceof DirectToolError && error.code === 'payload_too_large') { truncated = true; continue; }
        throw error;
      }
      scannedFiles += 1;
      scannedBytes += bytes.byteLength;
      if (bytes.includes(0)) continue;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) { truncated = true; break; }
      const scanned = await grepWorkerFile(
        worker,
        bytes.toString('utf8'),
        limit - matches.length,
        Math.min(MAX_GREP_FILE_MS, remainingMs),
      );
      truncated ||= scanned.inputTruncated;
      matches.push(...scanned.matches.map((match) => ({ path, ...match })));
      if (matches.length >= limit) { truncated = true; break; }
    }
  } finally {
    await worker.terminate();
  }
  return result('repo_grep', { query, ...(glob ? { glob } : {}), matches, scannedFiles, scannedBytes, truncated });
}

interface GrepWorkerResult {
  matches: Array<{ line: number; column: number; text: string; textTruncated: boolean }>;
  inputTruncated: boolean;
}

async function grepWorkerFile(
  worker: Worker,
  text: string,
  limit: number,
  timeoutMs: number,
): Promise<GrepWorkerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (value: GrepWorkerResult): void => { cleanup(); resolvePromise(value); };
    const onError = (): void => {
      cleanup();
      rejectPromise(new DirectToolError('tool_failed', 'repo_grep worker failed'));
    };
    const onExit = (code: number): void => {
      cleanup();
      rejectPromise(new DirectToolError('tool_failed', `repo_grep worker exited before producing a result (${code})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new DirectToolError('tool_timeout', 'repo_grep regular expression exceeded its execution budget', true));
    }, timeoutMs);
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.postMessage({ text, limit });
  });
}

async function repoWrite(args: Record<string, unknown>, context: DirectToolContext) {
  const path = requiredString(args.path, 'path');
  const content = requiredString(args.content, 'content', true);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new DirectToolError('payload_too_large', `content exceeds ${MAX_FILE_BYTES} bytes`);
  const target = await confinedWritablePath(context, path);
  let previous: string | null = null;
  try { previous = (await readFileCapped(target)).toString('utf8'); }
  catch (error) { if (!isNotFound(error)) throw error; }
  await mkdir(dirname(target), { recursive: true });
  await writeFileNoFollow(target, content);
  return result('repo_write', { path, changed: previous !== content, bytes: Buffer.byteLength(content) });
}

async function repoEdit(args: Record<string, unknown>, context: DirectToolContext) {
  const path = requiredString(args.path, 'path');
  const oldText = requiredString(args.oldText, 'oldText');
  const newText = requiredString(args.newText, 'newText', true);
  const replaceAll = boolean(args.replaceAll, 'replaceAll') ?? false;
  const target = await confinedWritablePath(context, path);
  const current = (await readFileCapped(target)).toString('utf8');
  const next = applyExactEdit(current, oldText, newText, replaceAll, path);
  assertFileSize(next.text);
  await writeFileNoFollow(target, next.text);
  return result('repo_edit', { path, replacements: next.replacements, bytes: Buffer.byteLength(next.text) });
}

interface PendingRepoEdit {
  path: string;
  target: string;
  original: string;
  text: string;
  replacements: number;
}

async function repoMultiEdit(args: Record<string, unknown>, context: DirectToolContext) {
  if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 100) {
    throw new DirectToolError('invalid_input', 'edits must contain 1..100 items');
  }
  const pending = new Map<string, PendingRepoEdit>();
  for (const [index, rawEdit] of args.edits.entries()) {
    const edit = objectOf(rawEdit, `edits[${index}]`);
    const path = requiredString(edit.path, `edits[${index}].path`);
    const target = await confinedWritablePath(context, path);
    const existing = pending.get(target);
    const original = existing?.original ?? (await readFileCapped(target)).toString('utf8');
    const current = existing?.text ?? original;
    const applied = applyExactEdit(
      current,
      requiredString(edit.oldText, `edits[${index}].oldText`),
      requiredString(edit.newText, `edits[${index}].newText`, true),
      boolean(edit.replaceAll, `edits[${index}].replaceAll`) ?? false,
      path,
    );
    assertFileSize(applied.text);
    pending.set(target, {
      path: existing?.path ?? path,
      target,
      original,
      text: applied.text,
      replacements: (existing?.replacements ?? 0) + applied.replacements,
    });
  }
  const written: PendingRepoEdit[] = [];
  try {
    for (const entry of pending.values()) {
      await writeFileNoFollow(entry.target, entry.text);
      written.push(entry);
    }
  } catch {
    await Promise.allSettled(written.map((entry) => writeFileNoFollow(entry.target, entry.original)));
    throw new DirectToolError('tool_failed', 'multi-edit commit failed; completed writes were rolled back');
  }
  return result('repo_multi_edit', { files: [...pending.values()].map((value) => ({ path: value.path, replacements: value.replacements, bytes: Buffer.byteLength(value.text) })) });
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
  await confinedEntity(context, sessionId, 'work_session');
  const last = integer(args.last, 'last', 1, tail ? 100 : 200) ?? (tail ? 20 : 200);
  const data = await context.transport.invoke('execution.transcript', { params: { workSessionId: sessionId }, query: { last: String(last) } });
  return result(tail ? 'session_tail' : 'session_transcript', { data });
}

async function sessionFollowup(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = requiredString(args.sessionId, 'sessionId');
  const body = requiredString(args.body, 'body');
  await confinedEntity(context, sessionId, 'work_session');
  const data = await context.transport.invoke('messages.post', { body: { anchorIds: [sessionId], body, clientMutationId: randomUUID() } });
  return result('session_followup', { data });
}

async function sessionStop(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = requiredString(args.sessionId, 'sessionId');
  await confinedEntity(context, sessionId, 'work_session');
  const data = await context.transport.invoke('execution.terminate', { params: { id: sessionId }, body: { force: boolean(args.force, 'force') ?? false } });
  return result('session_stop', { data });
}

function explainDiagram(args: Record<string, unknown>) {
  const source = boundedString(args.source, 'source', MAX_EXPLANATION_BYTES);
  const caption = optionalBoundedString(args.caption, 'caption', 2_000);
  if (source.includes('```')) {
    throw new DirectToolError('invalid_input', 'source must be bare Mermaid syntax without a Markdown fence');
  }
  return result('explain_diagram', {
    presentation: 'mermaid',
    title: boundedString(args.title, 'title', 200),
    source,
    ...(caption ? { caption } : {}),
  });
}

interface ExplanationGraphNode {
  id: string;
  label: string;
  description?: string;
  entityId?: string;
  kind?: string;
}

interface ExplanationGraphEdge {
  from: string;
  to: string;
  label: string;
  basis: 'persisted' | 'inferred';
  edgeId?: string;
  relationshipType?: string;
}

async function explainGraph(args: Record<string, unknown>, context: DirectToolContext) {
  const nodeRows = boundedArray(args.nodes, 'nodes', 1, 16);
  const edgeRows = boundedArray(args.edges, 'edges', 0, 32);
  const nodes: ExplanationGraphNode[] = nodeRows.map((raw, index) => {
    const node = objectOf(raw, `nodes[${index}]`);
    const entityId = optionalBoundedString(node.entityId, `nodes[${index}].entityId`, 100);
    const description = optionalBoundedString(node.description, `nodes[${index}].description`, 500);
    const kind = optionalBoundedString(node.kind, `nodes[${index}].kind`, 80);
    if (entityId && !UUID.test(entityId)) {
      throw new DirectToolError('invalid_input', `nodes[${index}].entityId must be a UUID`);
    }
    return {
      id: boundedString(node.id, `nodes[${index}].id`, 80),
      label: boundedString(node.label, `nodes[${index}].label`, 160),
      ...(description ? { description } : {}),
      ...(entityId ? { entityId } : {}),
      ...(kind ? { kind } : {}),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new DirectToolError('invalid_input', 'graph node ids must be unique');

  const focusNodeId = optionalBoundedString(args.focusNodeId, 'focusNodeId', 80);
  const caption = optionalBoundedString(args.caption, 'caption', 2_000);
  if (focusNodeId && !byId.has(focusNodeId)) {
    throw new DirectToolError('invalid_input', 'focusNodeId must name one of the graph nodes');
  }

  const edges: ExplanationGraphEdge[] = edgeRows.map((raw, index) => {
    const edge = objectOf(raw, `edges[${index}]`);
    const from = boundedString(edge.from, `edges[${index}].from`, 80);
    const to = boundedString(edge.to, `edges[${index}].to`, 80);
    if (!byId.has(from) || !byId.has(to)) {
      throw new DirectToolError('invalid_input', `edges[${index}] must reference existing node ids`);
    }
    if (edge.basis !== 'persisted' && edge.basis !== 'inferred') {
      throw new DirectToolError('invalid_input', `edges[${index}].basis must be persisted or inferred`);
    }
    const edgeId = optionalBoundedString(edge.edgeId, `edges[${index}].edgeId`, 100);
    const relationshipType = optionalBoundedString(
      edge.relationshipType,
      `edges[${index}].relationshipType`,
      100,
    );
    if (edge.basis === 'persisted' && (!edgeId || !UUID.test(edgeId) || !relationshipType)) {
      throw new DirectToolError(
        'invalid_input',
        `edges[${index}] marked persisted must include a UUID edgeId and relationshipType`,
      );
    }
    return {
      from,
      to,
      label: boundedString(edge.label, `edges[${index}].label`, 120),
      basis: edge.basis,
      ...(edgeId ? { edgeId } : {}),
      ...(relationshipType ? { relationshipType } : {}),
    };
  });

  await Promise.all(nodes.flatMap((node) => node.entityId
    ? [confinedEntity(context, node.entityId)]
    : []));
  await Promise.all(edges.flatMap((edge, index) => edge.basis === 'persisted'
    ? [verifyPersistedExplanationEdge(context, byId, edge, index)]
    : []));

  return result('explain_graph', {
    presentation: 'focused_graph',
    title: boundedString(args.title, 'title', 200),
    ...(caption ? { caption } : {}),
    ...(focusNodeId ? { focusNodeId } : {}),
    nodes,
    edges,
  });
}

async function verifyPersistedExplanationEdge(
  context: DirectToolContext,
  nodes: ReadonlyMap<string, ExplanationGraphNode>,
  edge: ExplanationGraphEdge,
  index: number,
): Promise<void> {
  const sourceId = nodes.get(edge.from)?.entityId;
  const targetId = nodes.get(edge.to)?.entityId;
  if (!sourceId || !targetId || !edge.edgeId || !edge.relationshipType) {
    throw new DirectToolError(
      'invalid_input',
      `edges[${index}] marked persisted must connect two real tm8 entity nodes`,
    );
  }
  const page = await context.transport.invoke('entities.connections', {
    params: { id: sourceId },
    query: {
      direction: 'outgoing',
      peerId: targetId,
      type: edge.relationshipType,
      limit: '50',
    },
  }) as { items?: Array<{ id?: unknown; type?: unknown; source?: { id?: unknown }; target?: { id?: unknown } }> };
  const verified = page.items?.some((candidate) => (
    candidate.id === edge.edgeId
    && candidate.type === edge.relationshipType
    && candidate.source?.id === sourceId
    && candidate.target?.id === targetId
  ));
  if (!verified) {
    throw new DirectToolError(
      'conflict',
      `edges[${index}] is marked persisted but no matching tm8 edge is visible in this Space`,
    );
  }
}

interface CodeHighlight {
  startLine: number;
  endLine: number;
  label?: string;
  tone: 'focus' | 'note' | 'warning';
}

async function explainCode(args: Record<string, unknown>, context: DirectToolContext) {
  const path = optionalBoundedString(args.path, 'path', 4_096);
  const suppliedCode = args.code === undefined
    ? undefined
    : boundedString(args.code, 'code', MAX_EXPLANATION_BYTES, true);
  if ((path ? 1 : 0) + (suppliedCode !== undefined ? 1 : 0) !== 1) {
    throw new DirectToolError('invalid_input', 'supply exactly one of path or code');
  }

  if (path) {
    const target = await confinedExistingPath(context, path);
    const bytes = await readFileCapped(target);
    if (bytes.includes(0)) throw new DirectToolError('invalid_input', 'path must name a UTF-8 text file');
    const lines = bytes.toString('utf8').split('\n');
    const startLine = integer(args.startLine, 'startLine', 1, 1_000_000) ?? 1;
    if (startLine > lines.length) throw new DirectToolError('invalid_input', 'startLine is past the end of the file');
    const requestedEnd = integer(args.endLine, 'endLine', 1, 1_000_000)
      ?? Math.min(lines.length, startLine + 199);
    if (requestedEnd < startLine || requestedEnd - startLine + 1 > MAX_EXPLANATION_LINES) {
      throw new DirectToolError('invalid_input', `code range must contain 1-${MAX_EXPLANATION_LINES} lines`);
    }
    const endLine = Math.min(requestedEnd, lines.length);
    const code = lines.slice(startLine - 1, endLine).join('\n');
    if (Buffer.byteLength(code) > MAX_EXPLANATION_BYTES) {
      throw new DirectToolError('payload_too_large', `code excerpt exceeds ${MAX_EXPLANATION_BYTES} bytes`);
    }
    return result('explain_code', {
      presentation: 'code',
      sourceKind: 'repository',
      title: optionalBoundedString(args.title, 'title', 200) ?? basename(path),
      path,
      language: optionalBoundedString(args.language, 'language', 80) ?? languageForPath(path),
      code,
      startLine,
      endLine,
      totalLines: lines.length,
      highlights: normalizeCodeHighlights(args.highlights, startLine, endLine),
    });
  }

  const code = suppliedCode ?? '';
  const codeLines = code.split('\n').length;
  if (codeLines > MAX_EXPLANATION_LINES) {
    throw new DirectToolError('payload_too_large', `illustrative code exceeds ${MAX_EXPLANATION_LINES} lines`);
  }
  const startLine = integer(args.startLine, 'startLine', 1, 1_000_000) ?? 1;
  const endLine = startLine + codeLines - 1;
  return result('explain_code', {
    presentation: 'code',
    sourceKind: 'illustrative',
    title: optionalBoundedString(args.title, 'title', 200) ?? 'Illustrative code',
    language: optionalBoundedString(args.language, 'language', 80) ?? 'text',
    code,
    startLine,
    endLine,
    totalLines: codeLines,
    highlights: normalizeCodeHighlights(args.highlights, startLine, endLine),
  });
}

function normalizeCodeHighlights(raw: unknown, firstLine: number, lastLine: number): CodeHighlight[] {
  return boundedArray(raw ?? [], 'highlights', 0, 24).map((item, index) => {
    const row = objectOf(item, `highlights[${index}]`);
    const startLine = requiredInteger(row.startLine, `highlights[${index}].startLine`, 1, 1_000_000);
    const endLine = requiredInteger(row.endLine, `highlights[${index}].endLine`, 1, 1_000_000);
    if (startLine > endLine || startLine < firstLine || endLine > lastLine) {
      throw new DirectToolError(
        'invalid_input',
        `highlights[${index}] must fall inside displayed lines ${firstLine}-${lastLine}`,
      );
    }
    if (row.tone !== undefined && !['focus', 'note', 'warning'].includes(String(row.tone))) {
      throw new DirectToolError('invalid_input', `highlights[${index}].tone is invalid`);
    }
    const label = optionalBoundedString(row.label, `highlights[${index}].label`, 500);
    return {
      startLine,
      endLine,
      ...(label ? { label } : {}),
      tone: (row.tone as CodeHighlight['tone'] | undefined) ?? 'focus',
    };
  });
}

async function explainAsset(args: Record<string, unknown>, context: DirectToolContext) {
  const fileEntityId = boundedString(args.fileEntityId, 'fileEntityId', 100);
  if (!UUID.test(fileEntityId)) throw new DirectToolError('invalid_input', 'fileEntityId must be a UUID');
  const detail = await confinedEntityDetail(context, fileEntityId, 'file');
  const content = objectOf(detail.content, 'file content');
  const name = boundedString(content.name, 'file content.name', 1_000);
  const mimeType = boundedString(content.mimeType, 'file content.mimeType', 200);
  const sizeBytes = requiredInteger(content.sizeBytes, 'file content.sizeBytes', 0, Number.MAX_SAFE_INTEGER);
  const caption = optionalBoundedString(args.caption, 'caption', 2_000);
  return result('explain_asset', {
    presentation: 'asset',
    fileEntityId,
    name,
    mimeType,
    sizeBytes,
    title: optionalBoundedString(args.title, 'title', 200) ?? name,
    alt: optionalBoundedString(args.alt, 'alt', 500) ?? name,
    ...(caption ? { caption } : {}),
  });
}

function languageForPath(path: string): string {
  return ({
    '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.css': 'css', '.go': 'go', '.html': 'html',
    '.java': 'java', '.js': 'javascript', '.jsx': 'jsx', '.json': 'json', '.md': 'markdown',
    '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.sh': 'shell', '.sql': 'sql',
    '.ts': 'typescript', '.tsx': 'tsx', '.yaml': 'yaml', '.yml': 'yaml',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'text';
}

async function docCreate(args: Record<string, unknown>, context: DirectToolContext) {
  const spaceId = requiredString(args.spaceId, 'spaceId');
  assertThreadSpace(context, spaceId);
  const body: Record<string, unknown> = {
    spaceId, kind: 'doc',
    title: requiredString(args.title, 'title'),
    content: { kind: 'doc', body: requiredString(args.body, 'body', true), format: 'markdown' },
    clientMutationId: randomUUID(),
  };
  const attachTo = optionalString(args.attachTo, 'attachTo');
  if (attachTo) {
    await confinedEntity(context, attachTo);
    body.attachTo = { entityId: attachTo, edgeType: 'attached_to' };
  }
  return result('doc_create', { data: await context.transport.invoke('entities.create', { body }) });
}

async function docUpdate(args: Record<string, unknown>, context: DirectToolContext) {
  const docId = requiredString(args.docId, 'docId');
  await confinedEntity(context, docId, 'doc');
  const body: Record<string, unknown> = {
    expectedVersion: requiredInteger(args.expectedVersion, 'expectedVersion', 1, 1_000_000),
    content: { kind: 'doc', body: requiredString(args.body, 'body', true), format: 'markdown' },
  };
  const title = optionalString(args.title, 'title');
  if (title) body.title = title;
  return result('doc_update', { data: await context.transport.invoke('entities.patch', { params: { id: docId }, body }) });
}

async function artifactCreate(args: Record<string, unknown>, context: DirectToolContext) {
  const spaceId = requiredString(args.spaceId, 'spaceId');
  assertThreadSpace(context, spaceId);
  const body: Record<string, unknown> = {
    spaceId, name: requiredString(args.name, 'name'),
    manifest: requiredObject(args.manifest, 'manifest'), clientMutationId: randomUUID(),
  };
  for (const key of ['description', 'files', 'sourceWorkSessionId'] as const) if (args[key] !== undefined) body[key] = args[key];
  const sourceWorkSessionId = optionalString(args.sourceWorkSessionId, 'sourceWorkSessionId');
  if (sourceWorkSessionId) await confinedEntity(context, sourceWorkSessionId, 'work_session');
  return result('artifact_create', { data: await context.transport.invoke('artifacts.create', { body }) });
}

async function webFetch(args: Record<string, unknown>, context: DirectToolContext) {
  const maxBytes = integer(args.maxBytes, 'maxBytes', 1024, 500_000) ?? 200_000;
  const fetched = await fetchPublic(requiredString(args.url, 'url'), context.fetchImpl ?? fetch, maxBytes, true);
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
  const spaceId = requiredString(args.spaceId, 'spaceId');
  assertThreadSpace(context, spaceId);
  const content: Record<string, unknown> = { statement };
  for (const key of ['mechanism', 'subjectScope', 'doesNotEstablish'] as const) {
    const value = optionalString(args[key], key);
    if (value) content[key] = value;
  }
  const data = await context.transport.invoke('entities.create', { body: {
    spaceId, kind: 'memory', title: statement.slice(0, 200),
    content, clientMutationId: randomUUID(),
  } });
  return result('memory_write', { data });
}

async function memorySearch(args: Record<string, unknown>, context: DirectToolContext) {
  const query = requiredString(args.query, 'query').toLowerCase();
  const limit = integer(args.limit, 'limit', 1, 50) ?? 10;
  const spaceId = requiredString(args.spaceId, 'spaceId');
  assertThreadSpace(context, spaceId);
  const data = await context.transport.invoke('collections.query', { body: {
    spaceId, kinds: ['memory'], sort: 'updatedAt_desc', limit: 100,
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
  return result('git_branch', {
    branch: branch.trim(), upstream: upstream.trim() || null, head: head.trim(),
    remote: safeGitRemote(remote.trim()),
  });
}

async function gitStatus(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  if (sessionId) {
    await confinedEntity(context, sessionId, 'work_session');
    return result('git_status', { data: await context.transport.invoke('execution.gitStatus', { params: { workSessionId: sessionId } }) });
  }
  const root = await projectRoot(context);
  return result('git_status', { status: await git(root, ['status', '--short', '--branch']) });
}

async function gitDiff(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  const maxBytes = integer(args.maxBytes, 'maxBytes', 1024, 500_000) ?? 200_000;
  if (sessionId) {
    await confinedEntity(context, sessionId, 'work_session');
    return result('git_diff', { data: await context.transport.invoke('execution.gitDiff', { params: { workSessionId: sessionId }, query: { maxBytes: String(maxBytes) } }) });
  }
  const root = await projectRoot(context);
  const diff = await spawnOutputCapped('git', hardenedGitArgs(['diff', '--no-ext-diff']), root, 20_000, maxBytes);
  return result('git_diff', { diff: diff.stdout, truncated: diff.truncated });
}

async function gitPr(args: Record<string, unknown>, context: DirectToolContext) {
  const sessionId = optionalString(args.sessionId, 'sessionId');
  if (sessionId) {
    const session = await confinedEntity(context, sessionId, 'work_session');
    const data = await context.transport.invoke('graph.query', { body: {
      spaceId: session.spaceId, focusId: sessionId, hops: 2, kinds: ['pull_request'], limit: 50,
    } });
    return result('git_pr', { data });
  }
  const root = await projectRoot(context);
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  const remote = (await git(root, ['remote', 'get-url', 'origin'], true)).trim();
  const safeRemote = safeGitRemote(remote);
  const repository = githubRepository(safeRemote ?? '');
  return result('git_pr', { branch, remote: safeRemote, pullRequestUrl: null, compareUrl: repository && branch ? `https://github.com/${repository}/compare/${encodeURIComponent(branch)}?expand=1` : null });
}

function assertThreadSpace(context: DirectToolContext, spaceId: string): void {
  if (!context.spaceId) throw new DirectToolError('thread_scope_unavailable', 'thread Space scope is unavailable');
  if (spaceId !== context.spaceId) throw new DirectToolError('forbidden', 'target is outside the chat thread Space');
}

async function confinedEntity(
  context: DirectToolContext,
  entityId: string,
  expectedKind?: string,
): Promise<{ id: string; kind: string; spaceId: string }> {
  const data = await confinedEntityDetail(context, entityId, expectedKind);
  return { id: data.id as string, kind: data.kind as string, spaceId: data.spaceId as string };
}

async function confinedEntityDetail(
  context: DirectToolContext,
  entityId: string,
  expectedKind?: string,
): Promise<Record<string, unknown> & { id: string; kind: string; spaceId: string }> {
  const data = await context.transport.invoke('entities.get', { params: { id: entityId } }) as {
    id?: unknown;
    kind?: unknown;
    spaceId?: unknown;
    [key: string]: unknown;
  };
  if (typeof data.id !== 'string' || typeof data.kind !== 'string' || typeof data.spaceId !== 'string') {
    throw new DirectToolError('upstream_error', 'entity scope check returned an invalid result');
  }
  assertThreadSpace(context, data.spaceId);
  if (expectedKind && data.kind !== expectedKind) {
    throw new DirectToolError('invalid_input', `target must be a ${expectedKind} entity`);
  }
  return data as Record<string, unknown> & { id: string; kind: string; spaceId: string };
}

async function projectRoot(context: DirectToolContext): Promise<string> {
  if (!context.projectRoot) throw new DirectToolError('project_unavailable', 'this thread has no unambiguous linked project checkout');
  try { return await realpath(context.projectRoot); } catch { throw new DirectToolError('project_unavailable', 'the thread project checkout is unavailable'); }
}

function validateRelativePath(path: string): void {
  const components = path.split(/[\\/]+/);
  if (path.includes('\0') || isAbsolute(path) || components.includes('..') || components.includes('.git')) {
    throw new DirectToolError('invalid_input', 'path must be project-relative and may not contain .. or .git');
  }
}

function validateGlobPattern(pattern: string, field: string): void {
  if (pattern.startsWith('!') || pattern.includes('\0') || isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new DirectToolError('invalid_input', `${field} must be a non-negated project-relative glob`);
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
  await refuseSymlinkComponents(root, target);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || info.nlink > 1) throw new DirectToolError('forbidden', 'writes through links are not allowed');
    const existing = await realpath(target);
    if (!inside(root, existing)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
    return existing;
  } catch (error) {
    if (error instanceof DirectToolError) throw error;
    if (!isNotFound(error)) throw error;
    let parent = dirname(target);
    for (;;) {
      try {
        const realParent = await realpath(parent);
        if (!inside(root, realParent)) throw new DirectToolError('forbidden', 'path escapes the project checkout');
        return resolve(realParent, relative(parent, target));
      } catch (parentError) {
        if (parentError instanceof DirectToolError) throw parentError;
        if (!isNotFound(parentError)) throw parentError;
        const next = dirname(parent);
        if (next === parent) throw new DirectToolError('forbidden', 'no confined parent exists');
        parent = next;
      }
    }
  }
}

async function refuseSymlinkComponents(root: string, target: string): Promise<void> {
  const suffix = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const component of suffix) {
    current = resolve(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new DirectToolError('forbidden', 'writes through symlinks are not allowed');
    } catch (error) {
      if (error instanceof DirectToolError) throw error;
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function readFileCapped(path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new DirectToolError('payload_too_large', `file exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function writeFileNoFollow(path: string, content: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o666);
  try { await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}

function assertFileSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new DirectToolError('payload_too_large', `edited file exceeds ${MAX_FILE_BYTES} bytes`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function applyExactEdit(text: string, oldText: string, newText: string, replaceAll: boolean, path: string) {
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new DirectToolError('conflict', `oldText was not found in ${path}`);
  if (!replaceAll && count !== 1) throw new DirectToolError('conflict', `oldText occurs ${count} times in ${path}; set replaceAll or provide more context`);
  return { text: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText), replacements: replaceAll ? count : 1 };
}

async function git(root: string, argv: string[], allowFailure = false, maxBuffer = MAX_OUTPUT_BYTES): Promise<string> {
  try { return (await execFileAsync('git', hardenedGitArgs(argv), { cwd: root, timeout: 20_000, maxBuffer, encoding: 'utf8' })).stdout; }
  catch (error) {
    if (allowFailure) return '';
    throw new DirectToolError('git_failed', 'git command failed');
  }
}

function hardenedGitArgs(argv: string[]): string[] {
  return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv];
}

async function spawnOutputCapped(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderrBytes = 0;
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (raw: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - bytes;
      if (raw.byteLength > remaining) {
        if (remaining > 0) chunks.push(raw.subarray(0, remaining));
        bytes += Math.max(remaining, 0);
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(raw);
      bytes += raw.byteLength;
    });
    child.stderr.on('data', (raw: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      const selected = raw.subarray(0, 64 * 1024 - stderrBytes);
      stderr.push(selected);
      stderrBytes += selected.byteLength;
    });
    child.once('error', () => {
      clearTimeout(timer);
      rejectPromise(new DirectToolError('tool_failed', `${command} failed`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (truncated) {
        resolvePromise({ stdout: Buffer.concat(chunks, bytes).toString('utf8'), truncated: true });
      } else if (code === 0) {
        resolvePromise({ stdout: Buffer.concat(chunks, bytes).toString('utf8'), truncated: false });
      } else {
        void signal;
        void stderr;
        rejectPromise(new DirectToolError('tool_failed', `${command} failed`));
      }
    });
  });
}

async function fetchPublic(
  urlText: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  extract = true,
) {
  let url: URL;
  try { url = new URL(urlText); }
  catch { throw new DirectToolError('invalid_input', 'url must be a valid absolute HTTP(S) URL'); }
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const addresses = await validatePublicUrl(url);
    const dispatcher = pinnedDispatcher(addresses);
    try {
      const init = {
        redirect: 'manual' as const,
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'tm8-chat/1.0', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' },
        dispatcher,
      };
      const response = await fetchImpl(url, init as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new DirectToolError('upstream_error', `redirect ${response.status} had no location`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new DirectToolError('upstream_error', `web request returned ${response.status}`, response.status >= 500);
      const bytes = await readResponseCapped(response, maxBytes);
      const raw = Buffer.from(bytes).toString('utf8');
      const contentType = response.headers.get('content-type') ?? '';
      return { url: url.toString(), status: response.status, contentType, bytes: bytes.byteLength, raw, text: extract && contentType.includes('html') ? htmlToText(raw) : raw };
    } catch (error) {
      if (error instanceof DirectToolError) throw error;
      throw new DirectToolError('upstream_unavailable', 'web request failed', true);
    } finally {
      await dispatcher?.close();
    }
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

type ResolvedAddress = { address: string; family: 4 | 6 };

async function validatePublicUrl(url: URL): Promise<ResolvedAddress[]> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DirectToolError('invalid_input', 'URL must be public HTTP(S) without embedded credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  try {
    const family = isIP(hostname);
    addresses = family
      ? [{ address: hostname, family: family as 4 | 6 }]
      : (await lookup(hostname, { all: true })).map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
  } catch {
    throw new DirectToolError('upstream_unavailable', 'web host could not be resolved', true);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) throw new DirectToolError('forbidden', 'URL resolves to a local or private address');
  return addresses;
}

// Keep families in separate BlockLists: Node treats IPv4 input as IPv4-mapped
// IPv6 when a list also contains `::ffff:0:0/96`, which would otherwise make
// that defensive IPv6 rule reject every ordinary public IPv4 address.
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
] as const) NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');

function privateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPV4.check(normalized, 'ipv4');
  if (family === 6) return NON_PUBLIC_IPV6.check(normalized, 'ipv6');
  return true;
}

function pinnedDispatcher(addresses: ResolvedAddress[]): Agent {
  const selected = addresses[0];
  if (!selected) throw new DirectToolError('upstream_unavailable', 'web host resolved to no addresses', true);
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    },
  });
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

function safeGitRemote(remote: string): string | null {
  if (/^git@github\.com:[^\s]+$/i.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname) return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Local filesystem remotes would disclose server paths to chat members.
    return null;
  }
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

function boundedString(raw: unknown, field: string, maxBytes: number, emptyAllowed = false): string {
  const value = requiredString(raw, field, emptyAllowed);
  if (Buffer.byteLength(value) > maxBytes) {
    throw new DirectToolError('payload_too_large', `${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  return requiredString(raw, field);
}

function optionalBoundedString(raw: unknown, field: string, maxBytes: number): string | undefined {
  if (raw === undefined) return undefined;
  return boundedString(raw, field, maxBytes);
}

function boundedArray(raw: unknown, field: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) {
    throw new DirectToolError('invalid_input', `${field} must contain ${minimum}-${maximum} items`);
  }
  return raw;
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
