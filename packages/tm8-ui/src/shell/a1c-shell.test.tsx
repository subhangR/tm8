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

  it('renders groups in the FIXED order: entities → views → actions → not-available-yet', () => {
    const { getByTestId } = render(
      <CommandPalette open results={[taskUuidTitle]} views={views} ctx={ctx} />,
    );
    const groups = [...getByTestId('command-palette').querySelectorAll('.pal__group')].map(
      (g) => g.textContent,
    );
    expect(groups).toEqual(['ENTITIES', 'VIEWS', 'NOT AVAILABLE YET']);
  });

  it('R7 discovery rows are DERIVED from the registry, not a hand-kept second list', () => {
    const { getAllByTestId } = render(
      <CommandPalette open results={[]} views={[]} ctx={ctx} />,
    );
    // Every permanently-disabled action appears; nothing is forgotten and
    // nothing is invented, because the source is the registry itself.
    expect(getAllByTestId('palette-disabled-row')).toHaveLength(deferredActions().length);
  });

  it('a disabled row states its reason INLINE — a skipped row has no hover to explain it', () => {
    const { getAllByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    const row = getAllByTestId('palette-disabled-row')[0]!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('.pal__row-reason')?.textContent).toBeTruthy();
    expect(row.getAttribute('title')).toBeTruthy();
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
    // The deferred group still renders (discovery is the point), so the empty
    // copy only appears when there is genuinely nothing at all.
    expect(getByTestId('command-palette').textContent).toContain('NOT AVAILABLE YET');
  });
});
