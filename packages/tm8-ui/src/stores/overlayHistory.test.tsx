// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { OVERLAY_STATE_KEY, createBrowserTarget } from '../routes';
import { resetOverlayHistory, useOverlayEntry } from './overlayHistory';

/*
 * Real jsdom history: `history.back()` is asynchronous and fires `popstate`,
 * exactly the shape Android Back has in Chrome.
 */
const popped = () => new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));

function Layer(props: { onPop: () => void; closeRef?: { current: (() => void) | null } }) {
  const close = useOverlayEntry(true, props.onPop);
  if (props.closeRef) props.closeRef.current = close;
  return null;
}

function Host(props: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  const close = useOverlayEntry(open, () => {
    setOpen(false);
    props.onClose?.();
  });
  return open ? (
    <button type="button" onClick={close}>
      close
    </button>
  ) : (
    <span>closed</span>
  );
}

beforeEach(() => {
  resetOverlayHistory();
  window.history.replaceState(null, '', '#/s/S/k/tasks');
});

afterEach(() => {
  cleanup();
});

describe('overlay history — Back closes the layer, not the screen', () => {
  it('opening pushes one same-URL marker entry', () => {
    const before = window.history.length;
    const href = window.location.href;
    render(<Layer onPop={() => undefined} />);
    expect(window.history.length).toBe(before + 1);
    expect(window.location.href).toBe(href);
    expect((window.history.state as Record<string, unknown>)[OVERLAY_STATE_KEY]).toBeTypeOf('string');
  });

  it('Back pops the marker and dismisses, and the address never moved', async () => {
    const onClose = vi.fn();
    const view = render(<Host onClose={onClose} />);
    const href = window.location.href;
    const hashchange = vi.fn();
    window.addEventListener('hashchange', hashchange);
    const pop = popped();
    act(() => window.history.back());
    await act(() => pop);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.getByText('closed')).toBeTruthy();
    expect(window.location.href).toBe(href);
    expect(hashchange).not.toHaveBeenCalled();
    window.removeEventListener('hashchange', hashchange);
  });

  it('closing by ✕ dismisses at once and takes the marker off, so it never piles up', async () => {
    const onClose = vi.fn();
    const view = render(<Host onClose={onClose} />);
    const pop = popped();
    act(() => view.getByText('close').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await pop;
    /* Back to the entry under the marker, and no second dismiss. */
    expect(window.history.state).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an owner that stops rendering the layer also takes its marker off', async () => {
    const view = render(<Layer onPop={() => undefined} />);
    const pop = popped();
    view.unmount();
    await pop;
    expect(window.history.state).toBeNull();
  });

  it('a sheet opened as the drawer closes waits for the drawer back to land', async () => {
    const drawerClose: { current: (() => void) | null } = { current: null };
    const drawerPop = vi.fn();
    const sheetPop = vi.fn();
    function Both() {
      const [sheet, setSheet] = useState(false);
      return (
        <>
          <Layer onPop={drawerPop} closeRef={drawerClose} />
          {sheet ? <Layer onPop={sheetPop} /> : null}
          <button type="button" onClick={() => { setSheet(true); drawerClose.current?.(); }}>
            needs you
          </button>
        </>
      );
    }
    const view = render(<Both />);
    const pop = popped();
    act(() => view.getByText('needs you').click());
    await pop;
    await waitFor(() => expect(window.history.state).not.toBeNull());
    expect(sheetPop).not.toHaveBeenCalled();
    /* Now Back closes the sheet. */
    const pop2 = popped();
    act(() => window.history.back());
    await act(() => pop2);
    expect(sheetPop).toHaveBeenCalledTimes(1);
  });

  it('a navigation over the marker replaces it: [chat, destination], not [chat, marker, destination]', () => {
    const target = createBrowserTarget(window);
    render(<Layer onPop={() => undefined} />);
    const length = window.history.length;
    const hashchange = vi.fn();
    window.addEventListener('hashchange', hashchange);
    target.setHash('#/s/S/k/docs');
    expect(window.history.length).toBe(length);
    expect(window.history.state).toBeNull();
    expect(window.location.hash).toBe('#/s/S/k/docs');
    expect(hashchange).toHaveBeenCalledTimes(1);
    window.removeEventListener('hashchange', hashchange);
  });

  it('a settle over the marker keeps it', () => {
    const target = createBrowserTarget(window);
    render(<Layer onPop={() => undefined} />);
    const state = window.history.state;
    target.setHash('#/s/S/k/tasks?q=1', { replace: true });
    expect(window.history.state).toEqual(state);
  });
});
