/**
 * The drawing block's pure half: everything about an Excalidraw scene that can
 * be decided without Excalidraw.
 *
 * WHY THIS IS A SEPARATE MODULE. `@excalidraw/excalidraw` is ~47 MB unpacked
 * and is loaded lazily, so it must never be imported by anything that runs on
 * the main path — including a test. Every rule below is therefore expressed
 * over plain objects, which is also what makes them testable at all: jsdom
 * cannot render a canvas, so a test that had to mount Excalidraw to check the
 * save rules would check nothing.
 *
 * The rules themselves exist because Excalidraw's `onChange` is FAR noisier
 * than "the drawing changed". It fires on pointer moves, on selection, on
 * scroll and on zoom — hundreds of times during one drag. Persisting those
 * would spend a version bump, a row write and a history snapshot on moving the
 * mouse, and under the single-writer version guard (194 D4) it would also mean
 * a second viewer's panel conflicts with a scroll.
 */

/** The scene as the server stores it — `EntityContent`'s `drawing` arm. */
export interface DrawingScene {
  format: string;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/**
 * The appState members worth storing.
 *
 * An ALLOWLIST, not a denylist of the transient ones. Excalidraw adds appState
 * members freely between releases, and a denylist silently starts persisting
 * each new one — which is how scroll position ends up in a shared row. Anything
 * unrecognised is dropped, so the failure mode of an upstream upgrade is "a
 * preference stopped being remembered", never "the canvas saves on mouse move".
 *
 * Everything here is a durable property OF THE DRAWING. Deliberately absent:
 * `scrollX`/`scrollY`/`zoom` (where THIS viewer is looking), `cursorButton`,
 * `selectedElementIds`, `editingElement`, `draggingElement`, `width`/`height`
 * (the viewport's, not the drawing's), and `collaborators`.
 */
export const PERSISTED_APP_STATE_KEYS: readonly string[] = Object.freeze([
  'viewBackgroundColor',
  'gridSize',
  'gridModeEnabled',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemStartArrowhead',
  'currentItemEndArrowhead',
  'currentItemRoundness',
  'currentChartType',
  'exportBackground',
  'exportWithDarkMode',
  'exportEmbedScene',
  'exportScale',
  'frameRendering',
  'objectsSnapModeEnabled',
]);

/** Keep only the durable members; drop everything else, known or not. */
export function persistableAppState(appState: unknown): Record<string, unknown> {
  if (!isRecord(appState)) return {};
  const out: Record<string, unknown> = {};
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(appState, key)) {
      const value = appState[key];
      // `undefined` is not JSON and would vanish on the wire anyway; storing
      // it would make two equal scenes compare unequal.
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/**
 * Strip an element to what the row should hold.
 *
 * Excalidraw marks a deleted element `isDeleted: true` and keeps it in the
 * array so that UNDO can bring it back. That is a session concern: persisting
 * tombstones means a board someone has been editing all day grows without its
 * picture changing, and every reader pays for shapes nobody can see. They are
 * dropped on save; undo still works for the live session because Excalidraw
 * holds its own history in memory.
 */
export function persistableElements(elements: unknown): Record<string, unknown>[] {
  if (!Array.isArray(elements)) return [];
  return elements.filter((el): el is Record<string, unknown> => isRecord(el) && el.isDeleted !== true);
}

/** Read a drawing's scene out of an entity's content, with lean fallbacks. */
export function sceneOf(content: unknown): DrawingScene {
  const c = isRecord(content) ? content : {};
  return {
    format: typeof c.format === 'string' && c.format.length > 0 ? c.format : 'excalidraw',
    elements: Array.isArray(c.elements) ? c.elements.filter(isRecord) : [],
    appState: isRecord(c.appState) ? c.appState : {},
    files: isRecord(c.files) ? c.files : {},
  };
}

/**
 * A change signature: the smallest value that differs exactly when the SAVED
 * scene would differ.
 *
 * Elements are reduced to `id` + Excalidraw's own `version`, which upstream
 * bumps on every real mutation of a shape. That is both far cheaper than
 * deep-comparing ~30 fields per element and more correct than comparing
 * `JSON.stringify(elements)`, which also differs when Excalidraw merely
 * reorders equal elements.
 */
export function sceneSignature(elements: unknown, appState: unknown): string {
  const marks = persistableElements(elements)
    .map((el) => `${String(el.id ?? '')}:${String(el.version ?? '')}`)
    .join(',');
  return `${marks}|${stableStringify(persistableAppState(appState))}`;
}

/**
 * True when the canvas holds anything Excalidraw would store in `files`.
 *
 * Phase 1's doors REFUSE a non-empty files map (194 D3), so this is what lets
 * the block say so before the user keeps drawing on top of work that cannot be
 * saved. Both halves are checked: `files` itself, and image elements — a
 * scene can carry an `image` element whose bytes have not landed in `files`
 * yet, and warning only on `files` would miss the moment of the paste.
 */
export function hasEmbeddedImages(elements: unknown, files: unknown): boolean {
  if (isRecord(files) && Object.keys(files).length > 0) return true;
  return persistableElements(elements).some((el) => el.type === 'image');
}

/** The patch body for `entities.patch`, or null when nothing worth saving changed. */
export function drawingPatch(
  elements: unknown,
  appState: unknown,
  savedSignature: string,
): { content: Record<string, unknown>; signature: string } | null {
  const signature = sceneSignature(elements, appState);
  if (signature === savedSignature) return null;
  return {
    signature,
    content: {
      elements: persistableElements(elements),
      appState: persistableAppState(appState),
      // `files` is deliberately NOT sent. It is always `{}` in phase 1 and the
      // door refuses anything else, so omitting it keeps the door's refusal
      // reachable only through a real paste rather than through every save.
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Key-sorted stringify so member order never fakes a change. */
function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}
