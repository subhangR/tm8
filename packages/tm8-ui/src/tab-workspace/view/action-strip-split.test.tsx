// @vitest-environment jsdom
/**
 * THE ACTION STRIP'S OPT-IN SUBJECT SPLIT (Craft → Designs, D6, item 11).
 *
 *  · without `owner` the strip is one entity's, as in the Workspace: its
 *    sections, its Run slot and its chat toggle in the BOTTOM;
 *  · with `owner` the TOP takes the page's own Run slot, and the BOTTOM's
 *    sections, Run slot and ⋯ belong to the owner — the section buttons
 *    write the OWNER's record, and there is no per-tab chat toggle;
 *  · the private host runtime (`embed.tsx`) never touches the viewer's real
 *    Workspace store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { getWorkspaceStore } from '../runtime/store';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { WorkspaceGateHandles } from './context';

afterEach(cleanup);

const SPACE = 'space-split-test';
const VIEWER = 'viewer-split';

function detail(id: string, kind: string): EntityDetail {
  return { id, kind, title: id, counters: { messages: 3 }, deletedAt: null } as unknown as EntityDetail;
}

const gate = {
  data: {
    detailOf: (id: string) => (id === 'design-1' ? detail(id, 'design') : id === 'task-1' ? detail(id, 'task') : undefined),
    messagesOf: () => undefined,
  },
} as unknown as WorkspaceGateHandles;

function Split({ owner }: { owner: boolean }) {
  const runtime = useEmbeddedRuntime(VIEWER, SPACE);
  const pageChrome = useEntityChromeValue(null);
  const ownerChrome = useEntityChromeValue(null);
  const page = embeddedTab(runtime, owner ? 'page-1' : 'task-1', owner ? 'doc' : 'task');
  const design = embeddedTab(runtime, 'design-1', 'design');
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      <EntityChromeContext.Provider value={pageChrome}>
        <ActionStrip tab={page} {...(owner ? { owner: { tab: design, chrome: ownerChrome } } : {})} />
      </EntityChromeContext.Provider>
    </EmbeddedWorkspace>
  );
}

describe('ActionStrip owner split', () => {
  it('without an owner, is one entity’s strip: no page Run slot up top, chat toggle below', () => {
    const view = render(<Split owner={false} />);
    expect(view.queryByTestId('tws-astrip-page-common')).toBeNull();
    expect(view.getByTestId('tws-astrip-common')).toBeTruthy();
    expect(view.getByTestId('tws-chat-toggle')).toBeTruthy();
    expect(view.getByTestId('tws-action-strip').getAttribute('aria-label')).toBe('Task actions');
  });

  it('with an owner, the TOP holds the page’s Run and the BOTTOM is the owner’s', () => {
    const view = render(<Split owner />);
    const strip = view.getByTestId('tws-action-strip');
    expect(strip.getAttribute('aria-label')).toBe('Design actions');
    /* The page's own Run slot sits in the kind (TOP) section. */
    const top = strip.querySelector('.tws-astrip-section--kind')!;
    expect(within(top as HTMLElement).getByTestId('tws-astrip-page-common')).toBeTruthy();
    /* The owner has no per-tab chat dock: its chat is the host's pane. */
    expect(view.queryByTestId('tws-chat-toggle')).toBeNull();
    /* The sections are the OWNER's: its noun, its message count. */
    const sections = within(strip).getByRole('radiogroup', { name: 'Section' });
    expect(within(sections).getByTestId('tws-section-messages').getAttribute('aria-label')).toBe('Messages, 3');
    expect(within(sections).getByTestId('tws-section-entity').getAttribute('data-tip')).toBe('Design');
  });

  it('a section press writes the owner’s record, in the private store only', () => {
    let runtimeStore: ReturnType<typeof getWorkspaceStore> | null = null;
    function Probe() {
      const runtime = useEmbeddedRuntime(VIEWER, SPACE);
      runtimeStore = runtime.store;
      const pageChrome = useEntityChromeValue(null);
      const ownerChrome = useEntityChromeValue(null);
      const page = embeddedTab(runtime, 'page-1', 'doc');
      const design = embeddedTab(runtime, 'design-1', 'design');
      return (
        <EmbeddedWorkspace runtime={runtime} gate={gate}>
          <EntityChromeContext.Provider value={pageChrome}>
            <ActionStrip tab={page} owner={{ tab: design, chrome: ownerChrome }} />
          </EntityChromeContext.Provider>
        </EmbeddedWorkspace>
      );
    }
    const view = render(<Probe />);
    fireEvent.click(view.getByTestId('tws-section-connections'));
    const state = runtimeStore!.getState();
    const design = state.tabs['design-1'];
    expect(design?.type === 'entity' && design.ui.subview).toBe('connections');
    const page = state.tabs['page-1'];
    expect(page?.type === 'entity' && page.ui.subview).toBe('entity');
    /* The viewer's real Workspace never saw any of it. */
    expect(getWorkspaceStore(VIEWER, SPACE).getState().orderedTabIds).toEqual([]);
  });
});
