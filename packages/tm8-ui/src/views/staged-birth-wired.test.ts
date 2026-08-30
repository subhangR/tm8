import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

/**
 * THE HOST GUARD — a surface that decides how a kind is born must route the
 * kind's declared create form.
 *
 * WHAT WENT WRONG, and why no component test could see it. `createForm`
 * routing lived in `EntityCreateControl`, and `authoring/entity-create-control
 * .test.tsx` asserts it correctly. It passed while the app was broken, because
 * the defect was never in the control: the ROOT HEADERS stopped mounting it.
 * When the header's ＋ was rewired to drive `useNewTask` directly (task
 * 01a0102f, ruling R4), the routing went out with the component and nothing
 * replaced it, so ＋ on Files ran the generic immediate create. That writes a
 * `public.files` row with `size_bytes 0` and a `storage_path` no blob is ever
 * written to — a row that lists, offers a Download link, and answers
 * `not_found: no readable file` when it is followed. Eleven of them exist
 * across this node's three spaces. Both halves of Tarkesh bug 01a04730, from
 * one dropped branch.
 *
 * The bug also EXISTED TWICE. `HomeView.birthFor` is a copy of
 * `WorkspaceView.birthFor` — deliberately, so the two headers cannot disagree
 * — which means the missing arm was missing on both surfaces, and a fix
 * applied to the one named in the report would have left the identical ＋
 * making hollow rows one tab away. That is the property worth guarding: not
 * "WorkspaceView is correct" but "every copy of this function is".
 *
 * SO THE ASSERTION IS ABOUT THE SOURCE, in the shape `panel-primaries-wired`
 * settled next door and for its stated reason: the wiring is only visible in
 * the hosts, and nobody remembers to check by hand when the third surface
 * lands.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry)) return [];
    if (/\.(test|itest)\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every file that DECIDES a birth — i.e. declares its own `birthFor`. */
const birthHosts = sourceFiles(SRC)
  .map((file) => ({ file, text: stripComments(readFileSync(file, 'utf8')) }))
  .filter(({ text }) => /\bbirthFor\s*=/.test(text));

describe('every root-header host routes the declared create form', () => {
  it('finds the hosts at all (a guard over zero files proves nothing)', () => {
    // The both-halves control. If `birthFor` is ever renamed, this fails
    // loudly rather than passing vacuously over an empty set — the failure
    // mode `panel-primaries-wired` records as "a guard that fails OPEN is
    // worse than no guard, because it is believed".
    expect(birthHosts.map((h) => relative(SRC, h.file)).sort()).toEqual([
      'views/HomeView.tsx',
      'views/WorkspaceView.tsx',
    ]);
  });

  it('each one consults stagedBirthFor', () => {
    const offenders = birthHosts
      .filter(({ text }) => !/\bstagedBirthFor\s*\(/.test(text))
      .map(({ file }) => relative(SRC, file));
    expect(
      offenders,
      `these surfaces decide how a kind is born without asking for its declared\n`
        + `create form, so a kind whose content must exist BEFORE the entity does\n`
        + `falls into the generic immediate create:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('each one hands it the file seam, not a fixture', () => {
    // `stagedBirthFor` without `seam.files` cannot upload anything, and the
    // call would typecheck against any object shaped like the group. The
    // wiring that matters is the REAL one.
    const offenders = birthHosts
      .filter(({ text }) => !/files:\s*data\.seam\.files/.test(text))
      .map(({ file }) => relative(SRC, file));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('each one reconciles what the upload returns before it navigates', () => {
    // The staged arm's `onCreated` receives the completion's own CommandResult
    // (see `files/create.ts`). A host that navigated without reconciling would
    // open a panel on an id its store has never been told about.
    const offenders = birthHosts
      .filter(({ text }) => !/reconcileCommand\(result\)/.test(text))
      .map(({ file }) => relative(SRC, file));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the registry still declares the door these hosts route', () => {
  it('at least one kind asks for a staged create form', () => {
    // Ties the guard above to live registry data: if every `createForm`
    // disappeared, the wiring assertions would be guarding nothing and this
    // says so, rather than staying green over a dead branch.
    expect(allKinds().filter((k) => k.createForm !== undefined).length).toBeGreaterThan(0);
  });
});
