// @vitest-environment jsdom
/**
 * The drawing canvas block.
 *
 * Excalidraw is MOCKED here, and that is the point rather than a shortcut:
 * jsdom has no canvas, so a real Excalidraw would render nothing and every
 * assertion below would be vacuous. The mock exposes `onChange` so the save
 * rules — which are the whole substance of this component — can be driven
 * directly, exactly as a pointer would drive them.
 *
 * What a vitest CANNOT see here is the stage's height. Excalidraw measures its
 * own container and renders at zero in a height-less parent, which looks like
 * a failed import; jsdom loads no stylesheets, so the last case reads the
 * sheet as SOURCE. A DOM assertion alone would stay green through a deleted
 * `min-height`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntityDetail } from '@tm8/contract';

/** Captures the props Excalidraw was mounted with, and lets a test drive onChange. */
const mounted: {
  onChange?: (els: unknown[], app: unknown) => void;
  viewMode?: boolean;
  initial?: unknown;
  theme?: unknown;
  apiProp?: unknown;
} = {};
const api = { refresh: vi.fn(), updateScene: vi.fn(), addFiles: vi.fn() };

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    mounted.onChange = props.onChange as (els: unknown[], app: unknown) => void;
    mounted.viewMode = props.viewModeEnabled as boolean;
    mounted.initial = props.initialData;
    mounted.theme = props.theme;
    mounted.apiProp = props.excalidrawAPI;
    (props.excalidrawAPI as ((a: typeof api) => void) | undefined)?.(api);
    return <div className="excalidraw" data-testid="excalidraw-mock" tabIndex={0} />;
  },
}));
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));

const { DrawingBlock } = await import('./DrawingBlock');

const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id, version, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...extra,
});

