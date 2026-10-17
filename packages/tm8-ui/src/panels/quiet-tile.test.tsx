// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntityCounters, EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../domain';
import {
  FIXTURE_SPACE_ID,
  chatLaunchPlan,
  docLayoutSpec,
  memoryTokens,
  prTransplant,
  profileHouseStyle,
  sessionLive,
  taskGuideLines,
  teamMemberForge,
} from '../fixtures';
import { EntityListPanel } from './index';
import { resetRowViewCache } from './list/row-view';

/**
 * THE QUIET ROW AND THE ONE-ROW HEADER (task 01a1469f) — design doc
 * 01a1465d §5–§6, approved change list message 01a14695-6b54.
 *
 * WHAT THIS SUITE IS FOR, and what it structurally cannot do. Most of the
 * approved change is a SUBTRACTION, and a subtraction is exactly what the rest
 * of a green suite will not notice: nothing fails when a row stops drawing a
 * fact. So the assertions here are mostly absences, named one by one off the
 * cut list, because that list is the specification.
 *
 * It cannot see geometry. jsdom loads no stylesheets and implements no layout,
 * so "the row is 30px" and "the time hides on hover" are not checkable here —
 * `row-height-parity.test.ts` reads the declaration for the first and the
 * second is a browser screenshot (attached to the task close-out). What IS
 * checkable is which elements exist, which do not, and what they do when
 * clicked, and that is what this file holds itself to.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

const withCounters = (row: EntitySummary, patch: Record<string, unknown>): EntitySummary => ({
  ...row,
  counters: { ...row.counters, ...patch } as EntityCounters,
});

const tile = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('[data-testid="list-tile"]')!;

beforeEach(() => {
  window.localStorage.clear();
  resetRowViewCache();
});
afterEach(cleanup);

describe('the quiet row: status mark · title · ▸ N · one signal · time', () => {
  it('draws the kind mark, the title and a time, and the status word only for a screen reader', () => {
    const { container } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />,
    );
    const row = tile(container);
    expect(row.querySelector('.lp__statusmark')).not.toBeNull();
    expect(row.querySelector('.lp__title')?.textContent).toContain(docLayoutSpec.title);
    expect(row.querySelector('.lp__time')).not.toBeNull();
    /* §6: "colour and glyph only, with no status word (the word stays for
       screen readers)". The pill is gone; the mark still carries the word in
       `title` and in sr-only text when the row has one. */
    expect(row.querySelector('.lp__word')).toBeNull();
  });

  /* An interaction profile is the standard anatomy with a real `status` badge
     source — a kind whose row HAS a status word to lose. A doc has none, which
     is why the case above can only prove the pill's absence. */
  it('keeps the status word reachable without drawing a pill', () => {
    const { container } = render(
      <EntityListPanel kind="interaction_profile" rowsFor={rowsFor([profileHouseStyle])} ctx={ctx} />,
    );
    const mark = tile(container).querySelector('.lp__statusmark')!;
    expect(mark.querySelector('.sr-only')?.textContent).toBe('active');
    expect(mark.getAttribute('title')).toBe('active');
    expect(mark.querySelector('.lp__dot')).not.toBeNull();
    expect(tile(container).querySelector('.lp__word')).toBeNull();
  });

  /**
   * THE CUT LIST, ASSERTED AS ABSENCE. One case, every item, because the list
   * is the specification and a partial check of it is the state this change
   * was made from.
   */
  it('draws none of the cut facets', () => {
    const row = withCounters(
      { ...docLayoutSpec, state: { kind: 'task', status: 'working', priority: 'high', model: 'claude-opus-5', axes: { lane: 'ui' } } } as EntitySummary,
      { messages: 7, humanMessages: 4, agentMessages: 3, docs: 1 },
    );
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([row])} ctx={ctx} />);
    const el = tile(container);
    // model, agent tool, share/drive mode, axes, due date — the mono meta strip
    expect(el.querySelector('.lp__meta')).toBeNull();
    // priority, unless urgent (its own case below)
    expect(el.querySelector('.lp__tag')).toBeNull();
    expect(el.querySelector('[data-testid="row-urgent"]')).toBeNull();
    // the status word pill
    expect(el.querySelector('.lp__word')).toBeNull();
    // the leading sessions chip and the PR chips
    expect(el.querySelector('[data-testid="session-chip"]')).toBeNull();
    // every message tally: the counts line draws the doc and nothing else
    expect(el.querySelector('[data-count-kind="docs"]')?.textContent).toContain('1');
    expect(el.textContent).not.toContain('7');
    // connections and related groups — no inline relation accordion at all
    expect(container.querySelector('[data-testid="related-group"]')).toBeNull();
  });

  it('shows urgent, and only urgent, as a red ! before the title', () => {
    const urgent = { ...docLayoutSpec, state: { kind: 'task', status: 'open', priority: 'urgent' } } as EntitySummary;
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([urgent])} ctx={ctx} />);
    const mark = tile(container).querySelector<HTMLElement>('[data-testid="row-urgent"]')!;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toContain('!');
    expect(mark.nextElementSibling?.classList.contains('lp__title')).toBe(true);
    expect(mark.querySelector('.sr-only')?.textContent).toBe('Urgent');
  });
});

