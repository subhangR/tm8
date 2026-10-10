// @vitest-environment jsdom
/** R2-D9: the craft chat and the page's side column never show together. */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExclusiveChat, type ExclusiveChatInput } from './useExclusiveChat';

function harness(initial: Pick<ExclusiveChatInput, 'craftShown' | 'pageShown' | 'pageId'>) {
  const hideCraft = vi.fn();
  const closePage = vi.fn();
  const view = renderHook((props: Pick<ExclusiveChatInput, 'craftShown' | 'pageShown' | 'pageId'>) =>
    useExclusiveChat({ ...props, hideCraft, closePage }), { initialProps: initial });
  return { hideCraft, closePage, rerender: view.rerender };
}

describe('useExclusiveChat', () => {
  it('opening the page column hides the craft chat', () => {
    const h = harness({ craftShown: true, pageShown: false, pageId: 'p1' });
    expect(h.hideCraft).not.toHaveBeenCalled();
    h.rerender({ craftShown: true, pageShown: true, pageId: 'p1' });
    expect(h.hideCraft).toHaveBeenCalledTimes(1);
    expect(h.closePage).not.toHaveBeenCalled();
  });

  it('opening the craft chat closes the page column', () => {
    const h = harness({ craftShown: false, pageShown: true, pageId: 'p1' });
    h.rerender({ craftShown: true, pageShown: true, pageId: 'p1' });
    expect(h.closePage).toHaveBeenCalledTimes(1);
    expect(h.hideCraft).not.toHaveBeenCalled();
  });

  it('a page arriving with its column open, or a first paint with both open, keeps the page column', () => {
    const first = harness({ craftShown: true, pageShown: true, pageId: 'p1' });
    expect(first.hideCraft).toHaveBeenCalledTimes(1);
    const h = harness({ craftShown: false, pageShown: true, pageId: 'p1' });
    h.rerender({ craftShown: true, pageShown: false, pageId: 'p1' });
    h.rerender({ craftShown: true, pageShown: true, pageId: 'p2' });
    expect(h.hideCraft).toHaveBeenCalledTimes(1);
    expect(h.closePage).not.toHaveBeenCalled();
  });

  it('does nothing while only one shows', () => {
    const h = harness({ craftShown: true, pageShown: false, pageId: 'p1' });
    h.rerender({ craftShown: false, pageShown: false, pageId: 'p1' });
    h.rerender({ craftShown: false, pageShown: true, pageId: 'p1' });
    expect(h.hideCraft).not.toHaveBeenCalled();
    expect(h.closePage).not.toHaveBeenCalled();
  });
});
