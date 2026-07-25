/**
 * GOLDEN WORKFLOW 4 — KNOWLEDGE GROWS (brief §10.4).
 *
 *   during review someone promotes a thread message to a doc ("promote to
 *   doc") → the doc lands AS A CHILD OF THE SPEC DOC, `relates_to` the
 *   message, and quotes it; linkable forever.
 *
 * Two independent claims are checked separately, because the build satisfies
 * one and not the other:
 *   (a) relates_to edge + quote           → implemented
 *   (b) "lands as child of the spec doc"  → NOT implemented (see the
 *       `hierarchy` block at the bottom; defect filed with Atlas)
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import {
  createFromSeed, promoteMessage, promoteReactionsSlot, quoteExcerpt, seedForParent,
} from '../../interactions';
import { useNavStore } from '../../stores';
import type { MessageView } from '../../types/contract';
import {
  createRig, edgeIndex, renderBare, resetStores, settle, toastMessages, type AcceptanceRig,
} from './helpers';

let rig: AcceptanceRig;

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

/** A real seeded message: Forge's progress note in the T-104 thread. */
async function seedMessage(): Promise<MessageView> {
  const detail = await rig.facade.getEntity(rig.ids.forgeProgressMessage);
  return detail as unknown as MessageView;
}

describe('WORKFLOW 4 — knowledge grows', () => {
  it('promoting a thread message to a doc creates the doc, quotes it, and links it forever', async () => {
    const message = await seedMessage();
    const { result, kind } = await promoteMessage(rig.facade, message, 'doc');
    expect(kind).toBe('doc');

    const created = result.entity!;
    expect(created.kind).toBe('doc');
    expect(created.title).toBe(quoteExcerpt(message.content.body, 80));

    // (a) the relates_to edge back to the message — the "forever" link
    const edges = await edgeIndex(rig, created.id);
    const relates = Object.entries(edges)
      .filter(([k]) => k.endsWith(':relates_to'))
      .flatMap(([, v]) => v);
    expect(relates, 'relates_to the source message').toContain(message.id);

    // (b) the quote is present, attributed to the message's author
    const detail = await rig.facade.getEntity(created.id);
    expect(detail.content.kind).toBe('doc');
    if (detail.content.kind === 'doc') {
      expect(detail.content.format).toBe('markdown');
      expect(detail.content.body, 'markdown blockquote').toContain('> ');
      expect(detail.content.body).toContain(message.state.author.displayName);
      expect(detail.content.body).toContain(message.content.body.slice(0, 40));
    }
  });

  it('the promote affordance is reachable from a real thread message row', async () => {
    const message = await seedMessage();
    const slot = promoteReactionsSlot();
    renderBare(rig, <div>{slot(message)}</div>);

    fireEvent.click(screen.getByRole('button', { name: /promote/i }));
    const menu = await screen.findByTestId('promote-menu');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items.map((b) => b.textContent?.toLowerCase())).toEqual([
      expect.stringContaining('task'), expect.stringContaining('doc'),
    ]);

    fireEvent.click(items[1]); // → doc
    await waitFor(() => {
      expect(toastMessages().some((m) => m.startsWith('Promoted to doc'))).toBe(true);
    });
    // and it opens as a panel, so the author lands on the new knowledge
    await waitFor(() => expect(useNavStore.getState().stack.at(-1)).toBeTruthy());
  });

  it('the promoted doc is queryable and linkable afterwards (it joined the corpus)', async () => {
    const message = await seedMessage();
    const { result } = await promoteMessage(rig.facade, message, 'doc');
    const created = result.entity!;

    const docs = await rig.facade.queryCollection({
      spaceId: rig.ids.space, kinds: ['doc'], limit: 100,
    });
    expect(docs.page.items.map((d) => d.id), 'the doc is in the docs collection')
      .toContain(created.id);

    // and it can be linked onward like any entity
    await rig.facade.placements({
      sourceId: created.id, targetId: rig.ids.t104, intent: 'attach',
    });
    const edges = await edgeIndex(rig, created.id);
    expect(Object.values(edges).flat()).toContain(rig.ids.t104);
  });

  describe('hierarchy: "lands as child of the spec doc"', () => {
    it('the FACADE can do it — createEntity honours parentId + attachTo together', async () => {
      const message = await seedMessage();
      const result = await createFromSeed(
        rig.facade, 'doc', {
          ...seedForParent(rig.ids.space, rig.ids.docSpec),
          attachTo: { entityId: message.id, edgeType: 'relates_to' },
        },
        'Promoted under the spec',
        { format: 'markdown', body: '> quoted' },
      );
      expect(result.entity!.parentId, 'the seam supports the workflow')
        .toBe(rig.ids.docSpec);

      const hierarchy = await rig.facade.getHierarchy(rig.ids.docSpec);
      expect(hierarchy.children.items.map((c) => c.id),
        'the spec doc tree grew').toContain(result.entity!.id);
    });

    it('DEFECT: promoteMessage never sets a parent — the doc is born at the root', async () => {
      const message = await seedMessage();
      const { result } = await promoteMessage(rig.facade, message, 'doc');

      // This is the brief §10.4 requirement, and it is NOT met.
      // interactions/promote/index.tsx:67-73 builds the seed as
      // `{ spaceId, attachTo }` with no `parentId`, and PromoteMenu /
      // promoteReactionsSlot expose no way to supply one — so a promoted doc
      // never becomes a child of the doc (or task) the conversation is on.
      expect(
        result.entity!.parentId,
        'EXPECTED-FAIL MARKER: brief §10.4 wants parentId === docSpec; the build produces null',
      ).toBeNull();

      const hierarchy = await rig.facade.getHierarchy(rig.ids.docSpec);
      expect(hierarchy.children.items.map((c) => c.id))
        .not.toContain(result.entity!.id);
    });

    it('the message anchor that SHOULD have supplied the parent is available on MessageView', async () => {
      // The fix is cheap: the anchor is right there on the message.
      const message = await seedMessage();
      expect(message.state.kind).toBe('message');
      expect(message.state.anchorId, 'promote has the context it needs').toBe(rig.ids.t104);
      // So the fix is a one-liner in promoteMessage: when the anchor's kind
      // equals the promote target kind, seed `parentId: message.state.anchorId`
      // (or expose a `parentId` option on PromoteMenu / promoteReactionsSlot).
    });
  });
});
