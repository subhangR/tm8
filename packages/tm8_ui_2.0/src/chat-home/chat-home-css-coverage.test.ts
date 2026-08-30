/**
 * EVERY CHAT-HOME CLASS A COMPONENT WRITES HAS A RULE SOMEWHERE.
 *
 * WHY THIS EXISTS. Adding the Cockpit's stage tabs, I invented
 * `tch-tray__stage` and shipped it with NO CSS AT ALL. The tabs rendered as
 * raw default browser buttons in the middle of a designed tray, and every
 * check I had said fine: typecheck passed (a className is a string), 3796
 * tests passed (jsdom loads no stylesheets and rasterizes nothing), and I had
 * even looked at a screenshot — where an unstyled `<button>` has a border and
 * a label and reads, at a glance, exactly like a styled one. The visual lane's
 * review is what caught it.
 *
 * The same edit ORPHANED `.tch-tray__graph`, whose element it deleted. That is
 * the mirror failure and just as invisible: a rule for nothing, which the next
 * person has to prove is dead before removing it.
 *
 * So this asserts the correspondence in both directions, as arithmetic over
 * the source text. It is not a substitute for looking at the page — it cannot
 * tell you a rule is WRONG, only that one exists. It catches the specific
 * mistake where a component and its stylesheet stop knowing about each other,
 * which no jsdom assertion can reach.
 *
 * Sibling in spirit to the transcript lane's cascade-specificity guard: a
 * green jsdom suite is not evidence that a visual requirement shipped.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = new URL('.', import.meta.url).pathname;

/**
 * The namespaces THIS directory owns. Classes from other families (`sg-` from
 * session-graph, `kit-`, `md-`, `crf-`) are deliberately out of scope — they
 * are styled by the module that owns them, and asserting them here would make
 * this file fail for someone else's edit.
 */
const OWNED = /^(tch|fleet|cgs)[-_]/;

function filesUnder(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, test));
    else if (test(entry.name)) out.push(path);
  }
  return out;
}

/** Dynamic class families: `className={\`prefix-${...}\`}` writes names no
 *  literal scan can see (`tch-code__tok--keyword`, `tch-root--solo`). The
 *  scanner records each template's literal fragments as USED (they are —
 *  `tch-root` is on screen in every render) and keeps fragments that end at a
 *  `${...}` boundary as PREFIXES, so the orphan check can recognise a rule
 *  the template can reach. This is what un-pinned the five `tch-code__tok--*`
 *  false orphans and `tch-root` itself. */
const templatePrefixes = new Set<string>();

/** Class names appearing in a `className=` position — string literals,
 *  template/array members, and template-literal fragments alike. */
