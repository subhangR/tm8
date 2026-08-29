// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { ActionContext } from '../domain';
import { deferredActions } from '../domain';
import { FIXTURE_SPACE_ID, sessionExited, sessionLive, sessionStale, taskUuidTitle } from '../fixtures';
import { toSessionRow } from '../terminal';
import { CommandPalette } from './CommandPalette';
import { LiveSessionBar } from './LiveSessionBar';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const rows = new Map([
  [sessionLive.id, toSessionRow(sessionLive, 'task T-109')],
  [sessionStale.id, toSessionRow(sessionStale, 'task T-114')],
  [sessionExited.id, toSessionRow(sessionExited, '12m ago')],
]);
const resolve = (id: string) => rows.get(id);

describe('LiveSessionBar — a running agent is never invisible', () => {
  it('N comes from the SEAM LIVE SET, not from records that claim to run', () => {
    // Two fixtures carry status 'running'; only one is in the live set.
    const { getByTestId } = render(
      <LiveSessionBar
        liveIds={[sessionLive.id]}
        resolve={resolve}
        livenessOf={(id) => (id === sessionLive.id ? 'live' : 'stale')}
      />,
    );
    expect(getByTestId('live-bar-count').textContent).toBe('— 1 live');
  });

  it('distinguishes "none focused" from "nothing running" — both are real states', () => {
    const unfocused = render(
      <LiveSessionBar liveIds={[sessionLive.id]} resolve={resolve} livenessOf={() => 'live'} />,
    );
    expect(unfocused.getByTestId('live-bar-idle').textContent).toBe('no focused session');
    expect(unfocused.getByTestId('live-bar-dot').className).toContain('live-bar__dot--idle');
    unfocused.unmount();

    const empty = render(<LiveSessionBar liveIds={[]} resolve={resolve} livenessOf={() => 'not-running'} />);
    expect(empty.getByTestId('live-bar-idle').textContent).toBe('no sessions running');
    // Zero live is a TEACHING state: it offers the gesture that fixes it.
    expect(empty.container.textContent).toContain('run a task ▸');
  });

  it('attention OUTRANKS focus — it surfaces while another session is focused', () => {
    const { getByTestId } = render(
      <LiveSessionBar
        liveIds={[sessionLive.id, sessionStale.id]}
        focusedId={sessionLive.id}
        attentionIds={[sessionStale.id]}
        resolve={resolve}
        livenessOf={() => 'live'}
      />,
    );
    expect(getByTestId('live-bar-attention').textContent).toContain('needs you');
  });

  it('a focused STALE session never renders with the live treatment', () => {
    const { getByTestId } = render(
      <LiveSessionBar
        liveIds={[]}
        focusedId={sessionStale.id}
        resolve={resolve}
        livenessOf={() => 'stale'}
        activity={{ [sessionStale.id]: true }}
      />,
    );
    expect(getByTestId('live-bar-dot').className).not.toContain('term-dot--live');
    expect(getByTestId('live-bar-dot').className).not.toContain('term-dot--pulse');
  });

  it('the roster groups NEEDS YOU above LIVE above RECENTLY EXITED, each session once', () => {
    const { getByTestId } = render(
      <LiveSessionBar
        liveIds={[sessionLive.id, sessionStale.id]}
        attentionIds={[sessionStale.id]}
        recentlyExited={[toSessionRow(sessionExited, '12m ago')]}
        resolve={resolve}
        livenessOf={(id) => (id === sessionLive.id ? 'live' : 'stale')}
      />,
    );
    fireEvent.click(getByTestId('live-bar-count'));
    const roster = getByTestId('roster-popover');
    const groups = [...roster.querySelectorAll('.roster__group')].map((g) => g.textContent ?? '');
    expect(groups[0]).toContain('NEEDS YOU');
    expect(groups[1]).toContain('LIVE');
    expect(groups[2]).toContain('RECENTLY EXITED');
    // The attention session must not ALSO appear under LIVE.
    expect(groups[1]).toContain('LIVE · 1');
    expect(within(roster).getAllByRole('menuitem')).toHaveLength(3);
  });
});

