// @vitest-environment node
/**
 * DEV-12, enforced: the collab-v2 seam is backend-agnostic. Clients
 * authenticate to maestro-server only — no Firebase/Supabase SDKs, tokens,
 * headers, or publishable keys may appear ANYWHERE in collab-v2 source
 * (tests excluded: this file must name the forbidden words). Greps the
 * shipped source so a regression fails CI, not a reviewer's eye.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, '..', '..');

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'Firebase reference', re: /firebase/i },
  { name: 'Supabase reference', re: /supabase/i },
  { name: 'publishable key', re: /publishable[_-]?key/i },
  { name: 'collab auth header', re: /x-collab-/i },
  { name: 'postgres_changes subscription', re: /postgres_changes/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|css)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('seam purity — no Firebase/Supabase concepts in collab-v2 (DEV-12)', () => {
  const files = walk(moduleRoot);

  it('scans a non-trivial surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const file of walk(moduleRoot)) {
    it(`keeps ${file.slice(moduleRoot.length + 1)} backend-agnostic`, () => {
      const src = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        const match = src.match(rule.re);
        expect(
          match,
          `${rule.name} found: "${match?.[0] ?? ''}" — collab-v2 must stay maestro-server-native (DEV-12)`,
        ).toBeNull();
      }
    });
  }
});
