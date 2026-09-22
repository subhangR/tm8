import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { CollabError } from '@tm8/contract';

export function skillDestination(root: string, provider: string, name: string): string {
  if (!['agents', 'claude', 'codex', 'hermes'].includes(provider)) throw new CollabError('invalid_input', 'unsupported filesystem provider');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new CollabError('invalid_input', 'name must be a safe directory name');
  return join(resolve(root), `.${provider}`, 'skills', name, 'SKILL.md');
}
/** Reject symlink components before reads or writes, including the destination. */
export async function assertSkillPath(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) throw new CollabError('forbidden', 'skill path escapes its authorized root');
  let current: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new CollabError('forbidden', 'skill paths cannot contain symbolic links'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function renderSkillFile(previous: string, input: { name?: string; description?: string; body?: string }): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous);
  const doc = parseDocument(match?.[1] ?? '{}');
  if (doc.errors.length || !doc.toJS() || typeof doc.toJS() !== 'object' || Array.isArray(doc.toJS())) throw new CollabError('invalid_input', 'invalid skill frontmatter');
  if (input.name !== undefined) doc.set('name', input.name);
  if (input.description !== undefined) doc.set('description', input.description);
  const body = input.body ?? (match ? previous.slice(match[0].length) : previous);
  return `---\n${match ? doc.toString() : stringify(doc.toJS())}---\n${body}`;
}
export async function writeSkillFile(root: string, path: string, input: { name?: string; description?: string; body?: string }, create: boolean, expectedHash?: string): Promise<void> {
  await assertSkillPath(root, path);
  const previous = create ? '' : await readFile(path, 'utf8');
  if (expectedHash && createHash('sha256').update(previous).digest('hex') !== expectedHash) throw new CollabError('conflict', 'skill changed on disk; reload before editing');
  const text = renderSkillFile(previous, input);
  await mkdir(dirname(path), { recursive: true });
  await assertSkillPath(root, path);
  if (create) { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); return; }
  const temp = join(dirname(path), `.skill-${randomUUID()}.tmp`);
  try { await writeFile(temp, text, { flag: 'wx', mode: (await lstat(path)).mode }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