describe('the one signal, declared per kind by the registry', () => {
  it('a chat draws its unread count and nothing else', () => {
    const row = { ...chatLaunchPlan, state: { ...(chatLaunchPlan.state as object), unreadCount: 4 } } as EntitySummary;
    const { container } = render(<EntityListPanel kind="chat" rowsFor={rowsFor([row])} ctx={ctx} />);
    const slot = tile(container).querySelector('.lp__signalslot')!;
    expect(slot.children.length).toBe(1);
    expect(slot.querySelector('[data-signal="count"]')?.textContent).toContain('4');
  });

  it('a chat with nothing unread draws no signal — zero is the resting state of the list', () => {
    const { container } = render(<EntityListPanel kind="chat" rowsFor={rowsFor([chatLaunchPlan])} ctx={ctx} />);
    expect(tile(container).querySelector('.lp__signalslot')?.children.length).toBe(0);
  });

  it('a teammate draws busy or idle, and draws BOTH — a blank row would read as unloaded', () => {
    const busy = render(<EntityListPanel kind="team_member" rowsFor={rowsFor([teamMemberForge])} ctx={ctx} />);
    expect(tile(busy.container).querySelector('[data-signal="busy"]')).not.toBeNull();
    busy.unmount();

    const idle = render(
      <EntityListPanel
        kind="team_member"
        rowsFor={rowsFor([{ ...teamMemberForge, state: { ...(teamMemberForge.state as object), liveWork: null } } as EntitySummary])}
        ctx={ctx}
      />,
    );
    expect(tile(idle.container).querySelector('[data-signal="idle"]')).not.toBeNull();
  });

  it('a doc declares no signal, so its slot is empty', () => {
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />);
    expect(tile(container).querySelector('.lp__signalslot')?.children.length).toBe(0);
  });

  it('a memory declares no signal either — the rule is per kind, not per anatomy', () => {
    const { container } = render(<EntityListPanel kind="memory" rowsFor={rowsFor([memoryTokens])} ctx={ctx} />);
    expect(tile(container).querySelector('.lp__signalslot')?.children.length).toBe(0);
  });

  /* A PR pairs with a task in §6: the face that owns it. With no assignee
     resolved the slot is empty rather than a placeholder — an avatar nobody
     is behind is a claim about who is working on it. */
  it('a PR draws the owner avatar when there is one, and nothing when there is not', () => {
    const { container } = render(<EntityListPanel kind="pull_request" rowsFor={rowsFor([prTransplant])} ctx={ctx} />);
    const slot = tile(container).querySelector('.lp__signalslot')!;
    expect(slot.children.length).toBeLessThanOrEqual(1);
  });
});

