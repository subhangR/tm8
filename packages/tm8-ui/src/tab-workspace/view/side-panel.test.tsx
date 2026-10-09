// @vitest-environment jsdom
/**
 * THE SIDE COLUMN (task 01a122b9): Links · Messages · Chat open beside the
 * entity body, the lit strip icon closes the column, and the lists read the
 * same peers and messages the old full-page views did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { useStore } from 'zustand';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { EntityTabRecord } from '../runtime/types';
import type { WorkspaceGateHandles } from './context';
import { previewOf } from './SideMessages';
import { sideLinksOf } from './SideLinks';
import { openSideSection, sidePatch, sideSectionOfSubview } from './sideSection';

afterEach(cleanup);

function tab(chat?: EntityTabRecord['ui']['chat']): EntityTabRecord {
  return { id: 't1', type: 'entity', kind: 'task', entityId: 't1', ui: { subview: 'entity', ...(chat ? { chat } : {}) } };
}

describe('side section state', () => {
  it('reads closed, the default chat section, and a kind without chat', () => {
    expect(openSideSection(tab(), true)).toBeNull();
    expect(openSideSection(tab({ open: true }), true)).toBe('chat');
    expect(openSideSection(tab({ open: true }), false)).toBe('messages');
    expect(openSideSection(tab({ open: true, section: 'links' }), true)).toBe('links');
  });

  it('opens on a section, switches between sections, and closes on the lit one', () => {
    expect(sidePatch(tab(), 'links', true)).toEqual({ chat: { open: true, section: 'links' } });
    expect(sidePatch(tab({ open: true, section: 'messages' }), 'links', true)).toEqual({
      chat: { open: true, section: 'links' },
    });
    expect(sidePatch(tab({ open: true, section: 'links' }), 'links', true)).toEqual({ chat: { open: false } });
    /* Not a toggle: already showing stays showing. */
    expect(sidePatch(tab({ open: true, section: 'links' }), 'links', true, false)).toEqual({
      chat: { open: true, section: 'links' },
    });
  });

  it('keeps the last section when a stored copy drops the field (an older node)', () => {
    const t = { ...tab(), id: 'kept' };
    sidePatch(t, 'links', true);
    /* The node's normalised copy comes back without `section`. */
    expect(openSideSection({ ...t, ui: { ...t.ui, chat: { open: true } } }, true)).toBe('links');
  });

  it('reads the old full-page subviews as side sections', () => {
    expect(sideSectionOfSubview('connections')).toBe('links');
    expect(sideSectionOfSubview('messages')).toBe('messages');
    expect(sideSectionOfSubview('entity')).toBeNull();
  });
});

describe('previewOf', () => {
  it('reads markdown as one plain line', () => {
    expect(previewOf('# Title\n\n- **bold** and `code`\n- [a link](http://x)\n\n```\nblock\n```\ndone')).toBe(
      'Title bold and code a link done',
    );
  });
});

function summary(id: string, kind: string, updatedAt: string): EntitySummary {
  return { id, kind, title: id, createdAt: updatedAt, updatedAt } as unknown as EntitySummary;
}

describe('sideLinksOf', () => {
  it('is one flat list, newest first, with the parent and children pilled', () => {
    const self = 'self';
    const detail = {
      id: self,
      kind: 'task',
      connections: {
        outgoing: [
          {
            type: 'depends_on',
            direction: 'outgoing',
            edges: [
              {
                id: 'e1',
                type: 'depends_on',
                source: summary(self, 'task', '2026-10-01T00:00:00Z'),
                target: summary('dep', 'task', '2026-10-01T00:00:00Z'),
                createdAt: '2026-10-03T00:00:00Z',
              },
            ],
          },
        ],
        incoming: [],
        unresolvedHardDependencyCount: 0,
      },
      hierarchy: {
        parent: summary('parent', 'task', '2026-10-05T00:00:00Z'),
        children: { items: [summary('child', 'task', '2026-09-01T00:00:00Z')], nextCursor: null },
        path: [],
      },
    } as unknown as EntityDetail;
    const links = sideLinksOf(detail, undefined);
    expect(links.map((l) => l.peer.id)).toEqual(['parent', 'dep', 'child']);
    expect(links.find((l) => l.peer.id === 'parent')?.relation).toBe('Parent');
    expect(links.find((l) => l.peer.id === 'child')?.relation).toBe('Child');
  });
});

const gate = {
  data: {
    detailOf: (id: string) =>
      id === 'task-1' ? ({ id, kind: 'task', title: id, counters: { messages: 2 }, deletedAt: null } as unknown as EntityDetail) : undefined,
    messagesOf: () => undefined,
  },
} as unknown as WorkspaceGateHandles;

function Strip() {
  const runtime = useEmbeddedRuntime('viewer-side', 'space-side-test');
  const chrome = useEntityChromeValue(null);
  embeddedTab(runtime, 'task-1', 'task');
  const page = useStore(runtime.store, (s) => s.tabs['task-1']) as EntityTabRecord;
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      <EntityChromeContext.Provider value={chrome}>
        <ActionStrip tab={page} />
      </EntityChromeContext.Provider>
      <output data-testid="ui">{JSON.stringify(page.ui)}</output>
    </EmbeddedWorkspace>
  );
}

describe('the strip drives the side column', () => {
  it('Links opens the column on links, again closes it; the body stays the entity', () => {
    const view = render(<Strip />);
    const ui = () => JSON.parse(view.getByTestId('ui').textContent ?? '{}');
    expect(view.queryByTestId('tws-section-entity')).toBeNull();
    const links = view.getByTestId('tws-section-connections');
    expect(links.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(links);
    expect(ui()).toMatchObject({ subview: 'entity', chat: { open: true, section: 'links' } });
    expect(view.getByTestId('tws-section-connections').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(view.getByTestId('tws-section-messages'));
    expect(ui()).toMatchObject({ chat: { open: true, section: 'messages' } });
    fireEvent.click(view.getByTestId('tws-section-messages'));
    expect(ui().chat.open).toBe(false);
  });
});
