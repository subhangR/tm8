/**
 * EVERY host that mounts an `EntityDetailPanel` must hand it a `debugSurface`.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it already happened once. The Debug
 * chip is rendered by `WorkSessionContent`, so every host gets the CHIP for
 * free through the panel — but the BODY behind it is a prop the host passes
 * down, since the panel layer is presentational and never reaches for the seam.
 * When only `EntityView` passed it, the chip appeared in the Workspace, the
 * Channel view and the Graph screen with nothing behind it, and the panel fell
 * back to "the debug journal host is unavailable in this view". Every test was
 * green; the surface was simply absent in three of four places.
 *
 * A STATIC SCAN rather than four render tests, deliberately: the failure mode
 * is a NEW mount site nobody thought to wire, and only a scan of all of them
 * can catch a host that does not exist yet. Same shape as `no-branching` and
 * `hex-ban`, which guard their invariants the same way.
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
 * first `/>` at any depth ends the block early — these mounts pass whole
 * elements as props (`chatSurface={<LazySessionChatSurface … />}`), and a
 * nested close would truncate the block before the attribute being checked,
 * failing a host that is in fact wired correctly.
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

describe('every EntityDetailPanel mount wires the Debug surface', () => {
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));

  it('finds the mount sites at all (guards against a vacuous pass)', () => {
    // If the scan silently matched nothing, the assertion below would pass
    // while proving nothing. Four production hosts mount the panel today.
    expect(mounts.length).toBeGreaterThanOrEqual(4);
  });

  it.each(
    // Label each case by file so a failure names the host that forgot.
    Array.from(new Set(mounts.map((m) => m.file))).map((f) => [f.slice(f.indexOf('/src/') + 1), f] as const),
  )('%s passes debugSurface at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('debugSurface'),
        `an <EntityDetailPanel> in ${file} does not pass debugSurface, so its Debug chip ` +
          'would render the "unavailable in this view" fallback',
      ).toBe(true);
    }
  });

  it('composes the surface through the shared helper, not by hand', () => {
    // Four hand-rolled copies is how three of them drifted in the first place.
    for (const { file, block } of mounts) {
      if (!block.includes('debugSurface')) continue;
      expect(
        block.includes('debugSurfaceFor'),
        `${file} builds debugSurface inline; use debugSurfaceFor() so every host stays identical`,
      ).toBe(true);
    }
  });
});
