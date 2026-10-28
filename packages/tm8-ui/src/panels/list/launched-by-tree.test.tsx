// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, chatLaunchPlan, sessionLive } from '../../fixtures';
import { EntityListPanel, buildTileTree } from '../EntityListPanel';

/**
 * A SESSION LAUNCHED BY A SESSION NESTS UNDER IT (task 01a182c8). The shape
 * is the one the owner reported on 2026-10-28: a coordinator ("Entity
 * Improvements") that launched three workers, beside other running sessions
 * and a session a chat launched. Since 330 a launched session has no
 * `parentId` — its launcher is the `launched_by` edge, `state.launchedBy` —
 * so every tree that nested by `parentId` alone drew the workers as roots.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const session = (id: string, title: string, launchedBy: string | null, extra: { status?: string; outcome?: string; sessions?: number } = {}) =>
  ({
    ...sessionLive,
    id,
    title,
    parentId: null,
    counters: { ...sessionLive.counters, sessions: extra.sessions ?? 0 },
    state: {
      ...sessionLive.state,
      status: extra.status ?? 'running',
      outcome: extra.outcome ?? 'open',
      ...(launchedBy ? { launchedBy } : {}),
    },
  }) as EntitySummary;

const chat = { ...chatLaunchPlan, counters: { ...chatLaunchPlan.counters, sessions: 1 } } as EntitySummary;
const coord = session('ses-coord', 'Entity Improvements', null, { sessions: 3 });
const loops = session('ses-loops', 'Loops: a first-class scheduled-work primitive (lead)', coord.id);
const tools = session('ses-tools', 'Tools: a first-class runnable-script primitive (lead)', coord.id);
const ui = session('ses-ui', 'Sessions UI: a session launched by a session shows detached', coord.id);
const mobile = session('ses-mobile', 'TM8 Mobile app', null);
const fromChat = session('ses-from-chat', 'Chat-launched worker', chat.id);
/** Activity order, newest first, as the Running tab reads it on the live node. */
const SESSIONS = [loops, mobile, tools, coord, ui, fromChat];

/**
 * A node double that honours the reads a session tree makes — the tab axes,
 * `idIn` and `launchedBy` — and pages the band's own read at `page` rows, so
 * a launcher can sit on a later page exactly as it does on a busy node.
 */
function sessionNode(sessions: readonly EntitySummary[], page = Infinity) {
  const asked: QueryFilter[] = [];
  const rowsFor = (filter: QueryFilter): readonly EntitySummary[] => {
    asked.push(filter);
    const f = filter as { idIn?: string[]; launchedBy?: string[]; sessionStatus?: string[]; sessionOutcome?: string[] };
    const out = sessions.filter((row) => {
      const st = row.state as unknown as { status: string; outcome: string; launchedBy?: string };
      if (f.idIn && !f.idIn.includes(row.id)) return false;
      if (f.launchedBy && !(st.launchedBy && f.launchedBy.includes(st.launchedBy))) return false;
      if (f.sessionStatus && !f.sessionStatus.includes(st.status)) return false;
      if (f.sessionOutcome && !f.sessionOutcome.includes(st.outcome)) return false;
      return true;
    });
    return f.idIn || f.launchedBy ? out : out.slice(0, page);
  };
  const chatsFor = (filter: QueryFilter): readonly EntitySummary[] => {
    asked.push(filter);
    const f = filter as { idIn?: string[] };
    return f.idIn ? [chat].filter((row) => f.idIn!.includes(row.id)) : [chat];
  };
  const rowsForKind = (kind: string) => (kind === 'chat' ? chatsFor : rowsFor);
  return { rowsFor, rowsForKind, asked };
}

const tileOf = (container: ParentNode, id: string) => container.querySelector<HTMLElement>(`[data-session-node="${id}"]`);
/** The rows drawn at the top level of the tree — not inside any row's children. */
const rootIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-session-node], [data-testid="list-tile"][data-flight-anchor]')]
    .filter((el) => el.closest('[data-testid="list-tile-children"]') === null)
    .map((el) => el.getAttribute('data-session-node') ?? el.getAttribute('data-flight-anchor'));
