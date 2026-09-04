// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  ActorSummary,
  CommandResult,
  EntityCapabilities,
  EntityCounters,
  EntityDetail,
  EntityState,
  EntitySummary,
  PatchEntityInput,
} from '@tm8/contract';
import { MobileSurfaceProvider } from '../../mobile';
import { ReaderSurface } from './ReaderSurface';

/**
 * NO SPLIT VIEW ON THE PHONE — user ruling 2026-08-20.
 *
 * `DocEditor` has existed, exported and single-pane, since T5-3, with a
 * `Write|Preview` toggle its own annotation calls "chosen by geometry, not
 * preference". Nothing mounted it. `ReaderSurface` picked `DocSplitView` in
 * both arrangements, so a 390px phone got two columns of a two-column editor.
 *
 * ── WHAT THIS FILE CAN AND CANNOT SETTLE ─────────────────────────────────
 *
 * jsdom has NO LAYOUT and loads NO STYLESHEETS. It cannot tell you that the
 * split was cramped, that a control is 44px, or that an input clears the 16px
 * iOS zoom floor. Those are `doc-edit-phone.test.ts`'s (as source) and the
 * build service's (as pixels).
 *
 * What it CAN settle is the part no screenshot can: WHICH COMPONENT WAS
 * CHOSEN, in both directions. A fork asserted in one direction only would also
 * pass on a component that had simply been changed for everyone — which is the
 * failure mode that matters here, because the desktop split is in daily use
 * and this lane is not allowed to take it away.
 *
 * The fork is the HOST's — `useMobileSurface()` — so every phone case mounts
 * the provider and every desktop case does not. That is also why the desktop
 * suite next door needed no changes at all.
 */

afterEach(cleanup);

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };

const COUNTERS: EntityCounters = {
  likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null,
};

const CAPS: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: true, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

const STATE: EntityState = { kind: 'doc', format: 'markdown', childCount: 0 };

function docDetail(body = '# Floors\n\nfloors are law.'): EntityDetail {
  const base: EntitySummary = {
    id: 'doc-layout-spec',
    spaceId: 'sp-test',
    kind: 'doc',
    title: 'Layout spec',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 3,
    activityAt: '2026-07-29T09:00:00.000Z',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z',
    deletedAt: null,
    createdBy: ada,
    counters: COUNTERS,
    state: STATE,
    badges: {},
  };
  return {
    ...base,
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: CAPS,
  };
}

const OK: CommandResult = { patches: [] };

function commandsSpy() {
  const sent: PatchEntityInput[] = [];
  const patchEntity = vi.fn(async (_id: string, input: PatchEntityInput) => {
    sent.push(input);
    return OK;
  });
  return { commands: { patchEntity } as never, sent, patchEntity };
}

function phone(node: ReactNode) {
  return render(<MobileSurfaceProvider sheetHost={null}>{node}</MobileSurfaceProvider>);
}

/** Read stance → press Edit. The stance is `ReaderSurface`'s own state. */
function enterEdit() {
  fireEvent.click(screen.getByRole('button', { name: /edit/i }));
}