function detailOf(over: Partial<EntityDetail> = {}): EntityDetail {
  return {
    id: 'drawing-1',
    kind: 'drawing',
    title: 'Login wireframe',
    version: 7,
    content: { kind: 'drawing', format: 'excalidraw', elements: [el('a', 1)], appState: {}, files: {} },
    state: { kind: 'drawing', format: 'excalidraw', elementCount: 1 },
    ...over,
  } as unknown as EntityDetail;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mounted.onChange = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Let the lazy import resolve and the canvas mount. */
async function mountBlock(ui: React.ReactElement) {
  render(ui);
  await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
}

describe('DrawingBlock', () => {
  it('mounts the canvas with the row’s scene, and reports Saved', async () => {
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
    expect((mounted.initial as { elements: unknown[] }).elements).toHaveLength(1);
    expect(screen.getByTestId('drawing-status').textContent).toBe('Saved');
  });

  it('is READ-ONLY with no patch command, and says so', async () => {
    await mountBlock(<DrawingBlock detail={detailOf()} commands={null} />);
    expect(mounted.viewMode).toBe(true);
    expect(screen.getByTestId('drawing-status').textContent).toBe('Read-only');
  });

  it('DEBOUNCES: a burst of changes writes ONCE, with the version it read', async () => {
    const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    // Three edits in quick succession, as one drag would produce.
    mounted.onChange!([el('a', 2)], {});
    mounted.onChange!([el('a', 3)], {});
    mounted.onChange!([el('a', 4)], {});
    expect(patchEntity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));

    const [id, input] = patchEntity.mock.calls[0]!;
    expect(id).toBe('drawing-1');
    expect(input.expectedVersion).toBe(7);
    expect((input.content.elements as unknown[])).toHaveLength(1);
    expect((input.content.elements as Record<string, unknown>[])[0]!.version).toBe(4);
  });

  it('NEVER writes when only the viewport moved', async () => {
    const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    // Scrolling and selecting are the noisiest onChange sources there are.
    mounted.onChange!([el('a', 1)], { scrollX: 400, zoom: { value: 2 }, selectedElementIds: { a: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(patchEntity).not.toHaveBeenCalled();
    expect(screen.getByTestId('drawing-status').textContent).toBe('Saved');
  });

  it('BANKS the new version, so a second save is not stale', async () => {
    const patchEntity = vi.fn()
      .mockResolvedValueOnce({ entity: { version: 8 }, patches: [] })
      .mockResolvedValueOnce({ entity: { version: 9 }, patches: [] });
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    mounted.onChange!([el('a', 2)], {});
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));

    mounted.onChange!([el('a', 3)], {});
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(2));

    // Reading `detail.version` at save time would send 7 again and conflict.
    expect(patchEntity.mock.calls[1]![1].expectedVersion).toBe(8);
  });

  describe('a NEWER version from elsewhere reaches the open canvas', () => {
    /*
     * Excalidraw reads `initialData` once. A host re-reading the row after
     * another actor's write (the craft overview's live sections) hands this
     * block a new detail; without `updateScene` the canvas stayed as it was
     * until a reload — QA saw a v6 yellow background render white.
     */
    const yellow = { kind: 'drawing', format: 'excalidraw', elements: [el('a', 1), el('b', 1)], appState: { viewBackgroundColor: '#fff0a0' }, files: {} };

    it('pushes the new scene into the live canvas when nothing is unsaved', async () => {
      const patchEntity = vi.fn();
      const { rerender } = render(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());

      rerender(<DrawingBlock detail={detailOf({ version: 8, content: yellow } as Partial<EntityDetail>)} commands={{ patchEntity }} />);
      expect(api.updateScene).toHaveBeenCalledTimes(1);
      const pushed = api.updateScene.mock.calls[0]![0] as { elements: unknown[]; appState: Record<string, unknown> };
      expect(pushed.elements).toHaveLength(2);
      expect(pushed.appState.viewBackgroundColor).toBe('#fff0a0');
      expect(api.addFiles).not.toHaveBeenCalled();

      // The adopted version guards the next write, and the adopted scene is not "unsaved".
      mounted.onChange!([el('a', 1), el('b', 1)], { viewBackgroundColor: '#fff0a0' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(patchEntity).not.toHaveBeenCalled();
      mounted.onChange!([el('a', 2), el('b', 1)], { viewBackgroundColor: '#fff0a0' });
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
      expect(patchEntity.mock.calls[0]![1].expectedVersion).toBe(8);
    });

    it('hands a new version’s files to the canvas BEFORE its scene', async () => {
      const { rerender } = render(<DrawingBlock detail={detailOf()} commands={null} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
      const file = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' };
      rerender(<DrawingBlock detail={detailOf({ version: 8, content: { ...yellow, files: { f1: file } } } as Partial<EntityDetail>)} commands={null} />);
      expect(api.addFiles).toHaveBeenCalledWith([file]);
      expect(api.addFiles.mock.invocationCallOrder[0]!).toBeLessThan(api.updateScene.mock.invocationCallOrder[0]!);
    });

    it('never overwrites an edit the user has not saved yet', async () => {
      const patchEntity = vi.fn().mockRejectedValue(new Error('expected version 7 is stale'));
      const { rerender } = render(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());

      mounted.onChange!([el('a', 2)], {});
      rerender(<DrawingBlock detail={detailOf({ version: 8, content: yellow } as Partial<EntityDetail>)} commands={{ patchEntity }} />);
      expect(api.updateScene).not.toHaveBeenCalled();
      // The pending save still goes out against the version it read, and meets the conflict.
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
      expect(patchEntity.mock.calls[0]![1].expectedVersion).toBe(7);
    });

    it('does not re-push its OWN save when the host re-renders with it', async () => {
      const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
      const { rerender } = render(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());

      mounted.onChange!([el('a', 2)], {});
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => expect(screen.getByTestId('drawing-status').textContent).toBe('Saved'));
      const saved = { kind: 'drawing', format: 'excalidraw', elements: [el('a', 2)], appState: {}, files: {} };
      rerender(<DrawingBlock detail={detailOf({ version: 8, content: saved } as Partial<EntityDetail>)} commands={{ patchEntity }} />);
      expect(api.updateScene).not.toHaveBeenCalled();
    });
  });

  it('reports a version CONFLICT as someone else’s save, not as an error', async () => {
    const patchEntity = vi.fn().mockRejectedValue(new Error('expected version 7 is stale'));
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    mounted.onChange!([el('a', 2)], {});
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() =>
      expect(screen.getByTestId('drawing-status').textContent)
        .toContain('Someone else saved this drawing'));
  });

  it('surfaces a non-conflict failure verbatim rather than swallowing it', async () => {
    const patchEntity = vi.fn().mockRejectedValue(new Error('the door refused: drawing is too large'));
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    mounted.onChange!([el('a', 2)], {});
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() =>
      expect(screen.getByTestId('drawing-status').textContent).toContain('too large'));
  });

  it('WARNS on an embedded image and stops writing — the door would refuse it', async () => {
    const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    mounted.onChange!([el('a', 1), el('img', 1, { type: 'image' })], {});
    await waitFor(() => expect(screen.getByTestId('drawing-image-notice')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(2000);

    // The save is not merely refused by the server — it is never attempted,
    // because a certain-to-fail write would spend a version and look like a
    // conflict to everyone else.
    expect(patchEntity).not.toHaveBeenCalled();
  });

  it('clears the image warning when the paste is undone', async () => {
    const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
    await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);

    mounted.onChange!([el('img', 1, { type: 'image' })], {});
    await waitFor(() => expect(screen.queryByTestId('drawing-image-notice')).toBeTruthy());

    mounted.onChange!([el('img', 2, { type: 'image', isDeleted: true })], {});
    await waitFor(() => expect(screen.queryByTestId('drawing-image-notice')).toBeNull());
  });

  it('the stage tells the app keyboard it owns its keys', async () => {
    // Without the marker the canvas sits in global chrome: `g` opens a nav
    // chord and `/` opens the palette over it. The shell reads the attribute,
    // never the kind.
    const { container } = render(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
    await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
    const stage = container.querySelector('.drw__stage');
    expect(stage?.getAttribute('data-owns-keys')).toBe('canvas');
    expect(screen.getByTestId('excalidraw-mock').closest('[data-owns-keys]')).toBe(stage);
  });

  describe('the canvas is the whole body (task 01a12506)', () => {
    const empty = () => detailOf({
      content: { kind: 'drawing', format: 'excalidraw', elements: [], appState: {}, files: {} },
      state: { kind: 'drawing', format: 'excalidraw', elementCount: 0 },
    } as Partial<EntityDetail>);

    it('has no fullscreen of its own — not even for an empty canvas', async () => {
      await mountBlock(<DrawingBlock detail={empty()} commands={{ patchEntity: vi.fn() }} />);
      expect(screen.queryByRole('button', { name: /fullscreen/i })).toBeNull();
      expect(screen.getByTestId('drawing-block').className).toBe('drw');
    });

    it('portals the save status into the bar slot, and draws no row of its own', async () => {
      const slot = document.createElement('div');
      document.body.appendChild(slot);
      try {
        const { container } = render(
          <DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} barSlot={slot} />,
        );
        await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
        const status = screen.getByTestId('drawing-status');
        expect(slot.contains(status)).toBe(true);
        expect(status.getAttribute('data-tip')).toBe('Saved');
        expect(container.querySelector('.drw__bar')).toBeNull();
      } finally {
        slot.remove();
      }
    });

    it('draws the status in place where the host offers no slot', async () => {
      await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
      expect(screen.getByTestId('drawing-status').closest('.drw__bar')).not.toBeNull();
    });

    it('marks a pending write, then a saved one', async () => {
      const patchEntity = vi.fn().mockResolvedValue({ entity: { version: 8 }, patches: [] });
      await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} />);
      act(() => mounted.onChange!([el('a', 2)], {}));
      expect(screen.getByTestId('drawing-status').getAttribute('data-phase')).toBe('dirty');
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-phase')).toBe('saved'));
    });

    it('says a failed save OVER the canvas too — a tooltip is too quiet for lost work', async () => {
      const patchEntity = vi.fn().mockRejectedValue(new Error('expected version 7 is stale'));
      const slot = document.createElement('div');
      await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity }} barSlot={slot} />);
      act(() => mounted.onChange!([el('a', 2)], {}));
      await vi.advanceTimersByTimeAsync(1000);
      await waitFor(() =>
        expect(screen.getByTestId('drawing-save-notice').textContent).toContain('Someone else saved this drawing'));
      expect(screen.getByTestId('drawing-save-notice').closest('.drw__stage')).not.toBeNull();
    });

    /*
     * Excalidraw is memoised on every prop but `initialData` and calls
     * `onChange` from each update, so a prop that changes per render loops:
     * an inline `excalidrawAPI` crashed the first stroke with "Maximum update
     * depth exceeded" (measured in Chrome).
     */
    it('hands Excalidraw the SAME callbacks across a re-render', async () => {
      const commands = { patchEntity: vi.fn() };
      const { rerender } = render(<DrawingBlock detail={detailOf()} commands={commands} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
      const first = { api: mounted.apiProp, onChange: mounted.onChange };
      act(() => mounted.onChange!([el('a', 2)], {}));
      rerender(<DrawingBlock detail={{ ...detailOf(), version: 7 }} commands={commands} />);
      expect(mounted.apiProp).toBe(first.api);
      expect(mounted.onChange).toBe(first.onChange);
    });

    it('follows the app theme', async () => {
      await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
      expect(['light', 'dark']).toContain(mounted.theme);
    });
  });

  /*
   * THE POINTER FIX. Excalidraw caches the canvas's screen offset and only
   * hears scroll on the container that was scrollable when it mounted, so a
   * panel that scrolled later put ink 175px from the pointer (measured). The
   * block re-reads the offset itself when the stage has actually moved.
   */
  describe('re-reads the canvas offset when the stage moves', () => {
    let top = 100;
    beforeEach(() => {
      top = 100;
      api.refresh.mockClear();
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ left: 10, top, right: 0, bottom: 0, width: 0, height: 0, x: 10, y: top, toJSON: () => ({}) }) as DOMRect,
      );
    });

    it('on a scroll anywhere in the page, once the stage has moved', async () => {
      await mountBlock(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
      top = 40;
      const scroller = document.createElement('div');
      document.body.appendChild(scroller);
      scroller.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(50);
      expect(api.refresh).toHaveBeenCalledTimes(1);

      // A scroll that did not move the stage costs nothing.
      scroller.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(50);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      scroller.remove();
    });

    it('when the pointer enters a stage that moved with no scroll at all', async () => {
      const { container } = render(<DrawingBlock detail={detailOf()} commands={{ patchEntity: vi.fn() }} />);
      await waitFor(() => expect(screen.getByTestId('excalidraw-mock')).toBeTruthy());
      fireEvent.pointerEnter(container.querySelector('.drw__stage')!);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      fireEvent.pointerEnter(container.querySelector('.drw__stage')!);
      expect(api.refresh).toHaveBeenCalledTimes(1);
      top = 64;
      fireEvent.pointerEnter(container.querySelector('.drw__stage')!);
      expect(api.refresh).toHaveBeenCalledTimes(2);
    });
  });

  it('the stage reserves HEIGHT in the stylesheet — invisible to every other case here', () => {
    // Excalidraw measures its container. With no height it renders at zero and
    // reads as a broken import; jsdom loads no stylesheets, so this is asserted
    // against the sheet's SOURCE or not at all.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'drawing-block.css'), 'utf8');
    const stage = css.slice(css.indexOf('.drw__stage'));
    expect(stage).toMatch(/min-height:\s*\d+px/);
  });

  /*
   * THE CURSOR FIX, pinned where jsdom can see it — the SOURCE. `app.css`
   * zooms `.cv2-root` by 1.1; Excalidraw measures its root with that zoom
   * included and writes the result back as canvas CSS size, where it applies
   * again, so ink drifted 10% of its distance from the stage's top-left
   * (measured: 36px right, 38px down at the far corner). The reciprocal on the
   * library's root is the whole fix, and it is only right while it divides by
   * the SAME literal `app.css` multiplies by.
   */
  it('counter-zooms the library root by exactly app.css’s own scale', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, 'drawing-block.css'), 'utf8');
    const app = readFileSync(join(here, '../../styles/app.css'), 'utf8');
    const scale = /\.cv2-root\s*\{\s*zoom:\s*([\d.]+);/.exec(app)?.[1];
    expect(scale).toBeDefined();
    const root = /\.drw__stage > \.excalidraw \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(root).toMatch(new RegExp(`zoom:\\s*calc\\(1 / ${scale!.replace('.', '\\.')}\\)`));
    // The mobile shell declines the 1.1, so it must decline the reciprocal too.
    expect(css).toMatch(/\.cv2-root\[data-shell='mobile'\] \.drw__stage > \.excalidraw \{\s*zoom:\s*1;/);
  });

  it('never sizes a canvas — Excalidraw sizes its own', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'drawing-block.css'), 'utf8');
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? [];
    // The ELEMENT, not the word: `[data-testid='block-canvas']` names the
    // panel section the block sits in, which the sheet does size.
    const unquoted = (sel: string) => sel.replace(/'[^']*'|"[^"]*"/g, '');
    expect(selectors.filter((sel) => /\bcanvas\b/.test(unquoted(sel)))).toEqual([]);
  });
});
