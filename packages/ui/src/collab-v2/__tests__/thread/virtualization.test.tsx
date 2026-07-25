/**
 * Virtualization — the claim is "10k messages, a few dozen DOM rows". These
 * tests hold the render count to a bound at both levels: the windowing
 * primitive on its own, and the whole Thread driven by a facade handing back a
 * very large history.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { VirtualList } from '../../subsystems/thread/VirtualList';
import { Thread } from '../../subsystems/thread';
import { buildTree } from '../../subsystems/thread/useThread';
import { flattenRows } from '../../subsystems/thread/Thread';
import {
  fakeMessage, renderWith, renderedMessageCount, resetStores, volumeFacade,
} from './helpers';

const VIEWPORT = 800;
const ROW = 90;
/** viewport/row rows on screen, plus overscan above and below, plus slack. */
const BOUND = Math.ceil(VIEWPORT / ROW) + 2 * 8 + 4;

afterEach(() => { cleanup(); resetStores(); });

describe('VirtualList windowing', () => {
  it('renders a bounded window of 10,000 items', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({ id: `i${i}` }));
    const { container } = render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        renderItem={(it) => <div data-cv2-msg={it.id}>{it.id}</div>}
        estimateHeight={ROW}
        overscan={8}
        fallbackViewport={VIEWPORT}
      />,
    );

    const rendered = container.querySelectorAll('[data-cv2-msg]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(BOUND);

    const list = container.querySelector('.cv2-vlist') as HTMLElement;
    expect(Number(list.dataset.total)).toBe(10_000);
    expect(Number(list.dataset.rendered)).toBe(rendered);
  });

  it('windows a different slice after scrolling', () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({ id: `i${i}` }));
    const { container } = render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        renderItem={(it) => <div data-cv2-msg={it.id}>{it.id}</div>}
        estimateHeight={ROW}
        overscan={4}
        fallbackViewport={VIEWPORT}
      />,
    );
    expect(container.querySelector('[data-cv2-msg="i0"]')).not.toBeNull();

    const list = container.querySelector('.cv2-vlist') as HTMLElement;
    // jsdom has no layout, so drive scrollTop directly and fire the event.
    Object.defineProperty(list, 'scrollTop', { value: ROW * 1_000, writable: true });
    act(() => { list.dispatchEvent(new Event('scroll', { bubbles: true })); });

    expect(container.querySelector('[data-cv2-msg="i0"]')).toBeNull();
    expect(container.querySelector('[data-cv2-msg="i1000"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-cv2-msg]').length).toBeLessThanOrEqual(BOUND);
  });

  it('keeps the row list flat and complete before windowing', () => {
    const messages = Array.from({ length: 2_000 }, (_, i) => fakeMessage('ch_1', i));
    const rows = flattenRows(buildTree(messages), new Set(), null, 0);
    expect(rows).toHaveLength(2_000);
  });
});

describe('Thread at volume', () => {
  it('mounts a bounded number of message rows for a 10,000-message anchor', async () => {
    const facade = volumeFacade('ch_volume', 10_000);
    renderWith(facade, (
      <Thread anchorId="ch_volume" variant="feed" estimateRowHeight={ROW}
        overscan={8} fallbackViewport={VIEWPORT} composer={false} live={false} />
    ));

    await waitFor(() => expect(renderedMessageCount()).toBeGreaterThan(0));
    expect(renderedMessageCount()).toBeLessThanOrEqual(BOUND);

    const list = await screen.findByLabelText('Messages');
    expect(Number((list as HTMLElement).dataset.total)).toBe(10_000);
  });
});
