/**
 * §15.2 AND §14 FOR THIS LANE — because neither existing guard reaches it.
 *
 * D62 §3 is the rule: A RULING THAT CREATES A FILE NAMES THE CONTROLS THAT
 * WILL SEE IT. `panels/no-branching.test.ts` scans `panels/` plus four named
 * shell files; `files/`, `authoring/`, `messages/` and the settings lanes
 * each carry their own copy. `src/rich-input/` is none of those, so creating
 * this directory created a region where the no-branching law is stated
 * everywhere and enforced nowhere. This file is written by the seat that
 * created the gap, per D61's settled argument against widening someone
 * else's list (a lane guard that fails on another seat's file makes the
 * WRONG seat red).
 *
 * THE LAW THIS LANE LIVES BY: the PRIMITIVE knows no kinds. Triggers commit
 * text; options are host data; attachments are files whatever their anchor
 * is. The one deliberate exception is `skills.ts` — the `/` trigger's whole
 * subject is one kind, and the registry's skill row is field-for-field
 * identical to the spell row, so there is no structural discriminator to
 * reach for; a "structural" lookup would be a kind literal in a costume.
 * The carve is BY FILE NAME, exactly the way `files/` carves
 * `type="file"` by attribute: named narrowly, so a second kind-naming file
 * cannot appear in this lane without failing here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** The one file allowed to name its kind — see the header. */
const KIND_NAMING_FILES = new Set(['skills.ts']);

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
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * `fileReference`'s empty-name fallback label — the English word "file" a
 * reader sees when a file arrives with no name, not the `file` KIND. It moved
 * here verbatim from `doc-edit/insert.ts` (R9-style: a transplant arrives
 * unedited), and the carve is the whole expression, not the word: a bare
 * `'file'` anywhere else in this lane still fails.
 */
function stripFallbackLabel(text: string): string {
  return text.replace(/===\s*''\s*\?\s*'file'\s*:/g, "=== '' ? FALLBACK_LABEL :");
}

const ownedFiles = walk(HERE);

const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('§15.2 — the rich-input primitive knows no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it('no source file outside the named carve contains a kind string literal', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (KIND_NAMING_FILES.has(relative(HERE, file))) continue;
      const text = stripFallbackLabel(stripComments(readFileSync(file, 'utf8')));
      for (const kind of kinds) {
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → '${kind}'`);
        }
      }
    }
    expect(
      offenders,
      `the primitive takes options and placements as data; only skills.ts names its kind:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the carved file names ONLY the skill kind — the carve is not a blank cheque', () => {
    const text = stripComments(readFileSync(join(HERE, 'skills.ts'), 'utf8'));
    const named = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'))
      .filter((kind) => new RegExp(`['"\`]${kind}['"\`]`).test(text));
    expect(named).toEqual(['skill']);
  });
});

describe('§14 — this lane is inside the package hex guard', () => {
  it('is not on any exclusion path, so hex-ban.test.ts really walks it', () => {
    // MEASURED, not assumed: read from the guard's own source, so a future
    // carve that quietly adds `rich-input` fails HERE too and cannot pass by
    // only touching the other file's count assertion.
    const guard = readFileSync(join(SRC, 'hex-ban.test.ts'), 'utf8');
    expect(guard).not.toMatch(/path:\s*'rich-input/);
  });
});
