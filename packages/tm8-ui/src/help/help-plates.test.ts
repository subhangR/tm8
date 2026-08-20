/**
 * THE VENDORED LIBRARY, PINNED — the registry, the files, and the bytes.
 *
 * WHY THESE ARE THE CASES THAT MATTER. Shipping Help statically trades a graph
 * read for a build artifact, and the whole trade rests on one claim: the file in
 * `./plates/` is BYTE-IDENTICAL to the published artifact revision named beside
 * it. Nothing at run time can check that — the iframe renders whatever bytes are
 * there — so this file is the only place it is ever verified. A hand-edited
 * plate, a half-applied re-export, a registry entry pointing at the wrong
 * revision: each is a silent visual/factual regression in a teaching document,
 * and each fails here.
 *
 * NODE, NOT JSDOM, DELIBERATELY. These read the real files off disk. A DOM would
 * add nothing and `readFileSync` is the point.
 *
 * THE CONTRACT GATES ARE CHECKED ON THE SHIPPED BYTES, not on a claim in a
 * receipt. Every plate was QA'd against the Help design contract before it was
 * published; these re-assert the two gates that are mechanically checkable —
 * self-containment (§8: no network, ever, because the frame is sandboxed to an
 * opaque origin and a remote fetch would simply fail) and a reduced-motion
 * answer (§7). They are cheap, and they are what a future plate added by hand
 * would most plausibly miss.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HELP_PLATES, plateBySlug, plateFileName } from './help-plates';

/* `import.meta.url` resolves to the DOCUMENT base under jsdom, so this file is
   node-environment on purpose and this is the resolution that works. */
const PLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'plates');

function plateBytes(number: number, slug: string): Buffer {
  return readFileSync(join(PLATES_DIR, plateFileName({ number, slug })));
}

