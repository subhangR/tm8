// @vitest-environment jsdom
/**
 * THE RELATIONAL PANEL (user ruling 2026-08-16) — a tile's relation chips
 * open its linked entities inline, as real tiles, and the graph is
 * traversable in the panel itself. The rulings under test:
 *
 *   · the sessions chip leads the badge row and counts WITHOUT hydration
 *     (the gate graph's `working_on` projection backs it);
 *   · one open group per tile — a second chip REPLACES the first;
 *   · expanded rows are REAL tiles of their own kind (a session under a
 *     task is the sessions list's tile: liveness mark, terminate ✕);
 *   · the traversal path suppresses ancestors — parent → child → parent
 *     renders once, both in the group rows and in the nested session
 *     tile's task lines.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Connections, EdgeView, EntitySummary } from '@tm8/contract';
import type { ActionContext } from '../domain';
import {
  FIXTURE_SPACE_ID,
  ada,
  docChapterShell,
  docLayoutSpec,
  sessionLive,
  taskGuideLines,
  taskUuidTitle,
} from '../fixtures';
import { relatedOfKind } from './list/related';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

function edge(id: string, type: string, source: EntitySummary, target: EntitySummary): EdgeView {
  return {
    id,
    type,
    source,
    target,
    props: {},
    createdBy: ada,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

function connectionsOfTask(): Connections {
  return {
    outgoing: [
      {
        /* A SAME-KIND PEER BY A DIFFERENT EDGE — the blocking-1 regression:
           the docs counter (108) counts inbound attached_to only, so this
           relates_to doc must never appear under the doc chip's group. */
        type: 'relates_to',
        direction: 'outgoing',
        label: 'related',
        edges: [edge('e-doc2', 'relates_to', taskUuidTitle, docChapterShell)],
      },
    ],
    incoming: [
      {
        /* 108's counted relation, in its real direction: the doc is the
           SOURCE, the decorated entity the destination. */
        type: 'attached_to',
        direction: 'incoming',
        label: 'attached',
        edges: [edge('e-doc', 'attached_to', docLayoutSpec, taskUuidTitle)],
      },
      {
        type: 'working_on',
        direction: 'incoming',
        label: 'worked on by',
        edges: [edge('e-ws', 'working_on', sessionLive, taskUuidTitle)],
      },
    ],
    unresolvedHardDependencyCount: 0,
  };
}

/** The owner row: one doc counted, so the doc badge is a door. */
const ownerTask: EntitySummary = {
  ...taskUuidTitle,
  counters: { ...taskUuidTitle.counters, docs: 1 },
};

function mount(over: Partial<React.ComponentProps<typeof EntityListPanel>> = {}) {
  return render(
    <div className="cv2-root">
      <EntityListPanel
        kind="task"
        rowsFor={() => [ownerTask]}
        ctx={ctx}
        linkedSessionsOf={(id) => (id === ownerTask.id ? [sessionLive] : [])}
        connectionsOf={(id) => (id === ownerTask.id ? connectionsOfTask() : undefined)}
        {...over}
      />
    </div>,
  );
}

