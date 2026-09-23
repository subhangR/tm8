/**
 * The drawing save rules.
 *
 * These matter more than they look. Excalidraw's `onChange` fires on pointer
 * moves, selection, scroll and zoom, so "did the drawing change" is a
 * judgement this module makes hundreds of times per drag — and every wrong
 * `true` costs a version bump, a row write, a history snapshot, and a version
 * conflict for anyone else with the panel open (194 D4, single-writer).
 *
 * jsdom cannot render a canvas, so none of this is reachable through a mounted
 * Excalidraw. That is exactly why the rules live in a module with no
 * Excalidraw import at all.
 */
import { describe, expect, it } from 'vitest';

import {
  PERSISTED_APP_STATE_KEYS,
  canvasClaimsEscape,
  drawingPatch,
  hasEmbeddedImages,
  persistableAppState,
  persistableElements,
  sceneOf,
  sceneSignature,
} from './drawing-scene';

const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id, version, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...extra,
});

describe('persistableAppState — an allowlist, because a denylist leaks', () => {
  it('keeps the durable members', () => {
    const kept = persistableAppState({
      viewBackgroundColor: '#ffffff',
      gridSize: 20,
      currentItemStrokeColor: '#1e1e1e',
    });
    expect(kept).toEqual({
      viewBackgroundColor: '#ffffff',
      gridSize: 20,
      currentItemStrokeColor: '#1e1e1e',
    });
  });

  it('drops where THIS viewer is looking — the whole reason the rule exists', () => {
    // Persisting any of these turns scrolling into a write, and under the
    // single-writer guard turns a second viewer's scroll into a conflict.
    const kept = persistableAppState({
      viewBackgroundColor: '#ffffff',
      scrollX: 812, scrollY: -44, zoom: { value: 1.75 },
      cursorButton: 'down',
      selectedElementIds: { 'a': true },
      editingElement: el('a', 3),
      draggingElement: el('a', 3),
      width: 1440, height: 900,
      collaborators: {},
    });
    expect(kept).toEqual({ viewBackgroundColor: '#ffffff' });
  });

  it('drops an UNKNOWN member, so an Excalidraw upgrade cannot start persisting one', () => {
    // The failure mode of an upstream release is "a preference stopped being
    // remembered", never "the canvas saves on mouse move".
    const kept = persistableAppState({ viewBackgroundColor: '#fff', someFutureTransientThing: 9 });
    expect(kept).toEqual({ viewBackgroundColor: '#fff' });
  });

  it('never lists a viewport member in the allowlist itself', () => {
    for (const banned of ['scrollX', 'scrollY', 'zoom', 'cursorButton', 'selectedElementIds', 'width', 'height']) {
      expect(PERSISTED_APP_STATE_KEYS).not.toContain(banned);
    }
  });

  it('survives junk', () => {
    expect(persistableAppState(null)).toEqual({});
    expect(persistableAppState('nope')).toEqual({});
    expect(persistableAppState([1, 2])).toEqual({});
  });
});

