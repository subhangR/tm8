/**
 * §15.2 IN THIS LANE — "no component knows a kind", scoped to
 * `src/settings-governance/`.
 *
 * WHY A LOCAL COPY RATHER THAN WIDENING THE PACKAGE GUARD.
 * `panels/no-branching.test.ts` scans `panels/` plus four named `shell/`
 * files, and its own docblock explains why it is scoped that way: a lane guard
 * that fails on another seat's file makes the WRONG SEAT RED — they cannot fix
 * it, their only moves are nag or exempt, and exempt is how guards die. So the
 * law travels by being ADOPTED, not by being widened. `settings-space/` (half
 * A of T2) adopted it the same way; this is half B doing likewise.
 *
 * The law has teeth here because this surface is genuinely tempted: it renders
 * projects and interaction profiles, and `kinds: ['project']` is what the
 * queries mean. `port.ts` reaches them through `kindBySlug()` — the registry's
 * own route lookup — and `governance-model.ts` narrows entity state
 * STRUCTURALLY. Both are ways of asking the registry instead of remembering.
 *
 * D62: a ruling that creates a file names the controls that will see it. This
 * file is a `.test.ts` under `src/`, so the vitest include glob
 * (`src/**\/*.{test,spec}.{ts,tsx}`) picks it up with no config edit, it runs
 * in the default `node` environment (it touches no DOM), and `hex-ban.test.ts`
 * ignores it for the source scan because it is a test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain/registry';

const HERE = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sourceFiles = walk(HERE)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('§15.2 — settings-governance names no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves detector: a glob that matched nothing would make the
    // assertion below vacuously true, which is the failure mode of every
    // guard that has ever quietly stopped working.
    expect(sourceFiles.length).toBeGreaterThan(4);
  });

  it('contains no core-kind string literal in shipped source', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      // Comments are stripped first: the docblocks in this lane quote the
      // literals they forbid in order to explain the ban, and prose that
      // cannot name the rule is worse documentation and no safer.
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (text.includes(`'${kind}'`) || text.includes(`"${kind}"`) || text.includes(`\`${kind}\``)) {
          offenders.push(`${relative(HERE, file)} → '${kind}'`);
        }
      }
    }
    expect(
      offenders,
      `a kind literal in settings-governance source:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('reaches both kinds it renders through the REGISTRY, by route slug', () => {
    // The positive half. Banning the literal is only half a law; this asserts
    // the sanctioned replacement is actually present, so a future edit cannot
    // satisfy the ban by dropping the query altogether.
    const port = readFileSync(join(HERE, 'port.ts'), 'utf8');
    expect(port).toContain('kindBySlug');
    expect(port).toContain("PROJECT_SLUG = 'projects'");
    expect(port).toContain("PROFILE_SLUG = 'interaction-profiles'");
  });
});
