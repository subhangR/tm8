/**
 * EVERY host that mounts an `EntityDetailPanel` must hand it every SEAM-BACKED
 * surface the panel cannot reach for itself: `debugSurface`, `attachments` and
 * `graphSurface`.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it has now happened TWICE. The panel
 * layer is presentational and never touches a seam, so each of these arrives as
 * a host-supplied prop while the chrome around it renders regardless. The
 * failure is silent, and it was silent in the same way both times:
 *
 *  - `debugSurface` — only `EntityView` passed it, so the Debug chip appeared
 *    in the Workspace, the Channel view and the Graph screen with nothing
 *    behind it, falling back to "unavailable in this view".
 *  - `attachments` — only `EntityView` passed it, and this one was WORSE: with
 *    no uploader AND no files already attached, `AttachmentStrip` renders
 *    `null` by design (an inert dropzone is worse than none). So there was no
 *    chip, no fallback and no empty state — attaching a file was simply
 *    impossible on the main workspace screen, invisibly.
 *  - `graphSurface` — added WITH its surface rather than after a host was found
 *    dead, which is the only reason it is not a third entry in that list.
 *
 * A STATIC SCAN rather than N render tests, deliberately: the failure mode is a
 * NEW mount site nobody thought to wire, and only a scan of all of them can
 * catch a host that does not exist yet. Same shape as `no-branching` and
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

describe('every EntityDetailPanel mount wires its seam-backed surfaces', () => {
  const mounts = sourceFiles(SRC)
    .flatMap((file) => mountBlocks(readFileSync(file, 'utf8')).map((block) => ({ file, block })));
  const hosts = Array.from(new Set(mounts.map((m) => m.file)))
    .map((f) => [f.slice(f.indexOf('/src/') + 1), f] as const);

  it('finds the mount sites at all (guards against a vacuous pass)', () => {
    // If the scan silently matched nothing, the assertions below would pass
    // while proving nothing. Four production hosts mount the panel today.
    expect(mounts.length).toBeGreaterThanOrEqual(4);
  });

  // Label each case by file so a failure names the host that forgot.
  it.each(hosts)('%s passes debugSurface at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('debugSurface'),
        `an <EntityDetailPanel> in ${file} does not pass debugSurface, so its Debug chip ` +
          'would render the "unavailable in this view" fallback',
      ).toBe(true);
    }
  });

  it.each(hosts)('%s passes gitSurface at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('gitSurface'),
        `an <EntityDetailPanel> in ${file} does not pass gitSurface, so its Git chip ` +
          'would render the "unavailable in this view" fallback',
      ).toBe(true);
    }
  });

  it.each(hosts)('%s passes taskGitSection at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('taskGitSection'),
        `an <EntityDetailPanel> in ${file} does not pass taskGitSection, so a gated task ` +
          'would draw a Complete button with no verdict behind it',
      ).toBe(true);
    }
  });

  it.each(hosts)('%s passes graphSurface at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('graphSurface'),
        `an <EntityDetailPanel> in ${file} does not pass graphSurface, so its Graph chip ` +
          'would render the "unavailable in this view" fallback',
      ).toBe(true);
    }
  });

  it.each(hosts)('%s passes membershipAuthoring at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('membershipAuthoring'),
        `an <EntityDetailPanel> in ${file} does not pass membershipAuthoring, so the membership ` +
          "block's add control refuses with the unwired reason — collections would be " +
          'read-only on this host while editable one screen over',
      ).toBe(true);
    }
  });

  it.each(hosts)('%s passes attachments at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('attachments='),
        `an <EntityDetailPanel> in ${file} does not pass attachments, so its attachment strip ` +
          'would render NOTHING on an entity with no files yet — no uploader, no empty state',
      ).toBe(true);
    }
  });

  it('composes every surface through its shared helper, not by hand', () => {
    // Four hand-rolled copies is how three of them drifted in the first place.
    for (const { file, block } of mounts) {
      if (block.includes('debugSurface')) {
        expect(
          block.includes('debugSurfaceFor'),
          `${file} builds debugSurface inline; use debugSurfaceFor() so every host stays identical`,
        ).toBe(true);
      }
      if (block.includes('gitSurface')) {
        expect(
          block.includes('gitSurfaceFor'),
          `${file} builds gitSurface inline; use gitSurfaceFor() so every host stays identical`,
        ).toBe(true);
      }
      if (block.includes('taskGitSection')) {
        expect(
          block.includes('taskGitSectionFor'),
          `${file} builds taskGitSection inline; use taskGitSectionFor() so every host stays identical`,
        ).toBe(true);
      }
      if (block.includes('graphSurface')) {
        expect(
          block.includes('graphSurfaceFor'),
          `${file} builds graphSurface inline; use graphSurfaceFor() so every host stays identical`,
        ).toBe(true);
      }
      if (block.includes('attachments=')) {
        expect(
          readFileSync(file, 'utf8').includes('attachmentsFor'),
          `${file} builds its attachments port by hand; use attachmentsFor() so every host ` +
            'treats an absent seam the same way',
        ).toBe(true);
      }
      if (block.includes('membershipAuthoring')) {
        // The authoring lane holds state, so the composer is a HOOK called
        // once per host (`useMembershipSurface`) with `authoringFor(detail)`
        // at the mount — the direction/picker/refusal mapping must not be
        // rebuilt per host, which is exactly how the first four copies of
        // this wiring drifted apart.
        expect(
          readFileSync(file, 'utf8').includes('useMembershipSurface'),
          `${file} builds membershipAuthoring by hand; use useMembershipSurface() so every ` +
            'host maps the registry block the same way',
        ).toBe(true);
        expect(
          block.includes('authoringFor('),
          `${file} passes membershipAuthoring from somewhere other than authoringFor(detail); ` +
            'the per-subject mapping lives in the shared surface',
        ).toBe(true);
      }
    }
  });

  /*
   * WHAT THIS PAIR OF ASSERTIONS CAN AND CANNOT PROVE, stated because the
   * earlier single assertion here was believed to prove more than it did.
   *
   * It required the STRING `onAttachmentUploaded` to appear in the mount block
   * and nothing else. It therefore stayed green for the entire life of a
   * defect in which all four hosts passed `() => data.pull?.(id)` — a call that
   * cannot refresh an open panel, because `pull` early-returns whenever the
   * detail is already cached and an open panel's always is. The prop was spelt
   * correctly and did nothing, which is precisely the state a wiring guard is
   * supposed to make impossible.
   *
   * A scan cannot execute a callback, so the second assertion below names the
   * verb instead: the refetch must be the INVALIDATING one, and `pull` is
   * explicitly refused in this position. What a scan is still uniquely good at
   * is catching a host nobody has written yet, which is why it stays.
   *
   * THE EFFECT ITSELF is proved by execution, in `attachment-refresh.test.tsx`:
   * a real `useGateData` over a fake seam, an upload landing, and the strip
   * gaining a row it did not have.
   */
  it('refetches the anchor once an upload lands', () => {
    // The new `attached_to` edge arrives on the entity's own detail, so a host
    // that uploads without refetching shows the strip's spinner clearing and no
    // new row — which reads exactly like a failed upload.
    for (const { file, block } of mounts) {
      if (!block.includes('attachments=')) continue;
      expect(
        block.includes('onAttachmentUploaded'),
        `${file} uploads without refetching, so a landed attachment would not appear until ` +
          'the panel is reopened',
      ).toBe(true);
    }
  });

  it('refetches with the INVALIDATING verb — `pull` cannot refresh an open panel', () => {
    for (const { file, block } of mounts) {
      if (!block.includes('attachments=')) continue;
      const wiring = block
        .split('\n')
        .filter((line) => line.includes('onAttachmentUploaded'))
        .join('\n');
      expect(
        wiring.includes('refetchDetail'),
        `${file} wires onAttachmentUploaded to something other than refetchDetail(). The ` +
          'anchor must be RE-READ; a cache-fill call is a no-op on a panel that is already open',
      ).toBe(true);
      expect(
        /\bpull\b/.test(wiring),
        `${file} wires onAttachmentUploaded to pull(). pull() early-returns when the detail is ` +
          'already cached — which an open panel\'s always is — so the strip would never update',
      ).toBe(false);
    }
  });
});