describe('ReaderSurface chooses its edit surface by arrangement', () => {
  it('mounts the single-pane DocEditor on a phone', () => {
    const { commands } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    expect(screen.getByTestId('doc-editor')).toBeTruthy();
    expect(screen.queryByTestId('doc-split')).toBeNull();
    /* The pane switch is the whole point of picking this component: with one
       column, the preview has to be reachable some other way than beside the
       source. A DocEditor with no toggle would satisfy the assertion above and
       none of the ruling. */
    expect(screen.getByTestId('doc-stance-write')).toBeTruthy();
    expect(screen.getByTestId('doc-stance-preview')).toBeTruthy();
    /* The splitter is not merely unrendered — it cannot be, since the split is
       not mounted — but naming it says which control the phone does NOT get. */
    expect(screen.queryByTestId('doc-splitter')).toBeNull();
    expect(screen.getByTestId('reader-surface').dataset.arrangement).toBe('phone');
  });

  /**
   * THE CONTROL ON THE CONTROL, and the reason it is not optional here. Every
   * assertion above would pass just as well on a branch that had replaced the
   * split view for EVERYONE. The user ruled a phone arrangement, not a product
   * change: "the DESKTOP KEEPS ITS SPLIT VIEW".
   */
  it('leaves the desktop on the split view, with its splitter', () => {
    const { commands } = commandsSpy();
    render(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    expect(screen.getByTestId('doc-split')).toBeTruthy();
    expect(screen.getByTestId('doc-splitter')).toBeTruthy();
    expect(screen.queryByTestId('doc-editor')).toBeNull();
    expect(screen.queryByTestId('doc-stance-write')).toBeNull();
    expect(screen.getByTestId('reader-surface').dataset.arrangement).toBe('desktop');
  });

  /**
   * THE EXIT, WHICH `DocEditor` DID NOT HAVE.
   *
   * This is the defect mounting it would have shipped, and it is invisible in
   * every assertion above. `DocSplitView` carries `⇲ collapse`; `DocEditor`
   * carried nothing, because its header block records that ⤢/⇲ "are drawn in
   * the PANEL HEADER" — true of the host it was designed against and NOT true
   * of this one, where the stance is `ReaderSurface`'s own component state and
   * no header touches it.
   *
   * So on the phone the only control that left the editor would have been
   * Cancel, which drops the draft and STAYS in edit. A reader who opened the
   * editor to look at the source would have had no way back to the document
   * that did not also throw something away.
   */
  it('gives the phone editor a way back to the document', () => {
    const { commands } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    fireEvent.click(screen.getByTestId('doc-collapse'));
    expect(screen.getByTestId('reader-surface').dataset.stance).toBe('read');
    expect(screen.queryByTestId('doc-editor')).toBeNull();
  });

  /**
   * AND IT IS THE SAME WITHHOLDING RULE THE SPLIT ALREADY OBEYS. `⇲` is
   * refused while the draft is dirty so that no single click can discard text
   * under a label that does not say "discard" — and it is refused VISIBLY,
   * carrying the host's own reason rather than the control's fallback copy
   * about missing wiring, which would be a true-shaped sentence about the
   * wrong cause.
   */
  it('refuses the exit visibly, with the host’s reason, while the draft is dirty', () => {
    const { commands } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: '# Floors\n\nedited' } });

    expect(screen.queryByTestId('doc-collapse')).toBeNull();
    /* Scoped to the editor's own bar. There is a SECOND disabled-with-reason
       on this screen — the file-insert control, refused because no `attach` is
       wired in this harness — and a bare query would resolve to whichever the
       DOM happened to order first. */
    const refused = within(screen.getByTestId('doc-editor').querySelector('.de-bar')!)
      .getByTestId('disabled-with-reason');
    expect(refused.textContent).toContain('unsaved changes');
    /* Not the wiring fallback. That sentence would send the reader looking for
       a missing prop instead of at the draft they have not saved. */
    expect(refused.textContent).not.toContain('collapse dispatch');
  });

  /**
   * ONE DRAFT, ONE `expectedVersion`, ACROSS THE FORK.
   *
   * `ReaderSurface`'s own note says the narrowing of `commands` is a
   * PROJECTION and not an adapter, "so there is no wrapper in which
   * `expectedVersion` could be dropped". Adding a second mount is exactly the
   * moment that could stop being true — one arm wired to a different handle,
   * or a handle rebuilt per arrangement, and every phone conflict becomes a
   * silent overwrite. Both arms take the ONE `useDocSave` handle this
   * component creates, and this asserts the observable consequence.
   */
  it('saves from the phone editor at the version the edit was made against', async () => {
    const { commands, sent } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: '# Floors\n\nedited on a phone' } });
    fireEvent.click(screen.getByTestId('doc-save'));

    await screen.findByTestId('doc-save-word');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.expectedVersion).toBe(3);
    expect((sent[0]!.content as { body: string }).body).toContain('edited on a phone');
  });
});
