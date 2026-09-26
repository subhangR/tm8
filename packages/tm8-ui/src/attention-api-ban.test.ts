import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `src/attention/` IS THE ONLY UI MODULE THAT TALKS TO THE ATTENTION API — a
 * package law (Attention v2, S1 · Consolidate).
 *
 * Attention was read in three places with three definitions of "pending": the
 * inbox read `open`, the dock read `open` + `acknowledged`, the per-entity
 * section read everything. Each was locally reasonable and together they
 * disagreed on the same entity. Consolidating them is only durable if a fourth
 * reader cannot appear quietly somewhere else, so the rule is stated here over
 * the whole package: a surface that needs attention imports from
 * `src/attention/` (`useAttentionPending`, `attentionPortFromSeam`,
 * `AttentionInbox`, `groupAttentionByEntity`) and never calls the seam's
 * attention verbs itself.
 *
 * `src/data/` is exempt because it IS the API: the seam contract, the real
 * transport and the fixture define these verbs rather than call them. Tests are
 * exempt because they fake the seam.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = `attention${sep}`;
const EXEMPT = [OWNER, `data${sep}`];

/**
 * Every way a UI file can reach the attention API. The op-name arm matches a
 * transport CALL only — `chat-home/write-classifier.ts` names the same ops as
 * strings to classify them, which is not a call.
 */
const API_CALLS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'seam.attentionRequests(…) (list)', pattern: /\.attentionRequests\s*\(/ },
  { name: 'commands.resolveAttention(…) (bulk resolve)', pattern: /\.resolveAttention\s*\(/ },
  { name: 'commands.updateAttentionRequest(…) (settle one)', pattern: /\.updateAttentionRequest\s*\(/ },
  { name: 'commands.attentionV2.* (markSeen / unresolve / withdraw)', pattern: /\.attentionV2\b/ },
  { name: "call('attentionRequests.*') (raw op)", pattern: /call\s*(?:<[^>]*>)?\s*\(\s*['"`]attentionRequests\./ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function hits(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { name, pattern } of API_CALLS) {
        if (pattern.test(line)) found.push(`${relative(HERE, file)}:${index + 1} — ${name}`);
      }
    });
  }
  return found;
}

describe('attention API ban', () => {
  const files = walk(HERE);
  const outside = files.filter((file) => !EXEMPT.some((dir) => relative(HERE, file).startsWith(dir)));
  const owner = files.filter((file) => relative(HERE, file).startsWith(OWNER));

  it('scans the package (a ban over an empty set passes vacuously)', () => {
    expect(outside.length).toBeGreaterThan(100);
    expect(owner.length).toBeGreaterThan(0);
  });

  it('finds the calls where they do live, so the patterns are not dead', () => {
    // POSITIVE CONTROL: each verb the UI uses today is seen inside the owner.
    // `resolveAttention` has no UI caller since S0 (opening no longer settles).
    const inOwner = hits(owner).join('\n');
    expect(inOwner).toContain('useAttentionPending.ts');
    expect(inOwner).toContain('AttentionInbox.tsx');
    expect(inOwner).toMatch(/port\.ts:\d+ — commands\.updateAttentionRequest/);
    // Attention v2 (S5a): the store's commands own resolve and the v2 verbs.
    expect(inOwner).toMatch(/attention-commands\.ts:\d+ — commands\.resolveAttention/);
    expect(inOwner).toMatch(/attention-commands\.ts:\d+ — commands\.attentionV2/);
  });

  it('no file outside src/attention/ calls the attention API', () => {
    expect(hits(outside)).toEqual([]);
  });
});
