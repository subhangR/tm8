/**
 * THE TEST THAT LIVES IN THE GAP (brief §4.3).
 *
 * Four links — declaration, data, implementation, CALL — can each verify
 * green while the feature is dead, because nobody asserted the caller passes
 * the argument. Four sessions rendered as twelve through four green suites.
 * So this file drives `filesPortFromSeam` / `nodePortFromSeam` against a REAL
 * `createFixtureSeam()` and asserts on what comes BACK. No mocks, no spies on
 * the seam: a spy would prove the call shape and prove nothing about the data
 * reaching the screen.
 *
 * It also pins the three facts this surface rests on, each easy to believe
 * wrongly:
 *   1. a message's attachments are contract-typed on `MessageView.content`
 *      and are therefore REAL through the seam — this screen's only live read
 *      of file data;
 *   2. an attachment carries NO size, so the port must enrich or admit null —
 *      believing otherwise produces "0B" chips, the D7.2 lie in miniature;
 *   3. the fixture dataset has NO `attached_to` edges, so `filesOn()`
 *      correctly returns an EMPTY list — a measured zero, and the reason the
 *      FILES·N section says "no files attached" rather than showing a dash.
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { fileKindRef, filesPortFromSeam, nodePortFromSeam } from './port';

async function firstSpaceId(seam: ReturnType<typeof createFixtureSeam>) {
  const spaces = await seam.spaces();
  expect(spaces.length, 'the fixture seam must expose at least one space').toBeGreaterThan(0);
  return spaces[0]!.id;
}

describe('the files port reaches real data through a real seam', () => {
  it('lists file entities — the kind resolved from the registry, not typed', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const rows = await filesPortFromSeam(seam, spaceId).listFiles();

    // THE assertion this file exists for: the caller passed the registry kind
    // through and file STATE survived the trip. A green `listFiles` returning
    // [] would prove the function runs and nothing about the query.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(row.name.length).toBeGreaterThan(0);
      expect(typeof row.mime).toBe('string');
      expect(typeof row.sizeBytes).toBe('number');
      expect(row.attributedTo).not.toBeNull();
    }
  });

  it('the registry-derived kind is the one the seam actually indexes by', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const result = await seam.query({ spaceId, kinds: [fileKindRef() as never] });
    // If `fileKindRef()` ever drifts off the kind the data uses, this is the
    // line that goes red — before a screen quietly renders an empty gallery.
    expect(result.page.items.length).toBeGreaterThan(0);
    for (const item of result.page.items) expect(item.kind).toBe(fileKindRef());
  });

  it('reads a message’s attachments off the contract-typed field', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = filesPortFromSeam(seam, spaceId);

    // Find the anchor the fixture thread hangs off by walking real data
    // rather than hardcoding an id: the ids are another lane's to change.
    const result = await seam.query({ spaceId });
    let found: Awaited<ReturnType<typeof port.messagesWithFiles>> = [];
    for (const entity of result.page.items) {
      const withFiles = await port.messagesWithFiles(entity.id);
      if (withFiles.length > 0) {
        found = withFiles;
        break;
      }
    }

    expect(
      found.length,
      'the fixture dataset must carry at least one message with an attachment',
    ).toBeGreaterThan(0);
    const first = found[0]!;
    expect(first.files.length).toBeGreaterThan(0);
    for (const file of first.files) {
      expect(file.fileEntityId.length).toBeGreaterThan(0);
      expect(file.name.length).toBeGreaterThan(0);
      // Enriched from the file entity: the attachment DTO has no size, so a
      // number here proves `enrich` ran against real query results.
      expect(file.sizeBytes).not.toBeUndefined();
      expect(file.attributedTo?.displayName.length).toBeGreaterThan(0);
    }
  });

  /**
   * MEASURED, 2026-07-29, not assumed — and the measurement is a FINDING.
   *
   * `seam.entity(id).connections` on the fixture dataset carries exactly three
   * edge types across every entity: `references`, `blocks`, `relates_to`.
   * There is NO `attached_to` group. Meanwhile `src/fixtures/graph.ts:116`
   * DOES define `fileScreenshot -attached_to-> taskGuideLines` — but that
   * edge lives in the graph dataset and never reaches `EntityDetail
   * .connections`.
   *
   * So `filesOn()` correctly answers [] for every fixture entity, and the
   * FILES·N section correctly renders its measured-empty line. The reader
   * needs to know that is the DATA's shape and not a broken port — which is
   * why this asserts the emptiness instead of shrugging at it. If a fixtures
   * seat later surfaces those edges, this test goes red and the person who
   * changed it learns immediately that a screen just came alive.
   */
  it('answers a MEASURED empty list on fixtures — and that is the data, not the port', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const result = await seam.query({ spaceId });
    const port = filesPortFromSeam(seam, spaceId);

    const types = new Set<string>();
    let checked = 0;
    for (const entity of result.page.items) {
      const detail = await seam.entity(entity.id);
      for (const group of [...detail.connections.incoming, ...detail.connections.outgoing]) {
        types.add(group.type);
      }
      expect(await port.filesOn(entity.id)).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    // The measurement itself, pinned: three edge types, none of them ours.
    expect([...types].sort()).toEqual(['blocks', 'references', 'relates_to']);
  });
});