describe('the plate registry', () => {
  it('is the complete canonical guide — 55 plates, numbered 1…55 with no gaps', () => {
    /* The count and the contiguity are one claim, not two: a missing plate and
       a plate numbered twice both read as "the library is fine" from any single
       entry. The guide's sections were approved as a spine, and a gap in the
       numbering means a chapter lost a page. */
    expect(HELP_PLATES).toHaveLength(55);
    expect(HELP_PLATES.map((plate) => plate.number)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    );
  });

  it('addresses every plate uniquely, and resolves those addresses', () => {
    const slugs = HELP_PLATES.map((plate) => plate.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const plate of HELP_PLATES) {
      expect(plate.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(plateBySlug(plate.slug)).toBe(plate);
    }
    expect(plateBySlug('no-such-plate')).toBeNull();
    expect(plateBySlug(null)).toBeNull();
  });

  it('fills every chapter of the approved content tree', () => {
    /* An empty chapter is a real editorial fact and the shell renders it as
       one — but not in THIS release: all ten sections were delivered, and a
       chapter that silently emptied would mean plates were dropped in a port. */
    const sections = new Set(HELP_PLATES.map((plate) => plate.section));
    expect([...sections].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', 'A']);
  });

  it('keeps each chapter contiguous, so plate numbers ARE the reading order', () => {
    /* A section whose plates are 13,14,17 would mean a reader walking the
       guide with the next/previous steps leaves and re-enters a chapter. */
    const runs: string[] = [];
    for (const plate of HELP_PLATES) {
      if (runs.at(-1) !== plate.section) runs.push(plate.section);
    }
    expect(runs).toEqual(['0', 'A', '1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('carries a source-of-record provenance for every plate', () => {
    for (const plate of HELP_PLATES) {
      expect(plate.provenance.artifactId, plate.slug).toMatch(/^[0-9a-f-]{36}$/);
      expect(plate.provenance.sourceTaskId, plate.slug).toMatch(/^[0-9a-f-]{36}$/);
      expect(plate.provenance.revision, plate.slug).toBeGreaterThanOrEqual(1);
      expect(plate.provenance.sha256, plate.slug).toMatch(/^[0-9a-f]{64}$/);
      expect(plate.lede.length, plate.slug).toBeGreaterThan(20);
    }
    /* Each artifact appears once: two entries sharing one artifact id would
       mean a plate was duplicated under a second number. */
    const ids = HELP_PLATES.map((plate) => plate.provenance.artifactId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the vendored bundles', () => {
  it('has exactly one file per registry entry and no strays', () => {
    /* Both directions. A stray is a plate that was removed from the registry
       but left in the build, which then ships as dead weight nobody can open. */
    const onDisk = readdirSync(PLATES_DIR).filter((name) => name.endsWith('.html')).sort();
    const expected = HELP_PLATES.map((plate) => plateFileName(plate)).sort();
    expect(onDisk).toEqual(expected);
  });

  it('matches the pinned SHA-256 and size of the published revision', () => {
    for (const plate of HELP_PLATES) {
      const bytes = plateBytes(plate.number, plate.slug);
      expect(bytes.byteLength, plate.slug).toBe(plate.provenance.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), plate.slug).toBe(
        plate.provenance.sha256,
      );
    }
  });

  it('is self-contained — no plate loads anything over the network', () => {
    /* Design contract §8, and a hard runtime requirement here: the frame runs
       at an opaque origin, so a remote stylesheet, font, image or fetch would
       not merely be impolite, it would silently fail to load. Attribute
       positions only — an `https://` inside prose or an SVG namespace is not a
       resource load, and matching the bare scheme would flag every plate. */
    const offenders: string[] = [];
    for (const plate of HELP_PLATES) {
      const html = plateBytes(plate.number, plate.slug).toString('utf8');
      if (/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(html)) offenders.push(`${plate.slug}: remote reference`);
      if (/@import\s+(?:url\()?["']?https?:/i.test(html)) offenders.push(`${plate.slug}: remote @import`);
      if (/\bfetch\s*\(\s*["'`]https?:/i.test(html)) offenders.push(`${plate.slug}: remote fetch`);
    }
    expect(offenders).toEqual([]);
  });

  it('answers prefers-reduced-motion and prefers-color-scheme in every plate', () => {
    /* §7's rejection criterion, and the theme mechanism this shell depends on:
       the app propagates dark through inherited `color-scheme`, which only
       reaches a plate that keys off `prefers-color-scheme` at all. */
    const missing = HELP_PLATES.filter((plate) => {
      const html = plateBytes(plate.number, plate.slug).toString('utf8');
      return !html.includes('prefers-reduced-motion') || !html.includes('prefers-color-scheme');
    });
    expect(missing.map((plate) => plate.slug)).toEqual([]);
  });

  it('opens each plate with the title the registry lists it under', () => {
    /* The row a reader clicks and the page they land on must be the same page.
       Nothing else compares the two — the frame draws the file's own document
       and never sees the registry's string.
       `<title>`, NOT the first `<h1>`: six plates carry a second `<h1>` from the
       design-foundation block they were built against (pinned below), so the
       first heading in the source is not reliably the page's own. Every plate's
       `<title>` is `Name{sep}…{sep}tm8 Help`, and plate 06 uses a hyphen where
       the other 54 use a middot — hence both separators.

       PLATE 20 IS A KNOWN EXCEPTION, listed by number rather than skipped: its
       published `<title>` reads "Design foundation · tm8 Help", the foundation
       reference's own, so its browser/tab name is wrong. It is upstream (a new
       revision fixes it) and invisible inside a frame, but it is a real defect
       and is recorded here rather than smoothed away. */
    const KNOWN_WRONG_TITLE: readonly number[] = [20];
    const drift: string[] = [];
    for (const plate of HELP_PLATES) {
      if (KNOWN_WRONG_TITLE.includes(plate.number)) continue;
      const html = plateBytes(plate.number, plate.slug).toString('utf8');
      const raw = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
      const name = raw
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&rsquo;/g, '\u2019')
        .split(/\s+[\u00b7\u2013\u2014-]\s+/)[0]!
        .replace(/\s+/g, ' ')
        .trim();
      if (name !== plate.title) drift.push(`${plate.slug}: registry "${plate.title}" vs page "${name}"`);
    }
    expect(drift).toEqual([]);
  });

  it('pins the six plates that ship with a duplicate <h1>', () => {
    /* AN UPSTREAM DEFECT, RECORDED RATHER THAN PATCHED. These six pasted the
       "Help — design foundation" reference block into their bundle and brought
       its `<h1>` along, so each document has two — a real violation of the
       design contract's §7 "one `<h1>` per page".
       NOT FIXED HERE, on purpose: editing a vendored byte would break the
       SHA-256 pin two tests above, and with it the only evidence that a plate
       is the revision it claims to be. The repair belongs upstream, as a new
       artifact revision; when one is published and re-vendored, THIS list
       shrinks and this test fails, which is exactly the reminder wanted. It is
       an exact list rather than a count so the set cannot silently change
       members, and it cannot GROW without failing. */
    const doubled = HELP_PLATES.filter((plate) => {
      const html = plateBytes(plate.number, plate.slug).toString('utf8');
      return (html.match(/<h1[\s>]/gi) ?? []).length !== 1;
    });
    expect(doubled.map((plate) => plate.number)).toEqual([11, 28, 41, 46, 51, 54]);
  });
});
