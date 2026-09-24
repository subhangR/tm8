/**
 * Where a config knob is defined — resolved from the source, never stored.
 *
 * The registry names a FILE and, where the knob's own name is not enough, an
 * anchor. The line is found here, on first read, so an edit above a knob in a
 * busy file (contract.ts, manifest.ts) never makes the registry stale and never
 * breaks an unrelated PR. A node running without a source checkout answers the
 * file alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/server/{src,dist}/configs/` → the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The patterns that locate a knob BY NAME, most specific first: its
 * declaration, an env read, a JSON key, a quoted string. The first pattern
 * that matches anywhere in the file wins, at its first matching line.
 */
function patternsFor(name: string): RegExp[] {
  const n = escape(name);
  return [
    new RegExp(`\\b(?:const|let|function|interface|type)\\s+${n}\\b`),
    new RegExp(`env(?:\\.|\\[['"])${n}\\b`),
    new RegExp(`"${n}"\\s*:`),
    new RegExp(`['"]${n}['"]`),
  ];
}

const cache = new Map<string, string[] | null>();

function linesOf(file: string, root: string): string[] | null {
  const key = `${root}\0${file}`;
  if (!cache.has(key)) {
    const path = join(root, file);
    cache.set(key, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null);
  }
  return cache.get(key)!;
}

/**
 * The 1-based line that defines `name` in `file`, or `null` when the file is
 * absent or nothing matches. `anchor` is an exact substring and replaces the
 * name patterns when given.
 */
export function locateLine(file: string, name: string, anchor?: string, root = REPO_ROOT): number | null {
  const lines = linesOf(file, root);
  if (!lines) return null;
  const tests: ((line: string) => boolean)[] = anchor
    ? [(line) => line.includes(anchor)]
    : patternsFor(name).map((re) => (line: string) => re.test(line));
  for (const test of tests) {
    const index = lines.findIndex(test);
    if (index >= 0) return index + 1;
  }
  return null;
}

/** `file:line` when the line resolves, else `file`. */
export function definedAt(file: string, name: string, anchor?: string, root = REPO_ROOT): string {
  const line = locateLine(file, name, anchor, root);
  return line === null ? file : `${file}:${line}`;
}
