/**
 * One identity path, enforced structurally.
 *
 * This guard exists because the same bug happened TWICE in one day, in two
 * different blocks, written by two people who were each being careful:
 *
 *  1. The frame's default resolver reported `auto-owner` with no identityId
 *     while the facade grew its own owner resolver over `Db`. Fine while the
 *     facade was the only consumer; the moment the execution handlers read
 *     `ctx.identity` they got undefined and every spawn died with
 *     `28000 no identity bound to this transaction`.
 *  2. The execution handlers then grew their OWN local `claimsFor`, which
 *     differed from the shared one in two ways that both present as
 *     authorization failures rather than claims failures — most dangerously it
 *     bound `actorId` GLOBALLY. A member row belongs to ONE space, and
 *     `internal.resolve_actor` coalesces to it, so a globally-bound actor from
 *     space A on a request touching space B raises 42501 — for the space's own
 *     owner. It had not bitten only because the smoke path uses one space.
 *
 * Neither was findable from inside the block that wrote it: both look correct
 * locally and only fail when a second consumer exists. A test that reads the
 * source is the cheapest thing that can see across blocks.
 *
 * If you are here because this test failed: do not add an exemption. Import
 * `claimsFor` from facade/context.ts. If it genuinely cannot serve your case,
 * change it there so every caller gets the fix.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** The one file allowed to define it. */
const OWNER = join(SRC, 'facade', 'context.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('one identity path (R2 / claims contract)', () => {
  it('claimsFor is DEFINED in exactly one file', () => {
    // Matches a definition — `function claimsFor`, `const claimsFor =` — but
    // deliberately NOT a call or an import, which every handler may do.
    const definition = /(?:function\s+claimsFor\b|(?:const|let|var)\s+claimsFor\s*[:=])/;

    const definers = sourceFiles(SRC).filter((file) => definition.test(readFileSync(file, 'utf8')));

    expect(definers, `claimsFor must be defined only in ${OWNER}`).toEqual([OWNER]);
  });

  it('claims are bound to a transaction in exactly one file', () => {
    // Naming a claim is fine — types and docs do it. BINDING one via
    // set_config is the privileged act, and a second binder would drift from
    // the canonical one, showing up as a 42501 that looks like a policy bug.
    const binder = join(SRC, 'db', 'client.ts');

    // Strip comments first. Files that DOCUMENT the binding — claims.ts
    // explains the SET LOCAL contract in prose, db/types.ts in doc comments —
    // are not binders, and flagging them would train people to ignore this
    // test, which is worse than not having it.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const binders = sourceFiles(SRC).filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return code.includes('set_config') && code.includes('tm8.');
    });

    expect(binders, `only ${binder} may bind claims with set_config`).toEqual([binder]);
  });
});
