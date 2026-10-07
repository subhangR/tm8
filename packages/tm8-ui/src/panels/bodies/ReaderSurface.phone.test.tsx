// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
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
 * THE EDIT SURFACE ON A PHONE AND ON THE DESKTOP.
 *
 * History: the phone got the single-pane `DocEditor` (user ruling 2026-08-20,
 * "no split view on the phone") while the desktop kept the split. Since the
 * rich editor (New doc UX, 2026-10-07) both arrangements write the text as it
 * reads, in one `RichDocView`; the fork that remains is where the title goes.
 *
 * jsdom has NO LAYOUT and loads NO STYLESHEETS, so this file settles which
 * component was chosen and that the one save handle reaches it — not pixels.
 * The fork is the HOST's (`useMobileSurface()`), so every phone case mounts
 * the provider and every desktop case does not.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

/** Types into the rich editor through the editor TipTap hangs off its node. */
function typeBody(value: string) {
  const editor = (screen.getByTestId('doc-rich') as unknown as { editor: Editor }).editor;
  act(() => {
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: true });
  });
}

describe('ReaderSurface chooses its edit surface by arrangement', () => {
  /* ONE RICH EDITOR IN BOTH ARRANGEMENTS (New doc UX, 2026-10-07). The split
     and the phone's Write⇄Preview pane are gone for everyone; what the
     arrangement still decides is only where the title is written. */
  it('mounts the rich editor on a phone, with no split and no stance toggle', () => {
    const { commands } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    expect(screen.getByTestId('doc-rich-view')).toBeTruthy();
    expect(screen.getByTestId('doc-rich')).toBeTruthy();
    expect(screen.queryByTestId('doc-split')).toBeNull();
    expect(screen.queryByTestId('doc-stance-preview')).toBeNull();
    expect(screen.getByTestId('reader-surface').dataset.arrangement).toBe('phone');
  });

  it('mounts the same editor on the desktop', () => {
    const { commands } = commandsSpy();
    render(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    expect(screen.getByTestId('doc-rich-view')).toBeTruthy();
    expect(screen.queryByTestId('doc-splitter')).toBeNull();
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
    expect(screen.queryByTestId('doc-rich-view')).toBeNull();
  });

  /**
   * AND IT IS THE SAME WITHHOLDING RULE THE SPLIT ALREADY OBEYS. `⇲` is
   * refused while the draft is dirty so that no single click can discard text
   * under a label that does not say "discard" — and it is refused VISIBLY,
   * carrying the host's own reason rather than the control's fallback copy
   * about missing wiring, which would be a true-shaped sentence about the
   * wrong cause.
   */
  /* AUTOSAVE (New doc UX, 2026-10-06): leaving no longer costs a draft, so
     Done is never withheld for one — it saves what is pending and leaves. */
  it('Done saves a dirty draft and leaves the editor', async () => {
    const { commands, sent } = commandsSpy();
    phone(<ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />);
    enterEdit();

    typeBody('# Floors\n\nedited');
    fireEvent.click(screen.getByTestId('doc-collapse'));

    expect(screen.getByTestId('reader-surface').getAttribute('data-stance')).toBe('read');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.expectedVersion).toBe(3);
    expect((sent[0]!.content as { body: string }).body).toContain('edited');
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

    typeBody('# Floors\n\nedited on a phone');
    fireEvent.keyDown(screen.getByTestId('doc-rich'), { key: 'Enter', metaKey: true });

    await screen.findByTestId('doc-save-word');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.expectedVersion).toBe(3);
    expect((sent[0]!.content as { body: string }).body).toContain('edited on a phone');
  });
});
