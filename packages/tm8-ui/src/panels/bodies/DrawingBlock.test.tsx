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

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntityDetail } from '@tm8/contract';

/** Captures the props Excalidraw was mounted with, and lets a test drive onChange. */
const mounted: { onChange?: (els: unknown[], app: unknown) => void; viewMode?: boolean; initial?: unknown } = {};

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    mounted.onChange = props.onChange as (els: unknown[], app: unknown) => void;
    mounted.viewMode = props.viewModeEnabled as boolean;
    mounted.initial = props.initialData;
    return <div data-testid="excalidraw-mock" />;
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

  it('the stage reserves HEIGHT in the stylesheet — invisible to every other case here', () => {
    // Excalidraw measures its container. With no height it renders at zero and
    // reads as a broken import; jsdom loads no stylesheets, so this is asserted
    // against the sheet's SOURCE or not at all.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'drawing-block.css'), 'utf8');
    const stage = css.slice(css.indexOf('.drw__stage'));
    expect(stage).toMatch(/min-height:\s*\d+px/);
  });
});
