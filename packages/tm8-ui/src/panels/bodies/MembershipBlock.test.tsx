// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID, createFixtureSeam } from '../../data/fixtures/seam-fixture';
import { taskUuidTitle } from '../../fixtures';
import { useCollectionMembership } from '../../authoring/useCollectionMembership';
import { MembershipBlock, type MembershipAuthoring } from './MembershipBlock';

/**
 * COLLECTION MEMBERSHIP, END TO END AGAINST THE FIXTURE SEAM.
 *
 * The task's groomed acceptance tests, restated at this layer:
 *
 *   1. ADD FROM ENTITY / 2. ADD FROM COLLECTION — one record whichever side.
 *      The block raises intent and `useCollectionMembership` maps it onto the
 *      (collection, entity) pair; the DIRECTION decides which endpoint the
 *      open panel is. Both directions must reach the seam with the SAME pair,
 *      because `contains` runs collection → entity and the store upserts on
 *      the triple — that mapping is the one thing a naive implementation gets
 *      backwards, so it is pinned here explicitly.
 *   3. MULTI-MEMBERSHIP — one entity in two collections; removing it from one
 *      leaves the other (the edge case a single-parent model fails).
 *
 * Durability and `forbidden` are node-side facts and live in the server's pg
 * suite (`collection-membership.pg.test.ts`); the fixture cannot witness a
 * restart or another principal without inventing one.
 */

async function openSeam() {
  const seam = createFixtureSeam();
  await seam.openSpace(FIXTURE_SPACE_ID);
  return seam;
}

let mutation = 0;
const cmid = () => `membership-test-${++mutation}`;

async function createCollection(
  seam: Awaited<ReturnType<typeof openSeam>>,
  title: string,
): Promise<EntityId> {
  const created = await seam.commands.createEntity({
    clientMutationId: cmid(),
    spaceId: FIXTURE_SPACE_ID,
    kind: 'collection',
    title,
  });
  const id = created.entity?.id;
  if (!id) throw new Error('fixture createEntity returned no collection');
  return id;
}

const containsTargets = (detail: EntityDetail): string[] =>
  detail.connections.outgoing
    .filter((group) => group.type === 'contains')
    .flatMap((group) => group.edges.map((edge) => edge.target.id));

const containingCollections = (detail: EntityDetail): string[] =>
  detail.connections.incoming
    .filter((group) => group.type === 'contains')
    .flatMap((group) => group.edges.map((edge) => edge.source.id));

describe('fixture seam — the membership pair', () => {
  it('adds a member: both endpoints see the edge, itemCount and items move with it', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Reading list');

    await seam.commands.addToCollection(collectionId, {
      clientMutationId: cmid(),
      entityId: taskUuidTitle.id,
    });

    const collection = await seam.entity(collectionId);
    expect(containsTargets(collection)).toEqual([taskUuidTitle.id]);
    expect(collection.state.kind === 'collection' && collection.state.itemCount).toBe(1);
    expect(
      collection.content.kind === 'collection'
        ? collection.content.items.map((item) => item.id)
        : [],
    ).toEqual([taskUuidTitle.id]);

    const member = await seam.entity(taskUuidTitle.id);
    expect(containingCollections(member)).toContain(collectionId);
  });

  it('re-adding an existing member re-positions rather than duplicating', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Idempotent list');
    await seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    await seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    const collection = await seam.entity(collectionId);
    expect(containsTargets(collection)).toEqual([taskUuidTitle.id]);
    expect(collection.state.kind === 'collection' && collection.state.itemCount).toBe(1);
  });

  it('multi-membership: removal from one collection leaves the other', async () => {
    const seam = await openSeam();
    const first = await createCollection(seam, 'Sprint 12');
    const second = await createCollection(seam, 'Launch prep');
    await seam.commands.addToCollection(first, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    await seam.commands.addToCollection(second, { clientMutationId: cmid(), entityId: taskUuidTitle.id });

    let member = await seam.entity(taskUuidTitle.id);
    expect(containingCollections(member)).toEqual(expect.arrayContaining([first, second]));

    await seam.commands.removeFromCollection(first, taskUuidTitle.id, { clientMutationId: cmid() });

    member = await seam.entity(taskUuidTitle.id);
    expect(containingCollections(member)).not.toContain(first);
    expect(containingCollections(member)).toContain(second);
    const survivor = await seam.entity(second);
    expect(survivor.state.kind === 'collection' && survivor.state.itemCount).toBe(1);
  });

  it('removing a non-member is an honest not_found, never a silent success', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Empty list');
    await expect(
      seam.commands.removeFromCollection(collectionId, taskUuidTitle.id, { clientMutationId: cmid() }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses self-containment, exactly as set_collection_item does', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Not my own member');
    await expect(
      seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: collectionId }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('executes the `filters.edge` clause — the collection lens is a real query here too', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Lens set');
    await seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: taskUuidTitle.id });

    // Members of the set: rows with an INCOMING `contains` from it. The
    // fixture must execute this exactly as collections.ts does, or the lens
    // renders as a silent no-op against fixtures.
    const members = await seam.query({
      spaceId: FIXTURE_SPACE_ID,
      filters: { edge: { type: 'contains', direction: 'incoming', entityId: collectionId } },
    });
    expect(members.page.items.map((item) => item.id)).toEqual([taskUuidTitle.id]);

    // And kind-scoped, because that is the exact query a lensed list issues.
    const none = await seam.query({
      spaceId: FIXTURE_SPACE_ID,
      kinds: ['doc'],
      filters: { edge: { type: 'contains', direction: 'incoming', entityId: collectionId } },
    });
    expect(none.page.items).toHaveLength(0);
  });
});