function classesUsed(): Map<string, string> {
  const byClass = new Map<string, string>();
  const sources = filesUnder(DIR, (n) => n.endsWith('.tsx') && !n.includes('.test.'));
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/className=\{`([^`]+)`/g)) {
      const body = match[1]!;
      const fragments = body.split(/\$\{[^}]*\}/g);
      for (const [index, fragment] of fragments.entries()) {
        for (const name of fragment.trim().split(/\s+/)) {
          if (!name || !OWNED.test(name)) continue;
          // A fragment ending at '-' is a family prefix, never a whole class.
          if (!name.endsWith('-')) byClass.set(name, byClass.get(name) ?? file);
          // A fragment cut off by ${...} is a family prefix, not a whole name.
          if (index < fragments.length - 1 && fragment.endsWith(name)) templatePrefixes.add(name);
        }
      }
    }
    for (const match of text.matchAll(/className=(?:"([^"]*)"|\{[^}]*\})/g)) {
      const literals = match[1] !== undefined ? [match[1]] : [...match[0].matchAll(/'([^']*)'/g)].map((m) => m[1]!);
      for (const literal of literals) {
        for (const name of literal.split(/\s+/)) {
          if (name && OWNED.test(name) && !byClass.has(name)) byClass.set(name, file);
        }
      }
    }
  }
  return byClass;
}

/** Class names any rule in this directory's stylesheets selects on. */
function classesStyled(): Set<string> {
  const styled = new Set<string>();
  for (const file of filesUnder(DIR, (n) => n.endsWith('.css'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      styled.add(match[1]!);
    }
  }
  return styled;
}

const rel = (path: string): string => path.slice(path.lastIndexOf('/chat-home/'));

/**
 * Classes a component writes ON PURPOSE with no rule of its own: structural
 * hooks and test markers. Being on this list is a CLAIM — "this is meant to be
 * invisible" — which is exactly what `tch-tray__stage` could not have made
 * when it was an accident.
 */
const INTENTIONALLY_UNSTYLED = new Set([
  // Groups the two stage tabs; each wears `tch-tray__chat` for its anatomy.
  'tch-tray__stage',
  // The graph cell's own hook: `sg-cell` beside it carries the anatomy, and
  // this name exists only to reach `--mutated` and `__flag` (cgs-line's
  // precedent exactly).
  'cgs-cell',
  // SVG grouping element for a relation line. Its `__labels` child is styled;
  // the group itself carries no paint (the retired canvas's `.ceg-line` was
  // the same, styled only through modifiers that died with the dialog).
  'cgs-line',
]);

/**
 * PRE-EXISTING, and not this lane's to fix — declared so the number can only
 * go DOWN. Both predate the Cockpit work; whether each is a deliberate hook or
 * a stale class is a question for the module's owner, and answering it by
 * deleting someone's class on the way past is how a review turns into a
 * merge conflict.
 */
const PRE_EXISTING_UNSTYLED = new Set(['tch-group', 'tch-durable']);

/**
 * Rules whose element nobody renders any more. Same ratchet, same reasoning:
 * pinned so it cannot grow, not silently deleted by a passing lane. The
 * `tch-session-word*` / `tch-tile` / `tch-task-row` family is the visible tail
 * of `ChatSessionRow`/`ChatTaskRow` in `types.ts`, which are declared and have
 * no consumer.
 */
const PRE_EXISTING_ORPHANS = new Set([
  'tch-stop', 'tch-attach__input', 'tch-loading', 'tch-tile',
  'tch-thread__badges', 'tch-task-row', 'tch-run', 'tch-thread__glyph',
  'tch-viewonly',
  'tch-session-word', 'tch-session-word--run', 'tch-session-word--wait',
  'tch-session-word--block', 'tch-session-word--idle', 'tch-session-word--info',
  'tch-session-word--brand',
]);

describe('chat-home CSS coverage', () => {
  /* THE FULLWIDTH-PLUS BAN LIVES AT PACKAGE LEVEL, not here. `src/fullwidth-plus-ban.test.ts`
     runs a lexical scanner over every .ts/.tsx and fails only on the glyph in code the compiler
     emits — string literals and JSX text — so the comments EXPLAINING the character survive.
     The lane-local rule this replaces banned the codepoint from every non-test source including
     comments, which would have failed a future author for documenting the very glyph the sweep
     removed. A package law also belongs where it turns the PACKAGE red, not one unlucky lane. */

  it('a class a component writes is styled, or declared unstyled on purpose', () => {
    const styled = classesStyled();
    const undeclared = [...classesUsed()]
      .filter(([name]) => !styled.has(name))
      .filter(([name]) => !INTENTIONALLY_UNSTYLED.has(name) && !PRE_EXISTING_UNSTYLED.has(name))
      .map(([name, file]) => `${name} (${rel(file)})`);
    expect(undeclared).toEqual([]);
  });

  it('no NEW rule is left addressing an element nobody renders', () => {
    const used = new Set(classesUsed().keys());
    const orphans = [...classesStyled()]
      .filter((name) => OWNED.test(name) && !used.has(name))
      /* A modifier whose BASE class is rendered is reachable. */
      .filter((name) => ![...used].some((u) => name.startsWith(`${u}--`)))
      /* A rule a template family can reach is not an orphan. */
      .filter((name) => ![...templatePrefixes].some((p) => name.startsWith(p)))
      .filter((name) => !PRE_EXISTING_ORPHANS.has(name));
    expect(orphans).toEqual([]);
  });

  it('the declared inventories do not rot', () => {
    /* A ratchet nobody prunes becomes a lie. If a name here has been styled or
       rendered since, this fails and the entry comes out. */
    const styled = classesStyled();
    const used = new Set(classesUsed().keys());
    expect([...INTENTIONALLY_UNSTYLED, ...PRE_EXISTING_UNSTYLED].filter((n) => styled.has(n))).toEqual([]);
    expect([...PRE_EXISTING_ORPHANS].filter((n) => used.has(n))).toEqual([]);
  });
});
