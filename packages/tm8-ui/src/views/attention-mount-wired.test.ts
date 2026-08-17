/**
 * EVERY host that mounts an `EntityDetailPanel` must pass `attentionSection`.
 *
 * THE CLASS OF BUG, not one instance. The panel layer is presentational and
 * never touches the seam, so anything needing the seam arrives as a prop from
 * the host. Miss one host and its section is simply absent while the whole
 * suite stays green. This has happened before in this package with
 * `debugSurface` (three of four hosts) and `onResumeSession` (four of five).
 *
 * IT IS WORSE HERE THAN FOR THOSE TWO, which is why the guard ships with the
 * surface rather than after a host is found dead. An unwired Debug surface at
 * least leaves a VISIBLE chip with nothing behind it. An unwired attention
 * section leaves nothing at all: every entity on that screen renders exactly
 * like an entity nobody ever escalated, which is a plausible and completely
 * wrong reading. No human notices, and no render test notices either.
 *
 * A STATIC SCAN rather than N render tests, deliberately: the failure mode is a
 * NEW mount site nobody thought to wire, and only a scan of all of them can
 * catch a host that does not exist yet. Same shape as `no-branching` and
 * `hex-ban`, which guard their invariants the same way.
 *
 * NOTE FOR WHOEVER MERGES `panel-mounts-wired.test.ts`: that file is a sibling
 * lane's uncommitted work carrying the identical scan for `debugSurface` and
 * `graphSurface`. It was not on `main` when this landed, so this guard is
 * standalone rather than an append to it. When it lands, fold this describe
 * block into it and delete this file — one scan, three props.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The JSX element starting at `<EntityDetailPanel`, up to its matching close.
 *
 * Closes on `/>` or `>` AT THE OPENING TAG'S OWN INDENTATION. Matching the
 * first `/>` at any depth would end the block early — these mounts pass whole
 * elements as props (`chatSurface={<LazySessionChatSurface … />}`), and a
 * nested close truncates the block before the attribute being checked, failing
 * a host that is in fact wired correctly.
 */
function mountBlocks(source: string): string[] {
  const blocks: string[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const open = lines[i]!;
    if (!open.includes('<EntityDetailPanel')) continue;
    const indent = open.slice(0, open.indexOf('<'));
    const collected: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      collected.push(lines[j]!);
      if (j > i && (lines[j] === `${indent}/>` || lines[j] === `${indent}>`)) break;
    }
    blocks.push(collected.join('\n'));
  }
  return blocks;
}

describe('every EntityDetailPanel mount wires the attention section', () => {
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));

  it('finds the mount sites at all (guards against a vacuous pass)', () => {
    // If the scan silently matched nothing, the assertions below would pass
    // while proving nothing. Five production mounts today: WorkspaceView,
    // EntityView, auxPanel, ChannelView, GraphScreen.
    expect(mounts.length).toBeGreaterThanOrEqual(5);
  });

  it.each(
    // Label each case by file so a failure names the host that forgot.
    Array.from(new Set(mounts.map((m) => m.file))).map(
      (f) => [f.slice(f.indexOf('/src/') + 1), f] as const,
    ),
  )('%s passes attentionSection at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('attentionSection'),
        `an <EntityDetailPanel> in ${file} does not pass attentionSection, so every entity ` +
          'on that screen renders as though it had never been escalated',
      ).toBe(true);
    }
  });

  it('composes the section through the shared helper, not by hand', () => {
    // Hand-rolled copies is how the debugSurface hosts drifted in the first place.
    for (const { file, block } of mounts) {
      if (!block.includes('attentionSection')) continue;
      expect(
        block.includes('attentionSectionFor'),
        `${file} builds attentionSection inline; use attentionSectionFor() so every host stays identical`,
      ).toBe(true);
    }
  });
});