describe('useCollectionMembership — the direction decides which endpoint is the collection', () => {
  const port = (commands: {
    addToCollection: ReturnType<typeof vi.fn>;
    removeFromCollection: ReturnType<typeof vi.fn>;
  }) => ({
    commands: commands as never,
    searchPage: async () => [],
    onChanged: vi.fn(),
    onError: vi.fn(),
  });
  const subject = (direction: 'outgoing' | 'incoming') => ({
    id: 'subject-1' as EntityId,
    direction,
    pickerKind: null,
  });

  it('outgoing (a collection panel): the subject IS the collection', async () => {
    const commands = {
      addToCollection: vi.fn(async () => ({ patches: [] })),
      removeFromCollection: vi.fn(async () => ({ patches: [] })),
    };
    const { result } = renderHook(() => useCollectionMembership(port(commands)));
    result.current.authoringFor(subject('outgoing'))!.onAdd('peer-1', 'Peer');
    await waitFor(() => expect(commands.addToCollection).toHaveBeenCalled());
    expect(commands.addToCollection.mock.calls[0]![0]).toBe('subject-1');
    expect(commands.addToCollection.mock.calls[0]![1]).toMatchObject({ entityId: 'peer-1' });
  });

  it('incoming (an entity panel): the picked peer IS the collection — the SAME pair', async () => {
    const commands = {
      addToCollection: vi.fn(async () => ({ patches: [] })),
      removeFromCollection: vi.fn(async () => ({ patches: [] })),
    };
    const { result } = renderHook(() => useCollectionMembership(port(commands)));
    result.current.authoringFor(subject('incoming'))!.onAdd('collection-1', 'A collection');
    await waitFor(() => expect(commands.addToCollection).toHaveBeenCalled());
    // Reversed arguments, identical record: collection first, member second.
    expect(commands.addToCollection.mock.calls[0]![0]).toBe('collection-1');
    expect(commands.addToCollection.mock.calls[0]![1]).toMatchObject({ entityId: 'subject-1' });

    result.current.authoringFor(subject('incoming'))!.onRemove('collection-1', 'A collection');
    await waitFor(() => expect(commands.removeFromCollection).toHaveBeenCalled());
    expect(commands.removeFromCollection.mock.calls[0]!.slice(0, 2)).toEqual(['collection-1', 'subject-1']);
  });

  it('an unhosted subject answers null, never a throwing stub', () => {
    const commands = {
      addToCollection: vi.fn(async () => ({ patches: [] })),
      removeFromCollection: vi.fn(async () => ({ patches: [] })),
    };
    const { result } = renderHook(() => useCollectionMembership(port(commands)));
    expect(result.current.authoringFor(null)).toBeNull();
  });
});

