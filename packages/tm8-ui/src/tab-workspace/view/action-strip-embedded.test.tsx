// @vitest-environment jsdom
/**
 * THE ACTION STRIP IN A PRIVATE HOST (Craft): one entity's strip, exactly as
 * in the Workspace — the split by subject is gone.
 *
 *  · no page Run slot up top and no Section radio group: Links · Messages ·
 *    Chat are the side column's toggles, Run and Expand sit below;
 *  · Links opens the tab's own side column and never swaps its body;
 *  · the private host runtime (`embed.tsx`) never touches the viewer's real
 *    Workspace store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { getWorkspaceStore } from '../runtime/store';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { WorkspaceGateHandles } from './context';

afterEach(cleanup);

const SPACE = 'space-embedded-strip';
const VIEWER = 'viewer-embedded';

function detail(id: string, kind: string): EntityDetail {
  return { id, kind, title: id, counters: { messages: 3 }, deletedAt: null } as unknown as EntityDetail;
}

const gate = {
  data: {
    detailOf: (id: string) => (id === 'craft-1' ? detail(id, 'craft') : id === 'doc-1' ? detail(id, 'doc') : undefined),
    messagesOf: () => undefined,
  },
} as unknown as WorkspaceGateHandles;

let runtimeStore: ReturnType<typeof getWorkspaceStore> | null = null;

function Strip({ id, kind }: { id: string; kind: string }) {
  const runtime = useEmbeddedRuntime(VIEWER, SPACE);
  runtimeStore = runtime.store;
  const chrome = useEntityChromeValue(null);
  const tab = embeddedTab(runtime, id, kind);
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      <EntityChromeContext.Provider value={chrome}>
        <ActionStrip tab={tab} />
      </EntityChromeContext.Provider>
    </EmbeddedWorkspace>
  );
}

describe('ActionStrip in a private host', () => {
  it('is one entity’s strip: no split, the side toggles and Run below', () => {
    const view = render(<Strip id="craft-1" kind="craft" />);
    expect(view.getByTestId('tws-action-strip').getAttribute('aria-label')).toBe('Craft actions');
    expect(view.queryByTestId('tws-astrip-page-common')).toBeNull();
    expect(view.queryByRole('radiogroup', { name: 'Section' })).toBeNull();
    expect(view.getByTestId('tws-astrip-side')).toBeTruthy();
    expect(view.getByTestId('tws-section-messages').getAttribute('aria-label')).toBe('Messages, 3');
    expect(view.getAllByTestId('tws-astrip-common')).toHaveLength(1);
    expect(view.getByTestId('tws-expand')).toBeTruthy();
  });

  it('Links opens the tab’s side column and leaves its body, in the private store only', () => {
    const view = render(<Strip id="doc-1" kind="doc" />);
    fireEvent.click(view.getByTestId('tws-section-connections'));
    const tab = runtimeStore!.getState().tabs['doc-1'];
    expect(tab?.type === 'entity' && tab.ui.subview).toBe('entity');
    expect(tab?.type === 'entity' && tab.ui.chat?.open).toBe(true);
    expect(tab?.type === 'entity' && tab.ui.chat?.section).toBe('links');
    expect(getWorkspaceStore(VIEWER, SPACE).getState().orderedTabIds).toEqual([]);
  });
});