describe('CommandPalette', () => {
  const views = [{ id: 'workspace', label: 'Workspace', glyph: '⌗' }];

  it('renders groups in the FIXED order, with the deferred group COLLAPSED in last place', () => {
    const { getByTestId } = render(
      <CommandPalette open results={[taskUuidTitle]} views={views} ctx={ctx} />,
    );
    const palette = getByTestId('command-palette');
    const groups = () => [...palette.querySelectorAll('.pal__group')].map((g) => g.textContent);
    /* Audit #3: the dead group opens as ONE summary row, not fifteen — but it
       still holds the LAST seat of the fixed order. */
    expect(groups()).toEqual(['ENTITIES', 'VIEWS']);
    const summary = getByTestId('palette-deferred-summary');
    expect(palette.querySelector('.pal__results')?.lastElementChild).toBe(summary);
    fireEvent.click(summary);
    expect(groups()).toEqual(['ENTITIES', 'VIEWS', 'NOT AVAILABLE YET']);
  });

  it('R7 discovery rows are DERIVED from the registry, not a hand-kept second list', () => {
    const { getByTestId, getAllByTestId, queryAllByTestId } = render(
      <CommandPalette open results={[]} views={[]} ctx={ctx} />,
    );
    /* Collapsed, the registry's permanently-disabled set is a COUNT; expanded,
       it is the rows themselves. Both read the same derived list — nothing is
       forgotten and nothing is invented, because the source is the registry. */
    expect(queryAllByTestId('palette-disabled-row')).toHaveLength(0);
    const summary = getByTestId('palette-deferred-summary');
    expect(summary.textContent).toContain(`${deferredActions().length} not available yet`);
    fireEvent.click(summary);
    expect(getAllByTestId('palette-disabled-row')).toHaveLength(deferredActions().length);
  });

  it('a disabled row states its reason INLINE — a skipped row has no hover to explain it', () => {
    const { getByTestId, getAllByTestId } = render(
      <CommandPalette open results={[]} views={[]} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('palette-deferred-summary'));
    const row = getAllByTestId('palette-disabled-row')[0]!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('.pal__row-reason')?.textContent).toBeTruthy();
    /* THE INLINE LINE IS THE SHORT FORM, AND IT IS NOT THE WHOLE REASON.
       `shortReason` keeps only the text before the first `:` or em-dash and
       degrades to a generic placeholder past a 40-char head, so the remedy half
       was dropped for everyone. The full sentence used to live in `title`, which
       renders on hover and nowhere else. It is now a `ReasonNote`, reachable by
       hover, focus OR tap — so `title` is gone and the full text is in the DOM. */
    expect(row.getAttribute('title')).toBeNull();
    const full = row.querySelector('.hon-tip')?.textContent ?? '';
    expect(full.length).toBeGreaterThan(0);
  });

  it('arrow keys SKIP disabled rows, and Enter never activates one', () => {
    const onOpenEntity = vi.fn();
    const onRunAction = vi.fn();
    const { getByTestId } = render(
      <CommandPalette
        open
        results={[taskUuidTitle]}
        views={views}
        ctx={ctx}
        onOpenEntity={onOpenEntity}
        onRunAction={onRunAction}
      />,
    );
    const palette = getByTestId('command-palette');

    // Two navigable rows exist (one entity, one view). Pressing Down far past
    // them must not walk into the disabled group.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(palette, { key: 'ArrowDown' });
    fireEvent.keyDown(palette, { key: 'Enter' });

    expect(onRunAction).not.toHaveBeenCalled(); // never a deferred action
    expect(onOpenEntity.mock.calls.length + (onRunAction.mock.calls.length || 0)).toBeLessThanOrEqual(1);
  });

  it('the collapsed group expands on ARROW-INTO, and revealing is all the gesture does', () => {
    const { getByTestId, getAllByTestId, queryByTestId, queryAllByTestId } = render(
      <CommandPalette open results={[]} views={views} ctx={ctx} />,
    );
    const palette = getByTestId('command-palette');
    expect(queryAllByTestId('palette-disabled-row')).toHaveLength(0);
    // One enabled row, so the cursor already sits on the last one: Down is the
    // arrow-INTO gesture and spends itself revealing the group.
    fireEvent.keyDown(palette, { key: 'ArrowDown' });
    expect(queryByTestId('palette-deferred-summary')).toBeNull();
    expect(getAllByTestId('palette-disabled-row')).toHaveLength(deferredActions().length);
    // The revealed rows stay unnavigable (R7): selection never leaves the
    // enabled set, however far Down walks.
    fireEvent.keyDown(palette, { key: 'ArrowDown' });
    const selected = palette.querySelectorAll('.pal__row--selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('Workspace');
  });

  it('typing filters VIEWS/ACTIONS by label, and Enter opens the top FILTERED row (audit #1)', () => {
    const onOpenView = vi.fn();
    const { getByTestId, getAllByTestId } = render(
      <CommandPalette
        open
        results={[]}
        views={[
          { id: 'view:dashboard', label: 'Home', glyph: '⌂' },
          { id: 'kind:task', label: 'Tasks', glyph: '☑' },
        ]}
        ctx={ctx}
        onOpenView={onOpenView}
      />,
    );
    const palette = getByTestId('command-palette');
    fireEvent.change(palette.querySelector('.pal__input')!, { target: { value: 'task' } });
    const labels = getAllByTestId('palette-row').map((r) => r.textContent ?? '');
    expect(labels.join(' ')).toContain('Tasks'); // case-insensitive substring
    expect(labels.join(' ')).not.toContain('Home');
    /* The audit's exact repro: type 'task', press Enter, land on Home — the
       static lists never filtered and Enter took the first UNFILTERED row.
       Enter must target the top of the FILTERED navigable set. */
    fireEvent.keyDown(palette, { key: 'Enter' });
    expect(onOpenView).toHaveBeenCalledWith('kind:task');
  });

  it('the seam owns ENTITY matching — the client label filter never second-guesses a result', () => {
    const { getByTestId, getAllByTestId } = render(
      <CommandPalette open results={[taskUuidTitle]} views={views} ctx={ctx} />,
    );
    const palette = getByTestId('command-palette');
    // 'workspace' matches the view label but not the entity's UUID title. The
    // entity row STAYS: the seam query matched it upstream (fuzziness and
    // all), and a second literal filter here could only disagree with it.
    fireEvent.change(palette.querySelector('.pal__input')!, { target: { value: 'workspace' } });
    const labels = getAllByTestId('palette-row').map((r) => r.textContent ?? '');
    expect(labels.some((t) => t.includes(taskUuidTitle.title))).toBe(true);
    expect(labels.some((t) => t.includes('Workspace'))).toBe(true);
  });

  it('a query that matches nothing anywhere — deferred included — honestly says so', () => {
    const { getByTestId, queryByTestId } = render(
      <CommandPalette open results={[]} views={views} ctx={ctx} />,
    );
    const palette = getByTestId('command-palette');
    fireEvent.change(palette.querySelector('.pal__input')!, { target: { value: 'xyzzy-nothing' } });
    expect(palette.textContent).toContain('No matches for “xyzzy-nothing”');
    // The summary must not advertise a count the query already ruled out.
    expect(queryByTestId('palette-deferred-summary')).toBeNull();
  });

  it('Enter opens the selected entity; Esc dismisses and is consumed', () => {
    const onOpenEntity = vi.fn();
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <CommandPalette
        open
        results={[taskUuidTitle]}
        views={[]}
        ctx={ctx}
        onOpenEntity={onOpenEntity}
        onDismiss={onDismiss}
      />,
    );
    const palette = getByTestId('command-palette');
    fireEvent.keyDown(palette, { key: 'Enter' });
    expect(onOpenEntity).toHaveBeenCalledWith(taskUuidTitle.id);

    const esc = fireEvent.keyDown(palette, { key: 'Escape' });
    expect(esc).toBe(false); // preventDefault called ⇒ consumed by this layer
    expect(onDismiss).toHaveBeenCalled();
  });

  it('the deferred search-results view has its named home in the footer', () => {
    const { getByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    const footer = getByTestId('command-palette').querySelector('.pal__footer');
    expect(footer?.textContent).toContain('open full results');
    expect(footer?.querySelector('.pal__footer-deferred')?.getAttribute('title')).toMatch(/search/i);
  });

  it('says nothing was found rather than showing an empty box', () => {
    const { getByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    // With no query, the collapsed discovery summary still renders (discovery
    // is the point), so the empty copy only appears when there is genuinely
    // nothing at all — the no-match case above.
    expect(getByTestId('palette-deferred-summary').textContent).toContain('not available yet');
    expect(getByTestId('command-palette').textContent).not.toContain('No matches');
  });
});