describe('MembershipBlock — rows, remove, and the bounded picker', () => {
  async function memberDetail(): Promise<{ detail: EntityDetail; collectionId: EntityId }> {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Sprint 12');
    await seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    return { detail: await seam.entity(taskUuidTitle.id), collectionId };
  }

  const authoringOf = (over?: Partial<MembershipAuthoring>): MembershipAuthoring => ({
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    search: vi.fn(async () => []),
    ...over,
  });

  it('renders the containing collection as a row and raises remove intent', async () => {
    const { detail, collectionId } = await memberDetail();
    const authoring = authoringOf();
    const { getByTestId } = render(
      <MembershipBlock
        detail={detail}
        params={{ edgeType: 'contains', direction: 'incoming' }}
        authoring={authoring}
      />,
    );
    const row = within(getByTestId('membership-block')).getByTestId('membership-row');
    expect(row.textContent).toContain('Sprint 12');
    fireEvent.click(within(row).getByTestId('membership-remove'));
    expect(authoring.onRemove).toHaveBeenCalledWith(collectionId, 'Sprint 12');
  });

  it('adds through the picker: one bounded page, filtered locally, add raises intent', async () => {
    // ONE seam for both collections: the fixture's id counter restarts per
    // instance, so a second seam would mint the member's own id again and the
    // picker's already-a-member filter would hide the candidate.
    const seam = await openSeam();
    const memberOf = await createCollection(seam, 'Sprint 12');
    await seam.commands.addToCollection(memberOf, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    const detail = await seam.entity(taskUuidTitle.id);
    const other = await createCollection(seam, 'Launch prep');
    const otherSummary = (await seam.entity(other)) as EntityDetail;
    const authoring = authoringOf({ search: vi.fn(async () => [otherSummary]) });
    const { getByTestId, findByTestId } = render(
      <MembershipBlock
        detail={detail}
        params={{ edgeType: 'contains', direction: 'incoming', addLabel: '+ add to collection' }}
        authoring={authoring}
      />,
    );
    fireEvent.click(getByTestId('membership-add'));
    const option = await findByTestId('membership-option');
    expect(option.textContent).toContain('Launch prep');
    fireEvent.click(option);
    expect(authoring.onAdd).toHaveBeenCalledWith(other, 'Launch prep');
  });

  it('refusal renders controls focusable-but-inert, never dead-looking', async () => {
    const { detail } = await memberDetail();
    const authoring = authoringOf({ refusal: 'read-only here' });
    const { getByTestId } = render(
      <MembershipBlock
        detail={detail}
        params={{ edgeType: 'contains', direction: 'incoming' }}
        authoring={authoring}
      />,
    );
    const add = getByTestId('membership-add');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(authoring.onAdd).not.toHaveBeenCalled();
    const remove = getByTestId('membership-remove');
    fireEvent.click(remove);
    expect(authoring.onRemove).not.toHaveBeenCalled();
  });

  it('an UNWIRED host still renders the add control, refused with the reason — never nothing', async () => {
    // The regression this pins: four of five panel hosts passed no
    // `membershipAuthoring`, and the block hid the add control entirely —
    // indistinguishable from a read-only entity. Unwired must LOOK unwired.
    const { detail } = await memberDetail();
    const { getByTestId, queryByTestId } = render(
      <MembershipBlock
        detail={detail}
        params={{ edgeType: 'contains', direction: 'incoming' }}
      />,
    );
    const add = getByTestId('membership-add');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('title')).toMatch(/not wired membership authoring/i);
    fireEvent.click(add);
    expect(queryByTestId('membership-picker')).toBeNull();
  });

  it('with an itemsHost, a collection’s members render as REAL list tiles, remove intact', async () => {
    // User ruling 2026-08-13: "the items that are linked should be shown like
    // the task items… whatever task tile we are using". The member here is a
    // task, so its registry anatomy is the control-card — assert the tile
    // vocabulary is present, not the chip one, and that remove still raises.
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Tiled list');
    await seam.commands.addToCollection(collectionId, { clientMutationId: cmid(), entityId: taskUuidTitle.id });
    const detail = await seam.entity(collectionId);
    const authoring = authoringOf();
    const { getByTestId } = render(
      <div className="cv2-root">
        <MembershipBlock
          detail={detail}
          params={{ edgeType: 'contains', direction: 'outgoing' }}
          authoring={authoring}
          itemsHost={{ kind: 'collection', rowsFor: () => [], ctx: { spaceId: FIXTURE_SPACE_ID } }}
        />
      </div>,
    );
    const items = getByTestId('membership-items');
    // The control-card tile, not a chip row.
    expect(items.querySelector('.pn-tt')).toBeTruthy();
    expect(items.textContent).toContain(taskUuidTitle.title);
    expect(items.querySelector('.pn-chiprow')).toBeNull();
    fireEvent.click(within(items).getByTestId('membership-remove'));
    expect(authoring.onRemove).toHaveBeenCalledWith(taskUuidTitle.id, taskUuidTitle.title);
  });

  it('an empty membership is a designed empty with the add control beside it', async () => {
    const seam = await openSeam();
    const collectionId = await createCollection(seam, 'Empty list');
    const detail = await seam.entity(collectionId);
    const { getByTestId } = render(
      <MembershipBlock
        detail={detail}
        params={{ edgeType: 'contains', direction: 'outgoing' }}
        authoring={authoringOf()}
      />,
    );
    const block = getByTestId('membership-block');
    expect(block.textContent).toMatch(/empty collection is a real state/i);
    expect(within(block).getByTestId('membership-add')).toBeTruthy();
  });
});
