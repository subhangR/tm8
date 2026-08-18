import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

/**
 * §15.2 — THE NO-BRANCHING LAW, enforced as a test rather than a review habit.
 *
 * L2: per-kind divergence lives in registry DATA. A `kind === 'task'` anywhere
 * outside `domain/` and `fixtures/` means someone taught a component about a
 * kind, and the next kind will need the same edit — which is how the last
 * three attempts at this UI died. The literals are legal in exactly two
 * places: the registry that defines them and the dataset that instantiates
 * them.
 *
 * §14 — THE HEX BAN, same idea for colour. Raw hex outside the two token
 * files is how a hundred careful transcriptions drift into a hundred slightly
 * different palettes. The exclusion names exactly two files: `tokens.css`
 * (the byte-verbatim transplant) and `canvas-extra.css` (the four canvas
 * colours tokens.css has no entry for).
 *
 * SCOPE: the A1c module set. The other lanes carry their own copies of these
 * assertions for theirs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/**
 * The modules this worker owns. `shell/` is SHARED with the shell-composition
 * lane, so it is named file-by-file rather than swept — a sweep here would
 * report a sibling's file as this lane's violation, which is both wrong and
 * the kind of cross-lane noise that gets a guard switched off.
 */
/**
 * `terminal/` WAS in this list and is deliberately no longer: the charter
 * carves `src/terminal/**` to Track P, whose module is a VERBATIM TRANSPLANT
 * under R9. A transplant legitimately contains kind literals — its
 * `clipboardImages.ts` names 'file' — and §15.2 was written to keep per-kind
 * branching out of FE COMPONENTS, which a harvested clipboard path is not.
 *
 * This is a SCOPE correction, not a weakened law. The rule above is already
 * "scan what this lane owns"; the ownership map moved and the scan follows it.
 * Fixing it the other way — editing P's file to satisfy my guard — would edit
 * a transplant to please a rule that was never aimed at it, and R9's whole
 * point is that the transplant arrives unedited.
 *
 * THE TWO LAWS ARE IRRECONCILABLE BY DESIGN, which is why this is settled
 * JURISDICTIONALLY rather than by either side yielding. R9 says the transplant
 * arrives byte-identical; §15.2 says no shipped file names a kind. A verbatim
 * transplant cannot be brought into §15.2 compliance without ceasing to be
 * verbatim, so there is no edit that satisfies both. The charter's carve-out
 * resolves it by deciding WHICH LAW GOVERNS WHICH DIRECTORY — R9 inside
 * `src/terminal/**`, §15.2 outside it — and this list is how that ruling is
 * enforced in code rather than remembered.
 *
 * THE COST, stated because a silent exemption is how a guard dies: my own
 * terminal chrome family (TerminalChromeStrip, SessionFallback,
 * session-presentation, ...) lives in that directory and IS authored FE code
 * the law was aimed at. It is committed and currently clean, but it is no
 * longer scanned. REVISIT TRIGGER: fe has the chrome family's future home
 * "brokered at P's landing" — when those files land in a directory this lane
 * owns, they come back into this list with them.
 */
const OWNED_DIRS = ['panels'];
const OWNED_SHELL_FILES = ['CommandPalette.tsx', 'LiveSessionBar.tsx', 'RosterPopover.tsx', 'palette.css'];

/** Files that legitimately carry the vocabulary. */
const ALLOWED_HEX_FILES = ['styles/tokens.css', 'styles/canvas-extra.css'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Tests are excluded deliberately: a test PROVING a work_session renders
 * correctly must be able to name a work_session. The ban is on shipped
 * component code, which is what the build failure is about.
 */
const ownedFiles = [
  ...OWNED_DIRS.flatMap((mod) => walk(join(SRC, mod))),
  ...OWNED_SHELL_FILES.map((f) => join(SRC, 'shell', f)),
];

const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

const styleFiles = ownedFiles.filter((f) => f.endsWith('.css'));

describe('§15.2 — no component knows a kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves detector: a glob that silently matched nothing would
    // make every assertion below vacuously true.
    expect(sourceFiles.length).toBeGreaterThan(10);
    expect(styleFiles.length).toBeGreaterThan(1);
  });

  it('no source file outside domain/ and fixtures/ contains a kind string literal', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    // 'graph' became a KIND with Craft P1 (migration 135) while remaining,
    // from long before, a session-panel SURFACE token, a collection MODE and
    // a detail-tab VIEW name. This scanner is a quoted-word match and cannot
    // tell those unions from a kind literal, so the pre-existing collisions
    // are enumerated BY FILE and the rule stays hard everywhere else — a
    // fourth file quoting 'graph' still fails here and must argue its case.
    // 'collection' is the same shape of collision as 'graph', arriving in
    // phase 6: it is a registered KIND *and* the `strategy` discriminant every
    // list-shaped kind carries. `EntityListPanel`'s `isExpandableKind` asks
    // `getKind(kind).strategy === 'collection'` — a registry-to-registry
    // comparison against a strategy union, which teaches the component nothing
    // about any entity kind. It reads the registry rather than branching on it,
    // which is what §15.2 asks for; the scanner simply cannot tell the two
    // unions apart. Phase 6 is why it appears now: the test asks PER CALL
    // instead of precomputing a module-level Set, because `registerCustomKinds()`
    // populates a space's own kinds long after this module is evaluated.
    const wordCollisions: ReadonlySet<string> = new Set([
      'panels/EntityListPanel.tsx → graph',
      'panels/bodies/WorkSessionContent.tsx → graph',
      'panels/detail/tabs.tsx → graph',
      'panels/EntityListPanel.tsx → collection',
    ]);

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      // Comments are stripped FIRST: the docblocks in these files quote the
      // very literals they forbid, in order to explain the ban. Prose that
      // cannot name the rule is worse documentation and no safer.
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (wordCollisions.has(`${relative(SRC, file)} → ${kind}`)) continue;
        // Quoted literal only: the WORD may appear in prose and in comments
        // (this file's own docblock names three kinds), and banning prose
        // would push the explanations out of the code that needs them.
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → '${kind}'`);
        }
      }
    }
    expect(offenders, `kind literals must live in domain/ or fixtures/:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no source file compares a kind against a literal', () => {
    // Narrow on purpose. `availability.kind === 'disabled'` and
    // `k.kind === config.kind` are discriminated-union and registry-to-registry
    // comparisons — neither teaches a component about an entity kind. What is
    // banned is comparing a kind to a KIND LITERAL.
    const kinds = allKinds().map((k) => k.kind);
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`kind\\s*===\\s*['"\`]${kind.replace('*', '\\*')}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → kind === '${kind}'`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('§14 — colour always resolves through a token', () => {
  it('no stylesheet in the owned modules carries a raw hex colour', () => {
    const offenders: string[] = [];
    for (const file of styleFiles) {
      const rel = relative(SRC, file);
      if (ALLOWED_HEX_FILES.includes(rel)) continue;
      const text = stripCssComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hits) offenders.push(`${rel} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, `raw hex outside the two token files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no component inlines a hex colour in a style prop either', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('L4 — floors are law', () => {
  it('no stylesheet uses the forbidden minmax(0,…) track', () => {
    // An unfloored track is how this app has been broken three separate times:
    // the region collapses to zero and the content simply vanishes.
    const offenders = styleFiles.filter((f) =>
      /minmax\(\s*0/.test(stripCssComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