describe('persistableElements — tombstones are a session concern', () => {
  it('drops isDeleted elements', () => {
    const kept = persistableElements([el('a', 1), el('b', 2, { isDeleted: true }), el('c', 1)]);
    expect(kept.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('keeps an element that merely has isDeleted false or absent', () => {
    const kept = persistableElements([el('a', 1, { isDeleted: false }), el('b', 1)]);
    expect(kept).toHaveLength(2);
  });

  it('survives junk', () => {
    expect(persistableElements(null)).toEqual([]);
    expect(persistableElements([null, 'x', el('a', 1)])).toHaveLength(1);
  });
});

describe('sceneSignature — what counts as a change', () => {
  it('is stable when nothing changed', () => {
    const a = [el('a', 1), el('b', 2)];
    expect(sceneSignature(a, { viewBackgroundColor: '#fff' }))
      .toBe(sceneSignature([el('a', 1), el('b', 2)], { viewBackgroundColor: '#fff' }));
  });

  it('does NOT move when only the viewport moved', () => {
    const a = [el('a', 1)];
    expect(sceneSignature(a, { viewBackgroundColor: '#fff', scrollX: 0, zoom: { value: 1 } }))
      .toBe(sceneSignature(a, { viewBackgroundColor: '#fff', scrollX: 999, zoom: { value: 4 } }));
  });

  it('does NOT move when only the SELECTION changed', () => {
    const a = [el('a', 1)];
    expect(sceneSignature(a, { selectedElementIds: {} }))
      .toBe(sceneSignature(a, { selectedElementIds: { a: true } }));
  });

  it('DOES move when a shape is edited — Excalidraw bumps element.version', () => {
    expect(sceneSignature([el('a', 1)], {})).not.toBe(sceneSignature([el('a', 2)], {}));
  });

  it('DOES move when a shape is added or removed', () => {
    expect(sceneSignature([el('a', 1)], {})).not.toBe(sceneSignature([el('a', 1), el('b', 1)], {}));
    expect(sceneSignature([el('a', 1), el('b', 1)], {}))
      .not.toBe(sceneSignature([el('a', 1), el('b', 1, { isDeleted: true })], {}));
  });

  it('DOES move when a durable preference changed', () => {
    expect(sceneSignature([el('a', 1)], { viewBackgroundColor: '#fff' }))
      .not.toBe(sceneSignature([el('a', 1)], { viewBackgroundColor: '#000' }));
  });

  it('is not fooled by appState member ORDER', () => {
    expect(sceneSignature([], { gridSize: 20, viewBackgroundColor: '#fff' }))
      .toBe(sceneSignature([], { viewBackgroundColor: '#fff', gridSize: 20 }));
  });
});

describe('hasEmbeddedImages — the phase-1 refusal, caught before work is lost', () => {
  it('is false for an ordinary scene', () => {
    expect(hasEmbeddedImages([el('a', 1)], {})).toBe(false);
  });

  it('is true once files carries bytes', () => {
    expect(hasEmbeddedImages([], { f1: { mimeType: 'image/png' } })).toBe(true);
  });

  it('is true on the IMAGE ELEMENT alone, before its bytes reach files', () => {
    // The moment of the paste: warning only on `files` would miss it, and the
    // user would keep drawing on a canvas that cannot save.
    expect(hasEmbeddedImages([el('a', 1, { type: 'image' })], {})).toBe(true);
  });

  it('ignores a DELETED image — undoing the paste clears the warning', () => {
    expect(hasEmbeddedImages([el('a', 1, { type: 'image', isDeleted: true })], {})).toBe(false);
  });
});

describe('drawingPatch — what actually goes on the wire', () => {
  it('returns null when the signature is unchanged, so an idle canvas never writes', () => {
    const elements = [el('a', 1)];
    const sig = sceneSignature(elements, {});
    expect(drawingPatch(elements, {}, sig)).toBeNull();
  });

  it('returns a patch of elements and appState ONLY — never files', () => {
    // `files` is always {} in phase 1 and the door refuses anything else.
    // Sending it on every save would make the refusal unreachable except
    // through a real paste, which is where we want it.
    const patch = drawingPatch([el('a', 2)], { viewBackgroundColor: '#fff', scrollX: 9 }, 'stale');
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!.content).sort()).toEqual(['appState', 'elements']);
    expect(patch!.content.appState).toEqual({ viewBackgroundColor: '#fff' });
    expect(patch!.content.elements).toHaveLength(1);
  });

  it('strips tombstones out of the patch body, not only out of the signature', () => {
    const patch = drawingPatch([el('a', 1), el('b', 1, { isDeleted: true })], {}, 'stale');
    expect((patch!.content.elements as unknown[])).toHaveLength(1);
  });

  it('hands back the signature it just computed, so the caller can bank it', () => {
    const patch = drawingPatch([el('a', 5)], { gridSize: 20 }, 'stale');
    expect(patch!.signature).toBe(sceneSignature([el('a', 5)], { gridSize: 20 }));
    // ...and banking it makes the very next identical change a no-op.
    expect(drawingPatch([el('a', 5)], { gridSize: 20 }, patch!.signature)).toBeNull();
  });
});

describe('sceneOf — reading a drawing out of entity content', () => {
  it('reads a real content arm', () => {
    expect(sceneOf({
      kind: 'drawing', format: 'excalidraw',
      elements: [el('a', 1)], appState: { gridSize: 20 }, files: {},
    })).toEqual({
      format: 'excalidraw', elements: [el('a', 1)], appState: { gridSize: 20 }, files: {},
    });
  });

  it('falls back to an empty excalidraw scene, never to undefined', () => {
    expect(sceneOf(undefined)).toEqual({ format: 'excalidraw', elements: [], appState: {}, files: {} });
    expect(sceneOf({ kind: 'task' })).toEqual({ format: 'excalidraw', elements: [], appState: {}, files: {} });
  });

  it('keeps a FORMAT it does not know — a second canvas format costs no UI change', () => {
    expect(sceneOf({ format: 'tldraw-ish' }).format).toBe('tldraw-ish');
  });
});

describe('canvasClaimsEscape — whose Escape a press is', () => {
  const idle = { activeTool: { type: 'selection' }, selectedElementIds: {}, editingTextElement: null, openPopup: null };

  it('an idle canvas has no use for Escape — the block may spend it', () => {
    expect(canvasClaimsEscape(idle)).toBe(false);
  });

  it('a SELECTION does not claim it — Excalidraw 0.18.1 does not deselect on Escape', () => {
    // Claiming it would make fullscreen impossible to leave by key with
    // anything selected, since no number of presses clears the selection.
    expect(canvasClaimsEscape({ ...idle, selectedElementIds: { a: true } })).toBe(false);
  });

  it('a non-selection tool claims it — Escape drops the tool', () => {
    expect(canvasClaimsEscape({ ...idle, activeTool: { type: 'rectangle' } })).toBe(true);
  });

  it.each([
    ['editingTextElement', { id: 't' }],
    ['newElement', { id: 'n' }],
    ['multiElement', { id: 'm' }],
    ['editingLinearElement', { elementId: 'l' }],
    ['croppingElementId', 'img'],
    ['contextMenu', { items: [] }],
    ['openMenu', 'canvas'],
    ['openPopup', 'elementStroke'],
    ['openDialog', { name: 'help' }],
    ['openSidebar', { name: 'default' }],
  ])('%s claims it — Escape finishes or closes it', (key, value) => {
    expect(canvasClaimsEscape({ ...idle, [key]: value })).toBe(true);
  });

  it('knows nothing before the first onChange, and claims nothing', () => {
    expect(canvasClaimsEscape(null)).toBe(false);
    expect(canvasClaimsEscape(undefined)).toBe(false);
  });
});