describe('relatedOfKind — the one read the chip and the group share', () => {
  const conn = connectionsOfTask();

  it('collects the OTHER side of edges in both directions, kind-filtered and deduped', () => {
    expect(relatedOfKind(ownerTask.id, conn, 'work_session').map((r) => r.id)).toEqual([
      sessionLive.id,
    ]);
    // No edge spec ⇒ every relation: BOTH docs, whatever edge carried them.
    expect(relatedOfKind(ownerTask.id, conn, 'doc').map((r) => r.id).sort()).toEqual(
      [docChapterShell.id, docLayoutSpec.id].sort(),
    );
    // The extra projection merges without duplicating an edge's own summary.
    expect(
      relatedOfKind(ownerTask.id, conn, 'work_session', [sessionLive]).map((r) => r.id),
    ).toEqual([sessionLive.id]);
  });

  it('narrows to the COUNTED relation when an edge spec is given (108 semantics)', () => {
    // The docs counter counts inbound attached_to only — the relates_to doc
    // is a different fact and stays out of the counted group.
    expect(
      relatedOfKind(ownerTask.id, conn, 'doc', [], undefined, {
        type: 'attached_to',
        direction: 'incoming',
      }).map((r) => r.id),
    ).toEqual([docLayoutSpec.id]);
    // Direction matters on its own: the same type in the other direction is
    // not the counted relation either.
    expect(
      relatedOfKind(ownerTask.id, conn, 'doc', [], undefined, {
        type: 'attached_to',
        direction: 'outgoing',
      }),
    ).toEqual([]);
  });

  it('suppresses everything on the traversal path — parent → child → parent renders once', () => {
    const sessionSide: Connections = {
      outgoing: [
        {
          type: 'working_on',
          direction: 'outgoing',
          label: 'working on',
          edges: [
            edge('e-back', 'working_on', sessionLive, ownerTask),
            edge('e-other', 'working_on', sessionLive, taskGuideLines),
          ],
        },
      ],
      incoming: [],
      unresolvedHardDependencyCount: 0,
    };
    const path = new Set([ownerTask.id, sessionLive.id]);
    expect(relatedOfKind(sessionLive.id, sessionSide, 'task', [], path).map((r) => r.id)).toEqual([
      taskGuideLines.id,
    ]);
  });
});

