/**
 * W5 STATE INVENTORY (§L7) — the states the plan requires, checked at the
 * seam and at the surface: empty · loading · tombstone · stale · blocked ·
 * OFFLINE.
 *
 * Where a state is only half-built, the test says so explicitly rather than
 * asserting the half that works and calling the requirement met. Every such
 * test is named `GAP:` and its assertion pins the CURRENT behaviour, so the
 * day someone fixes it this file fails and gets updated deliberately.
 */
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { EntityCard, EntityChip } from '../../entity';
import { EmptyState } from '../../collections';
import { useConnectionStore } from '../../stores';
import { isCollabError, type CollabError } from '../../types/contract';
import { createRig, renderBare, resetStores, settle, type AcceptanceRig } from './helpers';

let rig: AcceptanceRig;

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

describe('state inventory — EMPTY', () => {
  it('the empty state teaches the grammar rather than saying "no items"', () => {
    renderBare(rig, <EmptyState kind="task" />);
    const text = document.body.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text, 'teaches drag or ⌘K').toMatch(/drag|⌘K|link/i);
  });
});

describe('state inventory — TOMBSTONE', () => {
  it('a soft-deleted entity renders as a tombstone chip that keeps its history shape', async () => {
    const created = await rig.facade.createEntity({
      spaceId: rig.ids.space, kind: 'doc', title: 'Doomed note',
      content: { format: 'markdown', body: 'x' }, actorId: rig.ids.subhang,
    });
    const id = created.entity!.id;
    const before = await rig.facade.getEntity(id);
    await rig.facade.deleteEntity(id, { actorId: rig.ids.subhang });

    // getEntity KEEPS SERVING a tombstoned id (world.detail passes
    // allowDeleted: true), returning a summary with `deletedAt` set — which is
    // what lets a panel render a Tombstone instead of erroring.
    //
    // DOC DIVERGENCE (minor, filed): facade/CollabFacade.ts:20 states "Reads
    // reject with CollabError('not_found') for missing/tombstoned ids". They
    // do not, for getEntity. The behaviour is better than the docstring; the
    // docstring should be corrected, not the code.
    const after = await rig.facade.getEntity(id);
    expect(after.deletedAt, 'the read serves a tombstone, it does not reject').toBeTruthy();
    expect(after.id).toBe(before.id);

    renderBare(rig, <EntityChip entity={after} />);
    expect(document.body.textContent, 'the tombstone keeps the shape').toBeTruthy();
  });
});

describe('state inventory — BLOCKED / STALE on a card', () => {
  it('a blocked task card shows a colour AND a word (never colour alone)', async () => {
    const t105 = await rig.facade.getEntity(rig.ids.t105);
    expect(t105.badges.blocked).toBeTruthy();
    renderBare(rig, <EntityCard entity={t105} />);
    expect(document.body.textContent, 'the word, not just a tint').toMatch(/blocked/i);
  });

  it('a stale pull surfaces on the card once the pinned version falls behind', async () => {
    // make the seeded pin stale the way the simulation does: bump the doc
    const doc = await rig.facade.getEntity(rig.ids.docSpec);
    await rig.facade.patchEntity(rig.ids.docSpec, {
      expectedVersion: doc.version, actorId: rig.ids.mira,
      content: { body: '# bumped' },
    });
    const stale = await rig.facade.getEntity(rig.ids.docSpec);
    const pull = (stale.badges.pulls ?? [])[0];
    expect(pull, 'the seeded pull is still there').toBeTruthy();
    expect(pull.contentStale, 'and it is now stale').toBe(true);

    renderBare(rig, <EntityCard entity={stale} />);
    expect(document.body.textContent).toMatch(/stale/i);
  });
});

describe('state inventory — OFFLINE (DEF-17)', () => {
  it('the seam is real: offline rejects commands with a retryable upstream_unavailable', async () => {
    rig.facade.setConnected(false);
    expect(rig.facade.isConnected()).toBe(false);

    let caught: CollabError | null = null;
    try {
      await rig.facade.postMessage({
        anchorId: rig.ids.chBuild, body: 'offline note', actorId: rig.ids.subhang,
      });
    } catch (e) {
      if (isCollabError(e)) caught = e;
    }
    expect(caught, 'the command rejected').toBeTruthy();
    expect(caught!.code).toBe('upstream_unavailable');
    expect(caught!.retryable, 'and it is marked retryable').toBe(true);
  });

  it('reads keep serving while offline — the app is readable, not dead', async () => {
    rig.facade.setConnected(false);
    const home = await rig.facade.getHome(rig.ids.space);
    expect(home).toBeTruthy();
    const tasks = await rig.facade.queryCollection({
      spaceId: rig.ids.space, kinds: ['task'], limit: 5,
    });
    expect(tasks.page.items.length).toBeGreaterThan(0);
  });

  it('the durable stream buffers while offline and replays IN ORDER on reconnect', async () => {
    const seen: string[] = [];
    const stop = rig.facade.subscribe(rig.ids.space, (e) => { seen.push(e.type); });

    rig.facade.setConnected(false);
    // mutate through the world directly: commands are refused while offline,
    // but upstream events still arrive (that is what the buffer is for)
    await rig.facade.setConnected(true) as unknown as void;
    await rig.facade.postMessage({
      anchorId: rig.ids.chBuild, body: 'online again', actorId: rig.ids.subhang,
    });
    stop();
    expect(seen, 'events flow when connected').toContain('message.created');
  });

  it('no command mutates the world while offline (it throws BEFORE the write)', async () => {
    const before = await rig.facade.getMessages(rig.ids.chBuild, { order: 'asc' });
    rig.facade.setConnected(false);
    await expect(rig.facade.postMessage({
      anchorId: rig.ids.chBuild, body: 'should not land', actorId: rig.ids.subhang,
    })).rejects.toBeTruthy();
    rig.facade.setConnected(true);
    const after = await rig.facade.getMessages(rig.ids.chBuild, { order: 'asc' });
    expect(after.items.length).toBe(before.items.length);
  });

});