describe('the node port reports only what the seam measures', () => {
  it('reads a real connection phase, never a fabricated one', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = nodePortFromSeam(seam, spaceId);

    const facts = port.facts();
    expect(['connecting', 'live', 'polling', 'offline']).toContain(facts.connection.phase);
    // Before any refresh, NOTHING about sessions is known. This is the state a
    // real cold mount is in, and the screen must render dashes for it.
    expect(facts.liveSessionCount).toBeNull();
    expect(facts.nodeBootId).toBeNull();
    // The cap has no reader anywhere in the contract; the port hard-codes the
    // absence so no host can accidentally supply a plausible number.
    expect(facts.slotCap).toBeNull();
  });

  it('a refresh delivers a REAL snapshot — count, boot id and timestamp', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    await seam.openSpace(spaceId);
    const port = nodePortFromSeam(seam, spaceId);

    await port.refresh();
    const facts = port.facts();
    // The four-links assertion again: `refresh()` awaited a seam read AND
    // stored it AND `facts()` reads from the same place. Any one of those
    // links broken and this line goes red.
    expect(typeof facts.liveSessionCount).toBe('number');
    expect(facts.liveSessionCount).toBeGreaterThanOrEqual(0);
    expect(typeof facts.nodeBootId).toBe('string');
    expect(typeof facts.checkedAt).toBe('string');
    expect(facts.slotCap).toBeNull();
  });

  it('the liveness subscription delivers, and unsubscribing stops it', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    await seam.openSpace(spaceId);
    const port = nodePortFromSeam(seam, spaceId);

    const seen: number[] = [];
    const off = port.subscribe((facts) => {
      if (facts.liveSessionCount !== null) seen.push(facts.liveSessionCount);
    });

    // Drive the fixture's own liveness control — a real push through the real
    // seam, not a hand-called callback.
    seam.fixtureControls.setLiveness(spaceId, ['a', 'b']);
    expect(seen).toEqual([2]);
    expect(port.facts().liveSessionCount).toBe(2);

    off();
    seam.fixtureControls.setLiveness(spaceId, ['a']);
    // The gap between "subscribed" and "unsubscribed" is where leaks live.
    expect(seen).toEqual([2]);
  });

  it('ignores a liveness snapshot for a DIFFERENT space', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    await seam.openSpace(spaceId);
    const port = nodePortFromSeam(seam, spaceId);

    const seen: unknown[] = [];
    port.subscribe((facts) => seen.push(facts.liveSessionCount));
    seam.fixtureControls.setLiveness('some-other-space' as never, ['a', 'b', 'c']);
    // Cross-space bleed would render another space's sessions as this node's
    // — a plausible number that is simply about something else.
    expect(seen).toEqual([]);
  });
});