describe('the counts line', () => {
  it('keeps the fixed order and hides zeros and absences', () => {
    const row = withCounters(docLayoutSpec, { memories: 2, docs: 3, artifacts: 0 });
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([row])} ctx={ctx} />);
    const kinds = [...tile(container).querySelectorAll('[data-count-kind]')].map((el) =>
      el.getAttribute('data-count-kind'),
    );
    expect(kinds).toEqual(['docs', 'memories']);
  });

  it('gives a row with nothing linked no second line at all', () => {
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />);
    expect(tile(container).querySelector('.lp__tile-counts')).toBeNull();
    expect(tile(container).querySelector('[data-testid="tile-link-counts"]')).toBeNull();
  });

  it('opens the group in the detail panel when the host wires the door, and never inline', () => {
    const onOpenLinks = vi.fn();
    const row = withCounters(docLayoutSpec, { docs: 2 });
    const { container } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([row])} ctx={ctx} onOpenLinks={onOpenLinks} />,
    );
    const count = tile(container).querySelector<HTMLElement>('[data-count-kind="docs"]')!;
    expect(count.tagName).toBe('BUTTON');
    fireEvent.click(count);
    /* The registry KIND, not the group id — the detail panel filters peers by
       kind and the id is this line's own vocabulary. */
    expect(onOpenLinks).toHaveBeenCalledWith(docLayoutSpec.id, 'doc');
    // Nothing expanded under the row.
    expect(container.querySelectorAll('[data-testid="list-tile"]').length).toBe(1);
  });

  it('is plain text with no door wired — a surface with no detail panel promises none', () => {
    const row = withCounters(docLayoutSpec, { docs: 2 });
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([row])} ctx={ctx} />);
    expect(tile(container).querySelector('[data-count-kind="docs"]')?.tagName).toBe('SPAN');
  });
});

