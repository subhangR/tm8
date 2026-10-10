// @vitest-environment jsdom
/** R2-D9: the design chat and the page's side column never show together. */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExclusiveChat, type ExclusiveChatInput } from './useExclusiveChat';

function harness(initial: Pick<ExclusiveChatInput, 'designShown' | 'pageShown' | 'pageId'>) {
  const hideDesign = vi.fn();
  const closePage = vi.fn();
  const view = renderHook((props: Pick<ExclusiveChatInput, 'designShown' | 'pageShown' | 'pageId'>) =>
    useExclusiveChat({ ...props, hideDesign, closePage }), { initialProps: initial });
  return { hideDesign, closePage, rerender: view.rerender };
}

describe('useExclusiveChat', () => {
  it('opening the page column hides the design chat', () => {
    const h = harness({ designShown: true, pageShown: false, pageId: 'p1' });
    expect(h.hideDesign).not.toHaveBeenCalled();
    h.rerender({ designShown: true, pageShown: true, pageId: 'p1' });
    expect(h.hideDesign).toHaveBeenCalledTimes(1);
    expect(h.closePage).not.toHaveBeenCalled();
  });

  it('opening the design chat closes the page column', () => {
    const h = harness({ designShown: false, pageShown: true, pageId: 'p1' });
    h.rerender({ designShown: true, pageShown: true, pageId: 'p1' });
    expect(h.closePage).toHaveBeenCalledTimes(1);
    expect(h.hideDesign).not.toHaveBeenCalled();
  });

  it('a page arriving with its column open, or a first paint with both open, keeps the page column', () => {
    const first = harness({ designShown: true, pageShown: true, pageId: 'p1' });
    expect(first.hideDesign).toHaveBeenCalledTimes(1);
    const h = harness({ designShown: false, pageShown: true, pageId: 'p1' });
    h.rerender({ designShown: true, pageShown: false, pageId: 'p1' });
    h.rerender({ designShown: true, pageShown: true, pageId: 'p2' });
    expect(h.hideDesign).toHaveBeenCalledTimes(1);
    expect(h.closePage).not.toHaveBeenCalled();
  });

  it('does nothing while only one shows', () => {
    const h = harness({ designShown: true, pageShown: false, pageId: 'p1' });
    h.rerender({ designShown: false, pageShown: false, pageId: 'p1' });
    h.rerender({ designShown: false, pageShown: true, pageId: 'p1' });
    expect(h.hideDesign).not.toHaveBeenCalled();
    expect(h.closePage).not.toHaveBeenCalled();
  });
});