const childrenOf = (container: HTMLElement, id: string) => {
  const branch = tileOf(container, id)?.closest('.lp__branch') ?? container.querySelector(`[data-flight-anchor="${id}"]`)?.closest('.lp__branch');
  const group = branch?.querySelector<HTMLElement>(':scope > [data-testid="list-tile-children"]');
  return group
    ? [...group.querySelectorAll<HTMLElement>(':scope > .lp__branch')].map(
        (el) => el.querySelector('[data-session-node]')?.getAttribute('data-session-node') ?? el.querySelector('[data-flight-anchor]')?.getAttribute('data-flight-anchor'),
      )
    : [];
};
const open = (container: HTMLElement, id: string) => {
  const arrow =
    tileOf(container, id)?.querySelector<HTMLElement>('.pn-st__arrow')
    ?? container.querySelector<HTMLElement>(`[data-flight-anchor="${id}"] [data-testid="child-count"]`);
  expect(arrow, `a disclosure on ${id}`).toBeTruthy();
  fireEvent.click(arrow!);
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('buildTileTree — a launched session hangs under its launcher', () => {
  it('nests under the launcher when the launcher is on the page', () => {
    const roots = buildTileTree([loops, coord, tools], true);
    expect(roots.map((node) => node.row.id)).toEqual([coord.id]);
    expect(roots[0]!.children.map((node) => node.row.id)).toEqual([loops.id, tools.id]);
    expect(roots[0]!.children.every((node) => node.depth === 1)).toBe(true);
  });

  it('roots the session when its launcher is absent — the list brings the launcher in as context', () => {
    const roots = buildTileTree([loops, tools], true);
    expect(roots.map((node) => node.row.id)).toEqual([loops.id, tools.id]);
    // Not a `parent_id` orphan: the `↑ parent` crumb is for a parent, not a launcher.
    expect(roots.every((node) => node.parentOutside === undefined)).toBe(true);
  });
});

describe('the Sessions list — a coordinator and the workers it launched', () => {
  const panel = (opts: { page?: number; sessions?: readonly EntitySummary[]; selectedId?: string; inline?: boolean } = {}) => {
    const node = sessionNode(opts.sessions ?? SESSIONS, opts.page);
    const view = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={node.rowsFor}
        rowsForKind={node.rowsForKind}
        ctx={ctx}
        {...(opts.selectedId ? { selectedId: opts.selectedId } : {})}
        {...(opts.inline ? { toolbarInline: true, chrome: 'toolbar' as const } : {})}
      />,
    );
    return { ...view, asked: node.asked };
  };

  it('launcher on the page: the workers nest under it, not beside it', () => {
    const { container } = panel();
    expect(rootIds(container)).not.toContain(loops.id);
    expect(rootIds(container)).toContain(coord.id);
    expect(tileOf(container, coord.id)!.getAttribute('data-children')).toBe('3');
    open(container, coord.id);
    expect(childrenOf(container, coord.id)).toEqual([loops.id, tools.id, ui.id]);
  });

  it('launcher on a LATER page: it is read by id and drawn as a context row holding its workers', () => {
    // A page of three: the workers are on it, their coordinator is not.
    const { container, asked } = panel({ page: 3, sessions: [loops, tools, ui, mobile, coord] });
    expect(asked).toContainEqual({ idIn: [coord.id] });
    expect(rootIds(container)).toEqual([coord.id]);
    const launcher = tileOf(container, coord.id)!;
    expect(launcher.getAttribute('data-context')).toBe('true');
    // A context row holds only what matched, and says so in its count.
    expect(launcher.getAttribute('data-children')).toBe('3');
    open(container, coord.id);
    expect(childrenOf(container, coord.id)).toEqual([loops.id, tools.id, ui.id]);
  });

  it('launcher on ANOTHER tab: a completed worker is a root that names its running coordinator (§5.3.1 case 7)', () => {
    const done = session('ses-done', 'Done worker', coord.id, { status: 'exited', outcome: 'completed' });
    const { container, getByRole } = panel({ sessions: [coord, loops, done] });
    fireEvent.click(getByRole('tab', { name: /^Completed/ }));
    // The coordinator is not drawn on Completed: the worker stays a root and its crumb carries the lineage.
    expect(rootIds(container)).toEqual([done.id]);
    expect(tileOf(container, done.id)!.querySelector('[data-testid="session-row-crumb"]')?.textContent).toMatch(/^↳ under /);
  });

  it('a session a CHAT launched nests under that chat, drawn as a chat', () => {
    const { container, asked } = panel({ sessions: [mobile, fromChat] });
    expect(asked).toContainEqual({ idIn: [chat.id] });
    expect(rootIds(container)).toEqual([mobile.id, chat.id]);
    const launcher = container.querySelector<HTMLElement>(`[data-flight-anchor="${chat.id}"]`)!;
    expect(launcher.getAttribute('data-context')).toBe('true');
    expect(launcher.getAttribute('data-children')).toBe('1');
  });

  it('a launcher that cannot be read leaves the session a root, never hidden', () => {
    const lost = session('ses-lost', 'Launcher gone', 'ses-deleted');
    const { container } = panel({ sessions: [lost] });
    expect(rootIds(container)).toEqual([lost.id]);
  });

  it('selecting a worker opens its coordinator, so the selection is on screen', () => {
    const { container } = panel({ selectedId: ui.id });
    expect(childrenOf(container, coord.id)).toContain(ui.id);
  });
});

describe('the chat list — chat → coordinator → its workers', () => {
  it('opening the coordinator under its chat reads and nests the sessions it launched', () => {
    const coordFromChat = session('ses-coord', 'Entity Improvements', chat.id, { sessions: 3 });
    const sessions = [coordFromChat, loops, tools, ui];
    const node = sessionNode(sessions);
    const { container } = render(
      <EntityListPanel kind="chat" rowsFor={node.rowsForKind('chat')} rowsForKind={node.rowsForKind} ctx={ctx} />,
    );
    expect(rootIds(container)).toEqual([chat.id]);
    open(container, chat.id);
    expect(childrenOf(container, chat.id)).toEqual([coordFromChat.id]);
    open(container, coordFromChat.id);
    expect(node.asked).toContainEqual({ launchedBy: [coordFromChat.id] });
    expect(childrenOf(container, coordFromChat.id)).toEqual([loops.id, tools.id, ui.id]);
  });
});