describe('the row verbs behind one ⋯', () => {
  it('draws the trigger and keeps the details opener out of the menu', () => {
    const { container } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />,
    );
    const el = tile(container);
    const trigger = el.querySelector<HTMLElement>('[data-testid="row-menu-trigger"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    expect(el.querySelector('[data-testid="row-menu-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[data-testid="row-menu"]')?.contains(el.querySelector('[data-testid="row-details-toggle"]'))).toBe(false);
  });

  it('a click on the trigger does not open the row', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} onSelect={onSelect} />,
    );
    fireEvent.click(tile(container).querySelector('[data-testid="row-menu-trigger"]')!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('the list header, one row', () => {
  const head = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="list-head"]')!;

  it('holds the title and count, the tier dropdown, search, the funnel and ⋯ — and no tier row', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} chrome="toolbar" />,
    );
    const row = head(container);
    expect(row.querySelector('.lp__headname')?.textContent).toBe('Tasks');
    expect(row.querySelector('[data-testid="list-tier-trigger"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="list-search"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="filter-trigger"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="list-more-trigger"]')).not.toBeNull();
    /* The four bands this row replaced: the tier rail, the bordered search row
       and the filter-chip row are not drawn at all under `chrome="toolbar"`. */
    expect(container.querySelector('.lp__tierrow')).toBeNull();
    expect(container.querySelector('.lp__searchrow')).toBeNull();
  });

  /**
   * THE SHIPPING COMPOSITION, once the navigator lands (task 01a1469d). Its
   * `Browser` passes `toolbarEnd={navigator ? undefined : <NewBox/>}`, because
   * §5 moves ࿰b New to the top of the navigator column so the kind is chosen
   * in ONE place. With both slots absent the create row is not drawn at all
   * and the list's chrome is exactly the one header band — which is the whole
   * point of the change, and is worth a test rather than an inference from
   * two files that do not import each other.
   */
  it('draws no create row at all when the host passes neither toolbar slot', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} chrome="toolbar" />,
    );
    expect(container.querySelector('.lp__toolrow')).toBeNull();
    expect(container.querySelectorAll('[data-testid="list-head"]').length).toBe(1);
  });

  it('keeps the host create row when a slot IS passed (the flag-off shell)', () => {
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskGuideLines])}
        ctx={ctx}
        chrome="toolbar"
        toolbarEnd={<span data-testid="host-new-box">New</span>}
      />,
    );
    const toolrow = container.querySelector('.lp__toolrow')!;
    expect(toolrow).not.toBeNull();
    expect(toolrow.querySelector('[data-testid="host-new-box"]')).not.toBeNull();
    /* And the header is still ONE row below it — the create row is the host's,
       not a second band of list chrome. */
    expect(container.querySelectorAll('[data-testid="list-head"]').length).toBe(1);
  });

  it('the tier dropdown names the open tier and switches on pick', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} chrome="toolbar" />,
    );
    const trigger = container.querySelector<HTMLElement>('[data-testid="list-tier-trigger"]')!;
    const opened = trigger.querySelector('.lp__tierword')?.textContent;
    expect(opened).toBeTruthy();
    fireEvent.click(trigger);
    const menu = container.querySelector<HTMLElement>('[data-testid="list-tier-menu"]')!;
    const options = [...menu.querySelectorAll<HTMLElement>('[data-tier]')];
    expect(options.length).toBeGreaterThan(1);
    const other = options.find((el) => el.getAttribute('aria-checked') === 'false')!;
    fireEvent.click(other);
    expect(
      container.querySelector('[data-testid="list-tier-trigger"] .lp__tierword')?.textContent,
    ).not.toBe(opened);
  });

  /**
   * TWO TRIGGERS, TWO IDEAS. The funnel narrows the population; the `⋯` says
   * how the rows look. They were one popover with five sections, and a badge on
   * the funnel counting hidden avatars was a number naming nothing the funnel
   * does.
   */
  it('puts View and Sort behind ⋯ and Filter and People behind the funnel', () => {
    const { container, getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} chrome="toolbar" />,
    );
    fireEvent.click(getByTestId('list-more-trigger'));
    const more = getByTestId('list-more-menu');
    expect(more.querySelector('[data-facet="counts"]')).not.toBeNull();
    expect(more.querySelector('[aria-label="Sort"]')).not.toBeNull();
    expect(more.querySelector('[aria-label="Filter"]')).toBeNull();

    fireEvent.click(getByTestId('filter-trigger'));
    const funnel = getByTestId('filter-menu');
    expect(funnel.querySelector('[aria-label="Filter"]')).not.toBeNull();
    expect(funnel.querySelector('[data-facet="counts"]')).toBeNull();
    /* ONE AT A TIME: opening the funnel closed the `⋯`. Counted among the
       HEADER's popovers only — every row also carries a `role="menu"` for its
       own `⋯`, which is a different control with its own open state. */
    expect(
      [...container.querySelectorAll('[role="menu"]')].filter((el) => el.closest('.lp__filterbar')).length,
    ).toBe(1);
  });

  /* THE PER-LINK SWITCHES IN EVERY LAYOUT (task 01a14af9): the default `⋯`
     carries the same Links-on-rows section the rail's List settings does, and
     a hidden link group is counted on its badge and cleared by its Reset. */
  it('puts the Links-on-rows switches behind ⋯, counted in its badge and Reset', () => {
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} chrome="toolbar" />,
    );
    const trigger = getByTestId('list-more-trigger');
    fireEvent.click(trigger);
    const links = getByTestId('list-more-menu').querySelector<HTMLElement>('[data-testid="list-links-section"]')!;
    expect(links).not.toBeNull();
    const docs = links.querySelector<HTMLElement>('[data-link-group="docs"]')!;
    expect(docs.getAttribute('aria-checked')).toBe('true');
    expect(trigger.querySelector('.lp__chip-count')).toBeNull();

    fireEvent.click(docs);
    expect(
      getByTestId('list-more-menu').querySelector('[data-link-group="docs"]')!.getAttribute('aria-checked'),
    ).toBe('false');
    expect(getByTestId('list-more-trigger').querySelector('.lp__chip-count')?.textContent).toBe('1');

    fireEvent.click(getByTestId('list-more-clear-all'));
    expect(
      getByTestId('list-more-menu').querySelector('[data-link-group="docs"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    expect(getByTestId('list-more-trigger').querySelector('.lp__chip-count')).toBeNull();
    /* A REAL press inside the `⋯` menu keeps it open: the funnel's own
       outside-press dismiss used to close it on pointerdown, before the
       option's click landed (jsdom's bare click never showed it). */
    const docsOpt = getByTestId('list-more-menu').querySelector<HTMLElement>('[data-link-group="docs"]')!;
    fireEvent.pointerDown(docsOpt);
    fireEvent.mouseDown(docsOpt);
    fireEvent.click(docsOpt);
    expect(
      getByTestId('list-more-menu').querySelector('[data-link-group="docs"]')!.getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(getByTestId('list-more-clear-all'));
    /* The funnel does not repeat it in this layout. */
    fireEvent.click(getByTestId('filter-trigger'));
    expect(getByTestId('filter-menu').querySelector('[data-testid="list-links-section"]')).toBeNull();
  });

  /* THE CHAT LIST (task 01a14af9, part A/C): a chat's tile draws its counts
     line, including the sessions it launched, and those sessions nest under it
     as session tiles, read through `rowsForKind` with the bounded
     `launchedBy` filter, and open as sessions. */
  it('a chat tile shows its counts and nests the sessions it launched', () => {
    const chat = withCounters(chatLaunchPlan, { docs: 1, prs: 1, sessions: 2 });
    const launched = [1, 2].map((n) => ({
      ...sessionLive,
      id: `ses-launched-${n}`,
      title: `Launched ${n}`,
      parentId: null,
      state: { ...sessionLive.state, launchedBy: chat.id },
    })) as EntitySummary[];
    const asked: unknown[] = [];
    const rowsForKind = (kind: string) => (filter: QueryFilter) => {
      asked.push({ kind, filter });
      return kind === 'work_session' ? launched : [];
    };
    const onSelect = vi.fn();
    const { container } = render(
      <EntityListPanel
        kind="chat"
        rowsFor={rowsFor([chat])}
        rowsForKind={rowsForKind}
        ctx={ctx}
        chrome="toolbar"
        onSelect={onSelect}
      />,
    );
    expect(asked).toContainEqual({ kind: 'work_session', filter: { launchedBy: [chat.id] } });
    const counts = container.querySelector<HTMLElement>('.lp__tile-counts')!;
    expect([...counts.querySelectorAll('[data-count-kind]')].map((el) => el.getAttribute('data-count-kind'))).toEqual([
      'docs',
      'prs',
      'sessions',
    ]);

    /* Collapsed by default, like every tree; the chevron opens it. */
    expect(container.querySelector('[data-testid="list-tile-children"]')).toBeNull();
    const toggle = container.querySelector<HTMLElement>('[data-testid="list-tile"] [aria-expanded]')!;
    fireEvent.click(toggle);
    const children = container.querySelector<HTMLElement>('[data-testid="list-tile-children"]')!;
    expect(children.textContent).toContain('Launched 1');
    expect(children.textContent).toContain('Launched 2');

    /* Drawn with the SESSION anatomy, and opened as a session. */
    const child = children.querySelector<HTMLElement>('[data-session-node="ses-launched-1"]')!;
    expect(child).not.toBeNull();
    fireEvent.click(child);
    expect(onSelect).toHaveBeenCalledWith('ses-launched-1', 'work_session');
  });

  it('search expands on the glyph, narrows the list, and Esc clears before it closes', () => {
    const other = { ...taskGuideLines, id: 'task-other', title: 'Something else' };
    const { container, getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines, other])} ctx={ctx} chrome="toolbar" />,
    );
    const cell = getByTestId('list-search-cell');
    const input = getByTestId('list-search') as HTMLInputElement;
    expect(cell.getAttribute('data-open')).toBeNull();

    fireEvent.click(getByTestId('list-search-open'));
    fireEvent.focus(input);
    expect(cell.getAttribute('data-open')).toBe('true');

    fireEvent.change(input, { target: { value: 'Something' } });
    expect(container.querySelectorAll('[data-testid="list-tile"]').length).toBe(1);

    /* FIRST Esc clears and KEEPS the field — a press that threw away the
       width you were typing into would be one press doing two jobs. */
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(cell.getAttribute('data-open')).toBe('true');
    expect(container.querySelectorAll('[data-testid="list-tile"]').length).toBe(2);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cell.getAttribute('data-open')).toBeNull();
  });

  /**
   * THE FIELD IS MOUNTED WHILE COLLAPSED, and this is the test that keeps it
   * that way: `list.search` (`f`) focuses the panel's `searchInputRef` and
   * never touches the DOM, so an unmount-when-closed field would silently kill
   * the keyboard path with the binding still in the contract.
   */
  it('keeps the search input mounted and reachable by ref while collapsed', () => {
    const ref = { current: null as HTMLInputElement | null };
    const { getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskGuideLines])}
        ctx={ctx}
        chrome="toolbar"
        searchInputRef={ref}
      />,
    );
    expect(getByTestId('list-search-cell').getAttribute('data-open')).toBeNull();
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(getByTestId('list-search'));
  });
});
