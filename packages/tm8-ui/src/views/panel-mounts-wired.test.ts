/**
 * EVERY host that mounts an `EntityDetailPanel` must hand it the capabilities
 * the panel cannot reach for itself — today `debugSurface` and `onResumeSession`.
 *
 * THE CLASS, not one instance. The panel layer is presentational and never
 * touches the seam, so anything needing the seam arrives as a prop from the
 * host. Miss one host and its control renders a "not wired here" fallback while
 * the whole suite stays green. This has now happened TWICE — first to
 * `debugSurface` (three of four hosts), then to `onResumeSession` (four of
 * five) — which is why this guard is no longer named after a single prop.
 *
 * THE RESUME INSTANCE. `ExitedFallback` prints "Resume is not wired on this
 * surface yet." when `onResume` is absent, so one exited session offered a live
 * button in the Workspace and a dead one on the kind screen, the channel view
 * and the graph. That reads as a fact about the SESSION; it was a fact about
 * the SCREEN.
 *
 * THE ORIGINAL DEBUG BUG, kept because it is the same lesson. The Debug
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
    // while proving nothing. Five production mounts across four hosts today:
    // WorkspaceView, EntityView (detail AND aux), ChannelView, GraphScreen.
    expect(mounts.length).toBeGreaterThanOrEqual(5);
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

describe('every EntityDetailPanel mount wires the Graph surface', () => {
  // The THIRD instance of the same class of bug, added with the surface itself
  // rather than after a host was found dead. Same contract as debugSurface: the
  // chip comes free from WorkSessionContent, the body is a host prop.
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));

  it.each(
    Array.from(new Set(mounts.map((m) => m.file))).map(
      (f) => [f.slice(f.indexOf('/src/') + 1), f] as const,
    ),
  )('%s passes graphSurface at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('graphSurface'),
        `an <EntityDetailPanel> in ${file} does not pass graphSurface, so its Graph chip ` +
          'would render the "unavailable in this view" fallback',
      ).toBe(true);
    }
  });

  it('composes the surface through the shared helper, not by hand', () => {
    for (const { file, block } of mounts) {
      if (!block.includes('graphSurface')) continue;
      expect(
        block.includes('graphSurfaceFor'),
        `${file} builds graphSurface inline; use graphSurfaceFor() so every host stays identical`,
      ).toBe(true);
    }
  });
});

describe('every EntityDetailPanel mount wires Resume', () => {
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));

  it.each(
    Array.from(new Set(mounts.map((m) => m.file))).map(
      (f) => [f.slice(f.indexOf('/src/') + 1), f] as const,
    ),
  )('%s passes onResumeSession at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('onResumeSession'),
        `an <EntityDetailPanel> in ${file} does not pass onResumeSession, so an exited ` +
          'session there renders "Resume is not wired on this surface yet." — a claim ' +
          'about the screen that a user reads as a claim about the session',
      ).toBe(true);
    }
  });

  it('drives resume through the shared executor, not a per-view copy', () => {
    // The reason this bug existed: resume was written inline in ONE view, so
    // the other four had nothing to pass. Four copies of an in-flight guard and
    // four error-notice dialects would drift the same way debugSurface did.
    for (const { file, block } of mounts) {
      if (!block.includes('onResumeSession')) continue;
      expect(
        readFileSync(file, 'utf8').includes('useSessionResume'),
        `${file} wires resume without useSessionResume(); the in-flight guard that stops a ` +
          'double-click racing two spawns onto one session id lives in that hook',
      ).toBe(true);
    }
  });
});

describe('every EntityDetailPanel mount wires the attention section', () => {
  // The FOURTH instance of the same class, added with the surface rather than
  // after a host was found dead. It differs from Debug and Graph in one way
  // worth stating: an unwired host here leaves no visible chip pointing at
  // nothing, so the failure is SILENT — the entity simply has no attention
  // history on that screen and looks like an entity nobody ever escalated. A
  // guard is the only thing that can notice that.
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));

  it.each(
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
    for (const { file, block } of mounts) {
      if (!block.includes('attentionSection')) continue;
      expect(
        block.includes('attentionSectionFor'),
        `${file} builds attentionSection inline; use attentionSectionFor() so every host stays identical`,
      ).toBe(true);
    }
  });
});
