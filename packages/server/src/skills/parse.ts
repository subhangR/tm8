import { readFile, stat, readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { SkillCandidate } from './discovery.js';

export interface ParsedSkillFile extends SkillCandidate {
  name: string; description: string; frontmatter: Record<string, unknown>;
  sidecar: Record<string, unknown>; contentHash: string; mtime: string; size: number;
  bundleCounts: Record<string, number>; warnings: string[];
}
function yamlObject(text: string, warnings: string[]): Record<string, unknown> {
  try {
    const doc = parseDocument(text, { uniqueKeys: false });
    warnings.push(...doc.errors.map(e => e.message));
    if (doc.errors.length) return {};
    const value: unknown = doc.toJS({ maxAliasCount: 100 });
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (e) { warnings.push(String(e)); return {}; }
}
/** Returns cached metadata only; body bytes never cross the persistence seam. */
export async function parseSkillFile(candidate: SkillCandidate): Promise<ParsedSkillFile> {
  const bytes = await readFile(candidate.path);
  const info = await stat(candidate.path);
  const warnings: string[] = [];
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (text.startsWith('---\n') && !match) warnings.push('Unterminated frontmatter');
  const frontmatter = match ? yamlObject(match[1]!, warnings) : {};
  const body = match ? text.slice(match[0].length) : text;
  const firstParagraph = body.trim().split(/\r?\n\s*\r?\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description
    : typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use
    : warnings.length ? '' : firstParagraph;
  const dir = dirname(candidate.path);
  let sidecar: Record<string, unknown> = {};
  try { sidecar = yamlObject(await readFile(join(dir, 'agents/openai.yaml'), 'utf8'), warnings); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(String(e)); }
  const bundleCounts: Record<string, number> = {};
  const count = async (path: string): Promise<number> => {
    let n = 0;
    try { for (const entry of await readdir(path, { withFileTypes: true })) n += entry.isDirectory() ? await count(join(path, entry.name)) : Number(entry.isFile()); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(String(e)); }
    return n;
  };
  for (const name of ['scripts', 'references', 'assets']) bundleCounts[name] = await count(join(dir, name));
  return { ...candidate, name: typeof frontmatter.name === 'string' ? frontmatter.name : candidate.legacy ? basename(candidate.path, '.md') : basename(dir), description, frontmatter, sidecar, contentHash: createHash('sha256').update(bytes).digest('hex'), mtime: info.mtime.toISOString(), size: bytes.length, bundleCounts, warnings };
}