describe('the sessions chip and the inline group', () => {
  it('leads the badge row with the graph-projected count, before any hydration', () => {
    mount({ connectionsOf: () => undefined });
    const chip = screen.getByTestId('session-chip');
    expect(chip.textContent).toBe('1');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the group with REAL session tiles — liveness anatomy, terminate, select', () => {
    const onSelect = vi.fn();
    const onTerminate = vi.fn();
    mount({ onSelect, onTerminate, livenessOf: () => 'live' });

    fireEvent.click(screen.getByTestId('session-chip'));
    const group = screen.getByTestId('related-group');
    expect(group.getAttribute('data-related-kind')).toBe('work_session');

    // The row is the sessions list's own tile, not a poorer chip.
    const tile = within(group).getByText(sessionLive.title);
    expect(group.querySelector('.pn-st')).not.toBeNull();
    fireEvent.click(within(group).getByLabelText('Close session'));
    expect(onTerminate).toHaveBeenCalledWith(sessionLive.id);
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(sessionLive.id);
  });

  it('asks for the row detail when opening an unhydrated row, and says loading', () => {
    const onNeedDetail = vi.fn();
    mount({
      connectionsOf: () => undefined,
      linkedSessionsOf: () => [],
      onNeedDetail,
    });
    // No sessions projected and nothing hydrated: the doc badge is the door.
    fireEvent.click(screen.getByTitle('1 doc — click to show them under this row'));
    expect(onNeedDetail).toHaveBeenCalledWith(ownerTask.id);
    expect(screen.getByTestId('related-loading')).toBeTruthy();
  });

  it('REPLACES the open group when another chip is clicked — one group per tile', () => {
    mount();
    fireEvent.click(screen.getByTestId('session-chip'));
    expect(screen.getByTestId('related-group').getAttribute('data-related-kind')).toBe(
      'work_session',
    );

    fireEvent.click(screen.getByTitle('1 doc — click to show them under this row'));
    const groups = screen.getAllByTestId('related-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.getAttribute('data-related-kind')).toBe('doc');
    expect(within(groups[0]!).getByText(docLayoutSpec.title)).toBeTruthy();

    // Clicking the open chip closes it.
    fireEvent.click(screen.getByTitle('1 doc — click to show them under this row'));
    expect(screen.queryByTestId('related-group')).toBeNull();
  });

  it('renders EXACTLY the counted relation — chip 1 means group 1, never a same-kind stray', () => {
    mount();
    const chip = screen.getByTitle('1 doc — click to show them under this row');
    fireEvent.click(chip);
    const group = screen.getByTestId('related-group');
    // The counted attached_to doc is here; the relates_to doc is NOT —
    // the chip's number and the rows under it are one claim (review, 1).
    expect(within(group).getByText(docLayoutSpec.title)).toBeTruthy();
    expect(within(group).queryByText(docChapterShell.title)).toBeNull();
    expect(group.textContent).toContain('DOCS · 1');
    // The open chip names its group for assistive tech.
    expect(chip.getAttribute('aria-controls')).toBe(group.getAttribute('id'));
  });

  it('keeps the ancestor out of the nested session tile task lines', () => {
    mount({
      linkedTasksOf: (id) =>
        id === sessionLive.id ? [ownerTask, taskGuideLines] : [],
    });
    fireEvent.click(screen.getByTestId('session-chip'));
    const group = screen.getByTestId('related-group');
    fireEvent.click(within(group).getByLabelText('Expand details'));
    const lines = group.querySelectorAll('.pn-st__taskline');
    const labels = [...lines].map((line) => line.textContent);
    expect(labels).toContain(taskGuideLines.title);
    expect(labels).not.toContain(ownerTask.title);
  });

  it('message tallies stay counts — no door on an anchored kind', () => {
    mount();
    // taskUuidTitle carries the legacy neutral message total (87).
    const badge = document.querySelector('[data-count-kind="message"]');
    expect(badge).not.toBeNull();
    expect(badge!.tagName).toBe('SPAN');
  });

  it('traverses through STANDARD-anatomy tiles too — a doc row carries the band', () => {
    // A docs list: standard anatomy end to end. The ruling is all kinds,
    // so traversal must not dead-end at the first non-card tile (review, 2).
    render(
      <div className="cv2-root">
        <EntityListPanel
          kind="doc"
          rowsFor={() => [docLayoutSpec]}
          ctx={ctx}
          linkedSessionsOf={(id) => (id === docLayoutSpec.id ? [sessionLive] : [])}
          connectionsOf={() => undefined}
          livenessOf={() => 'live'}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId('session-chip'));
    const group = screen.getByTestId('related-group');
    expect(group.getAttribute('data-related-kind')).toBe('work_session');
    // The nested row is the real session tile, under a standard tile.
    expect(group.querySelector('.pn-st')).not.toBeNull();
    expect(within(group).getByText(sessionLive.title)).toBeTruthy();
  });

  it('stays closeable when a live update removes the opening chip (group ✕)', () => {
    const emptied: Connections = {
      outgoing: [],
      incoming: [
        {
          type: 'working_on',
          direction: 'incoming',
          label: 'worked on by',
          edges: [edge('e-ws', 'working_on', sessionLive, taskUuidTitle)],
        },
      ],
      unresolvedHardDependencyCount: 0,
    };
    const strippedTask: EntitySummary = {
      ...taskUuidTitle,
      counters: { ...taskUuidTitle.counters, docs: 0 },
    };
    const tree = (rows: readonly EntitySummary[], conn: Connections) => (
      <div className="cv2-root">
        <EntityListPanel
          kind="task"
          rowsFor={() => rows}
          ctx={ctx}
          linkedSessionsOf={() => []}
          connectionsOf={() => conn}
        />
      </div>
    );
    const view = render(tree([ownerTask], connectionsOfTask()));
    fireEvent.click(screen.getByTitle('1 doc — click to show them under this row'));
    expect(screen.getByTestId('related-group')).toBeTruthy();

    // The counter goes to zero and the counted edge disappears: the chip
    // unmounts, the group persists (state captured at click time) — and the
    // group's OWN close is what collapses it (review, 4).
    view.rerender(tree([strippedTask], emptied));
    expect(screen.queryByTitle('1 doc — click to show them under this row')).toBeNull();
    const group = screen.getByTestId('related-group');
    expect(within(group).getByTestId('related-empty')).toBeTruthy();
    fireEvent.click(within(group).getByTestId('related-close'));
    expect(screen.queryByTestId('related-group')).toBeNull();
  });
});
