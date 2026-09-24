/**
 * Fixtures only in tests (W3 gate): no production module imports the forms
 * fixture PORT, and the forms fixture DATA reaches only the fixture-seam world
 * (`src/fixtures/`, the opt-out/test seam) — never a production path. Walks
 * every non-test source file under src/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(test|spec)\.tsx?$|\.testkit\.tsx?$/;
const PORT = /['"][^'"]*fixture-port['"]/;
const DATA_FROM_FORMS = /from\s+['"]\.\/fixtures['"]/;
const DATA_ELSEWHERE = /['"][^'"]*forms\/fixtures['"]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

describe('forms fixtures stay out of production', () => {
  it('no non-test module imports the fixture port; the fixture data stays in the fixture-seam world', () => {
    const offenders = walk(SRC)
      .filter((path) => {
        const rel = relative(SRC, path);
        // The fixture files themselves may import each other.
        if (rel === join('forms', 'fixture-port.ts') || rel === join('forms', 'fixtures.ts')) return false;
        const text = readFileSync(path, 'utf8');
        if (PORT.test(text)) return true;
        if (rel.startsWith(`forms`)) return DATA_FROM_FORMS.test(text);
        return !rel.startsWith(`fixtures`) && DATA_ELSEWHERE.test(text);
      })
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
