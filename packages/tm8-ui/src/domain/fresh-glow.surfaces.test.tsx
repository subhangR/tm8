// @vitest-environment jsdom
/**
 * The new-entity glow and the deleted-entity exit (R40, R41) on every item
 * surface: list tiles (all three anatomies), the Workspace tab strip, the
 * start surface / chooser Recent rows, the conversation list and graph nodes.
 * Each surface reads the same `freshEntities` store; nothing glows on load.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntityId, EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '.';
import { FIXTURE_SPACE_ID, docLayoutSpec, sessionLive, taskGuideLines } from '../fixtures';
import { EntityListPanel } from '../panels';
import { createDomainStore } from '../data/project/domain-store';
import { createWorkspaceStore } from '../tab-workspace/runtime/store';
import { WorkspaceProvider, type WorkspaceContextValue } from '../tab-workspace/view/context';
import { Chooser } from '../tab-workspace/view/Chooser';
import { TabStrip } from '../tab-workspace/view/TabStrip';
import type { TabId, TabRecord } from '../tab-workspace/runtime/types';
import { MessagesScreen } from '../messages/MessagesScreen';
import type { MessagesData } from '../messages/useMessagesData';
import { GraphView } from '../graph/GraphView';
import { LEAVING_MS, freshEntities } from './freshEntities';

let seq = 0;
function live(type: 'entity.upsert' | 'entity.deleted', row: EntitySummary): void {
  const now = new Date().toISOString();
  seq += 1;
  freshEntities.observe({
    type,
    entity: { ...row, createdAt: type === 'entity.upsert' ? now : row.createdAt },
    spaceId: row.spaceId,
    seq,
    occurredAt: now,
    schemaVersion: 1,
  } as DurableWorkspaceEvent);
}

afterEach(() => {
  cleanup();
  act(() => freshEntities.reset());
  vi.useRealTimers();
});

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor = (rows: readonly EntitySummary[]) => (_filter: QueryFilter): readonly EntitySummary[] => rows;

describe('list tiles', () => {
  it.each([
    ['task', taskGuideLines],
    ['doc', docLayoutSpec],
    ['work_session', sessionLive],
  ] as const)('a %s tile glows only once created live, and names itself new', (kind, row) => {
    const { container } = render(<EntityListPanel kind={kind} rowsFor={rowsFor([row])} ctx={ctx} />);
    const tile = () => container.querySelector<HTMLElement>('[data-testid="list-tile"]')!;
    expect(tile().hasAttribute('data-fresh')).toBe(false);
    act(() => live('entity.upsert', row));
    expect(tile().hasAttribute('data-fresh')).toBe(true);
    expect(tile().style.getPropertyValue('--pn-fresh-delay')).toMatch(/^-\d+ms$/);
    expect(tile().textContent).toContain(', new');
  });

  it('a row deleted live stays, inert, for its exit, then goes', () => {
    vi.useFakeTimers();
    let rows: readonly EntitySummary[] = [taskGuideLines];
    const { container, rerender } = render(
      <EntityListPanel kind="task" rowsFor={(_f: QueryFilter) => rows} ctx={ctx} />,
    );
    act(() => live('entity.deleted', taskGuideLines));
    rows = [];
    rerender(<EntityListPanel kind="task" rowsFor={(_f: QueryFilter) => rows} ctx={ctx} />);
    const tile = container.querySelector<HTMLElement>('[data-testid="list-tile"]');
    expect(tile?.hasAttribute('data-leaving')).toBe(true);
    expect(tile?.getAttribute('aria-hidden')).toBe('true');
    expect(tile?.hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(LEAVING_MS));
    expect(container.querySelector('[data-testid="list-tile"]')).toBeNull();
  });
});

function workspace(children: React.ReactNode, tabs: TabRecord[] = [], active: TabId | null = null, rows: EntitySummary[] = []) {
  const store = createWorkspaceStore('viewer-1', FIXTURE_SPACE_ID);
  const domain = createDomainStore();
  domain.store.getState().ingestSummaries(rows);
  store.setState((s) => ({
    ...s,
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    orderedTabIds: tabs.map((t) => t.id),
    presentation: active ? { surface: 'tab', tabId: active } : s.presentation,
  }) as typeof s);
  const runtime = { registerEffect: () => () => {}, hooks: { toast: () => {} } };
  const gate = {
    data: {
      rowsFor: (kind: string) => () => rows.filter((r) => r.kind === kind),
      ensureKind: () => {},
      domain,
      seam: { entity: () => new Promise(() => {}) },
      refetchDetail: () => {},
      livenessOf: () => 'unknown',
    },
  };
  const value = {
    runtime, store, dispatch: vi.fn(() => ({ ok: true })), viewerId: 'viewer-1', spaceId: FIXTURE_SPACE_ID, gate,
  } as unknown as WorkspaceContextValue;
  return render(<WorkspaceProvider value={value}>{children}</WorkspaceProvider>);
}

describe('start surface / chooser Recent rows', () => {
  it('a Recent row glows once created live', () => {
    workspace(<Chooser tabId={null} variant="start" restoreSlot={null} />, [], null, [taskGuideLines]);
    const row = () => screen.getByTestId('tws-chooser-row');
    expect(row().hasAttribute('data-fresh')).toBe(false);
    act(() => live('entity.upsert', taskGuideLines));
    expect(row().hasAttribute('data-fresh')).toBe(true);
    expect(row().textContent).toContain(', new');
  });
});

describe('Workspace tab strip', () => {
  const tab = (id: string, entity: EntitySummary): TabRecord => ({
    id: id as TabId, type: 'entity', kind: entity.kind as never, entityId: entity.id, ui: { subview: 'entity' },
  });
  const doc = { ...docLayoutSpec, kind: 'doc' } as EntitySummary;

  it('an inactive tab glows and says new; the active one carries the mark but CSS keeps it plain', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    workspace(<TabStrip />, [tab('t1', taskGuideLines), tab('t2', doc)], 't1' as TabId, [taskGuideLines, doc]);
    act(() => {
      live('entity.upsert', taskGuideLines);
      live('entity.upsert', doc);
    });
    const el = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
    expect(el('t2').hasAttribute('data-fresh')).toBe(true);
    expect(el('t2').querySelector('[role="tab"]')?.getAttribute('aria-label')).toMatch(/, new$/);
    // The active tab's suppression is tabstrip.css's `[data-active][data-fresh]`.
    expect(el('t1').hasAttribute('data-active')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('a deleted entity\'s tab is tinted but never collapses or goes inert', () => {
    workspace(<TabStrip />, [tab('t1', taskGuideLines)], null, [taskGuideLines]);
    act(() => live('entity.deleted', taskGuideLines));
    const el = document.querySelector<HTMLElement>('[data-tab-id="t1"]')!;
    expect(el.hasAttribute('data-leaving-tint')).toBe(true);
    expect(el.hasAttribute('data-leaving')).toBe(false);
    expect(el.hasAttribute('inert')).toBe(false);
  });
});

describe('conversation list', () => {
  it('a conversation created live glows', () => {
    const data = {
      mode: 'conversations', setMode: () => {},
      conversations: [{
        id: taskGuideLines.id as EntityId, kind: taskGuideLines.kind, title: 'Chat', messageCount: 0,
        activityAt: taskGuideLines.activityAt, unread: null, lastMessage: null,
      }],
      conversationsError: null, hasMore: false, loadingMore: false, loadMore: () => {},
      kindFilter: null, setKindFilter: () => {}, selectedId: null, select: () => {}, selected: null,
      allMessages: null, allMessagesError: null, allHasMore: false, allLoadingMore: false, loadMoreAll: () => {},
      connection: 'live',
    } as unknown as MessagesData;
    render(<MessagesScreen data={data} seam={{} as never} spaceId={FIXTURE_SPACE_ID} />);
    const row = () => screen.getByTestId('messages-conversation-row');
    expect(row().hasAttribute('data-fresh')).toBe(false);
    act(() => live('entity.upsert', taskGuideLines));
    expect(row().hasAttribute('data-fresh')).toBe(true);
  });
});

describe('graph nodes', () => {
  it('a node created live carries the fresh mark and keeps its position', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const { container } = render(
      <GraphView
        nodes={[taskGuideLines]}
        edges={[]}
        now={taskGuideLines.activityAt}
        onSelect={() => {}}
        livenessOf={() => ({ verdict: 'unknown' }) as never}
      />,
    );
    const node = () => container.querySelector<HTMLElement>('.gv-node')!;
    expect(node()).not.toBeNull();
    expect(node().hasAttribute('data-fresh')).toBe(false);
    act(() => live('entity.upsert', taskGuideLines));
    expect(node().hasAttribute('data-fresh')).toBe(true);
    expect(node().style.left).not.toBe('');
    expect(node().title).toMatch(/, new$/);
    vi.unstubAllGlobals();
  });
});
