// @vitest-environment jsdom
/**
 * THE SESSION LIST MAY NOT INVENT A LIVENESS VERDICT, AND MAY NOT CALL A SPACE
 * EMPTY BEFORE IT HAS LOOKED.
 *
 * The second is the composer bug, now prevented by the type. The first is the
 * trap `ChatSessionRow`'s own docblock names and is the one a careless reader
 * walks into: **`idle` is a LEGAL LIVE STATE.** An idle session is running, just
 * quiet. Deriving liveness from `statusWord !== 'idle'` paints a running session
 * as dead — the same class of lie, one field over.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionList } from './SessionList';
import type { ChatSessionRow } from './types';

function row(over: Partial<ChatSessionRow> = {}): ChatSessionRow {
  return {
    id: 's1',
    title: 'what the fuck is this UI',
    statusWord: 'running',
    tone: 'run',
    live: true,
    updatedAt: '3',
    ...over,
  };
}

describe('SessionList', () => {
  it('shows the pending sentence and never the empty claim', () => {
    const view = render(
      <SessionList region={{ status: 'pending' }} note="Loading sessions…" />,
    );
    expect(view.getByText('Loading sessions…')).toBeTruthy();
    expect(view.queryByText('No sessions in this space.')).toBeNull();
  });

  it('reports a failed read as failed, not as an empty space', () => {
    const view = render(
      <SessionList region={{ status: 'failed' }} note="Your sessions could not be loaded." />,
    );
    expect(view.getByText('Your sessions could not be loaded.')).toBeTruthy();
    expect(view.queryByText('No sessions in this space.')).toBeNull();
  });

  it('claims the space is empty only after a loaded, empty read', () => {
    const view = render(<SessionList region={{ status: 'loaded', items: [] }} note={null} />);
    expect(view.getByText('No sessions in this space.')).toBeTruthy();
  });

  it('KEEPS AN IDLE SESSION LIVE — idle is a legal live state', () => {
    /* The contract: "a `running` record with no live process is stale, and
       `idle` is a LEGAL LIVE STATE (an idle session is running, just quiet)".
       So the marker follows `live`, never the word. */
    const view = render(
      <SessionList
        region={{ status: 'loaded', items: [row({ statusWord: 'idle', tone: 'idle', live: true })] }}
        note={null}
      />,
    );
    const item = view.container.querySelector('.tch-srow');
    expect(item?.className).toContain('tch-srow--live');
    expect(view.getByText('idle')).toBeTruthy();
  });

  it('does NOT mark a stale `running` record live when the host says it is not', () => {
    /* The mirror: the word says running, the verdict says no process. The
       verdict wins, because the host composed it from execution.liveness. */
    const view = render(
      <SessionList
        region={{ status: 'loaded', items: [row({ statusWord: 'running', live: false })] }}
        note={null}
      />,
    );
    expect(view.container.querySelector('.tch-srow')?.className).not.toContain('tch-srow--live');
  });

  it('reports the chosen session rather than mounting anything itself', () => {
    const onSelectSession = vi.fn();
    const view = render(
      <SessionList
        region={{ status: 'loaded', items: [row()] }}
        note={null}
        onSelectSession={onSelectSession}
      />,
    );
    view.getByRole('button', { name: /what the fuck is this UI/ }).click();
    expect(onSelectSession).toHaveBeenCalledWith('s1');
    /* No terminal here, by design — selection is a verb the layout consumes. */
    expect(view.container.querySelector('.xterm')).toBeNull();
  });

  it('renders the count WITHOUT a denominator when no limit is known', () => {
    /* A wrong ceiling is worse than no ceiling — it tells the reader they have
       room they may not have. Nothing in the package exposes a session cap, so
       the denominator appears only when the host supplies one. */
    const bare = render(
      <SessionList region={{ status: 'loaded', items: [] }} note={null} capacity={{ used: 13, limit: null }} />,
    );
    expect(bare.getByText('13')).toBeTruthy();
    expect(bare.queryByRole('progressbar')).toBeNull();
    bare.unmount();

    const known = render(
      <SessionList region={{ status: 'loaded', items: [] }} note={null} capacity={{ used: 13, limit: 30 }} />,
    );
    expect(known.getByText('13/30')).toBeTruthy();
    expect(known.getByRole('progressbar')).toBeTruthy();
  });

  it('takes USED, not FREE — the number the design shows is the used one', () => {
    /* `LaunchCapacity` is `{ slotsFree, slotsTotal }` and `describeCapacity`
       phrases it "N of M session slots free". The target shows 13/30 = USED of
       TOTAL. Passing free straight through renders 17/30 — plausible, inverted,
       and silent. `GateApp.tsx:1422` already carries the conversion the host
       must do: slotsTotal - slotsFree. This asserts the renderer's own end of
       that contract, so a host that gets it wrong disagrees with a test rather
       than with nothing. */
    const view = render(
      <SessionList
        region={{ status: 'loaded', items: [] }}
        note={null}
        capacity={{ used: 30 - 17, limit: 30 }}
      />,
    );
    expect(view.getByText('13/30')).toBeTruthy();
    expect(view.queryByText('17/30')).toBeNull();
  });

  it('keeps PR chips OUTSIDE the row button — an anchor cannot nest in a button', () => {
    const view = render(
      <SessionList
        region={{
          status: 'loaded',
          items: [row({ badges: <a href="https://example.invalid/pr/552">#552</a> })],
        }}
        note={null}
        onSelectSession={vi.fn()}
      />,
    );
    const link = view.getByRole('link', { name: '#552' });
    expect(link.closest('button')).toBeNull();
  });
});
