/**
 * EVERY host that mounts an `EntityDetailPanel` must hand it every SEAM-BACKED
 * surface the panel cannot reach for itself: `debugSurface` and `attachments`.
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

  it.each(hosts)('%s passes attachments at every mount', (_label, file) => {
    for (const { block } of mounts.filter((m) => m.file === file)) {
      expect(
        block.includes('attachments='),
        `an <EntityDetailPanel> in ${file} does not pass attachments, so its attachment strip ` +
          'would render NOTHING on an entity with no files yet — no uploader, no empty state',
      ).toBe(true);
    }
  });

  it('composes both surfaces through their shared helpers, not by hand', () => {
    // Four hand-rolled copies is how three of them drifted in the first place.
    for (const { file, block } of mounts) {
      if (block.includes('debugSurface')) {
        expect(
          block.includes('debugSurfaceFor'),
          `${file} builds debugSurface inline; use debugSurfaceFor() so every host stays identical`,
        ).toBe(true);
      }
      if (block.includes('attachments=')) {
        expect(
          readFileSync(file, 'utf8').includes('attachmentsFor'),
          `${file} builds its attachments port by hand; use attachmentsFor() so every host ` +
            'treats an absent seam the same way',
        ).toBe(true);
      }
    }
  });

  it('refetches the anchor once an upload lands', () => {
    // The new `attached_to` edge arrives on the entity's own detail, so a host
    // that uploads without pulling shows the strip's spinner clearing and no
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
});
