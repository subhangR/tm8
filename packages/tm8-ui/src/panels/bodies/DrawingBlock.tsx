/**
 * The Excalidraw canvas, as a panel block.
 *
 * Unlike `BlueprintBlock` — which is read-only because Craft's studio is where
 * a graph is edited — this block IS the editor. A drawing has no studio screen
 * of its own, so the panel is the only place it is ever drawn.
 *
 * FOUR THINGS SHAPE THIS COMPONENT:
 *
 * 1. Excalidraw is ~47 MB unpacked, so it is behind `React.lazy` and never
 *    enters the main chunk. It is also never loaded from a CDN: agent-maestro's
 *    mobile whiteboard did exactly that and its own README records that the
 *    board dies on an offline or VPN-only network. The assets ship with us.
 *
 * 2. Saving is DEBOUNCED and GUARDED. `onChange` fires on pointer moves,
 *    selection and scroll; `drawing-scene.ts` decides what is a real change and
 *    this component decides when to write. Every write carries the version it
 *    read (194 D4, single-writer), so a second editor loses cleanly instead of
 *    clobbering.
 *
 * 3. Embedded images are refused by the door in phase 1. The canvas must say so
 *    the moment one appears rather than let someone keep drawing on a scene
 *    that cannot be saved — the refusal is loud here precisely because the
 *    database's is a sentence the user would otherwise never see.
 *
 * 4. THE CANVAS IS THE WHOLE BODY (task 01a12506). The kind is a `frame`: no
 *    title row, no border, no sections under it. The save status rides the
 *    panel bar's slot (in a Workspace tab, the action strip) as a mark with a
 *    tooltip, and has no row of its own. A conflict or a failed save also
 *    shows as a notice over the canvas, because a tooltip is too quiet for
 *    lost work. There is no fullscreen of the block's own: the tab is already
 *    full size, and the strip's Expand covers the rest. Being a frame also
 *    takes the attachment strip off the panel, and with it the drop listener
 *    that used to upload a file dropped on the canvas as an attachment while
 *    Excalidraw was inserting the same file as an image.
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { CommandResult, EntityDetail } from '@tm8/contract';

import { entityPatchInput, type AuthoringCommands } from '../../authoring/commands';
import { getStyleState, subscribeStyle } from '../../theme/style-store';
import {
  drawingPatch,
  hasEmbeddedImages,
  sceneOf,
  sceneSignature,
} from './drawing-scene';

/* The block's own sheet travels WITH the component, the way `MachineBody`'s
   does. Leaving it to the `panels/` barrel would mean a deep-path import of
   this file renders it unstyled — and it would look fine whenever some other
   screen had already pulled the barrel, which is the worst kind of bug. */
import './drawing-block.css';

/**
 * The lazy boundary. Everything Excalidraw is behind this one import, so the
 * main bundle carries a promise and nothing else.
 */
const ExcalidrawCanvas = lazy(async () => {
  /* Excalidraw ships its stylesheet SEPARATELY (see its package exports) and
     is unusable without it — no toolbar, no panels. It is imported here,
     inside the lazy boundary, so the ~47 MB library and its CSS land in the
     same split chunk and neither reaches the main bundle. */
  const [mod] = await Promise.all([
    import('@excalidraw/excalidraw'),
    import('@excalidraw/excalidraw/index.css'),
  ]);
  return { default: mod.Excalidraw };
});

/** Idle time before a change is written. Long enough that a stroke is one save. */
const SAVE_DEBOUNCE_MS = 900;

type SaveState =
  | { phase: 'clean' }
  | { phase: 'dirty' }
  | { phase: 'saving' }
  | { phase: 'saved' }
  | { phase: 'conflict' }
  | { phase: 'error'; message: string };

/** The slice of Excalidraw's imperative API this block uses. */
interface CanvasApi {
  refresh(): void;
  updateScene(scene: { elements?: readonly unknown[]; appState?: Record<string, unknown> }): void;
  addFiles?(files: unknown[]): void;
}

export function DrawingBlock({
  detail,
  commands,
  onSaved,
  barSlot,
}: {
  detail: EntityDetail;
  commands?: Pick<AuthoringCommands, 'patchEntity'> | null;
  onSaved?: (result: CommandResult) => void;
  /** The panel bar's slot (a Workspace tab's action strip). Null ⇒ the status renders in place. */
  barSlot?: HTMLElement | null;
}) {
  const scene = useMemo(() => sceneOf(detail.content), [detail.content]);
  const editable = Boolean(commands?.patchEntity);
  const theme = useAppTheme();

  /*
   * The version this component will guard its next write with.
   *
   * It cannot simply read `detail.version` at save time: a debounced save
   * lands AFTER the host has re-rendered with the version the previous save
   * produced, and using the prop would race that re-render. The command result
   * carries the authoritative new version, so that is what we bank.
   */
  const versionRef = useRef(detail.version);
  // The content that version came with — see the remote-version effect below.
  const bankedContentRef = useRef(detail.content);
  // The signature of what the SERVER holds. Anything else is unsaved.
  const savedSignatureRef = useRef(sceneSignature(scene.elements, scene.appState));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: 'clean' });
  const [images, setImages] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<CanvasApi | null>(null);
  /*
   * STABLE, like `onChange`. Excalidraw is memoised on a shallow compare of
   * every prop but `initialData`, and it calls `onChange` from every update. A
   * fresh callback per render re-rendered it on each render of this block, and
   * the `onChange` that update fired re-rendered this block: measured in Chrome
   * as "Maximum update depth exceeded" on the first stroke.
   */
  const onApi = useCallback((api: CanvasApi) => { apiRef.current = api; }, []);

  /*
   * Re-point at a DIFFERENT entity. Not at every `detail` change: a save
   * produces a new detail object, and resetting the saved signature from it
   * would be circular. Only identity resets the baseline.
   */
  useEffect(() => {
    versionRef.current = detail.version;
    bankedContentRef.current = detail.content;
    savedSignatureRef.current = sceneSignature(scene.elements, scene.appState);
    setSave({ phase: 'clean' });
    setImages(hasEmbeddedImages(scene.elements, scene.files));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  /*
   * SOMEONE ELSE'S SAVE REACHES AN OPEN CANVAS.
   *
   * Excalidraw reads `initialData` once, at mount, so a host that hands this
   * block a newer detail (a live re-read after another actor's write) changed
   * nothing on screen until a reload. A version NEWER than the one banked is
   * not this block's own save — that one is banked before the host re-renders
   * — so its scene is pushed into the live canvas. Never over unsaved or
   * in-flight edits: those keep the canvas, and their save meets the version
   * conflict below, which is the honest outcome.
   */
  const phaseRef = useRef(save.phase);
  phaseRef.current = save.phase;
  /*
   * The content the banked version came with. A store that overlays an
   * upsert's SUMMARY (version, title) onto the cached detail keeps the old
   * content object, so a newer version can arrive with the PREVIOUS scene.
   * Banking it then would turn the real content, re-read a moment later at
   * the same version, away: the version is no longer newer. Measured in QA:
   * v14 banked over white, the yellow v14 never drawn. A version is adopted
   * only with content that was actually re-read (`bankedContentRef`).
   */
  useEffect(() => {
    if (!(detail.version > versionRef.current)) return;
    if (detail.content === bankedContentRef.current) return;
    if (phaseRef.current !== 'clean' && phaseRef.current !== 'saved') return;
    if (timerRef.current) return;
    versionRef.current = detail.version;
    bankedContentRef.current = detail.content;
    const signature = sceneSignature(scene.elements, scene.appState);
    if (signature === savedSignatureRef.current) return;
    savedSignatureRef.current = signature;
    // Files first, so an image the new version adds never renders broken.
    const files = Object.values(scene.files);
    if (files.length > 0) apiRef.current?.addFiles?.(files);
    apiRef.current?.updateScene({
      elements: scene.elements,
      appState: scene.appState,
    });
    setImages(hasEmbeddedImages(scene.elements, scene.files));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.version, scene]);

  // A pending timer must never outlive the component: it would write after the
  // panel closed, under a version nobody is watching.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  /*
   * INK LANDS UNDER THE POINTER, WHEREVER THE STAGE HAS MOVED.
   *
   * Excalidraw maps a pointer to the scene through the canvas's screen offset,
   * which it caches. It re-reads it on a window resize, on a resize of its own
   * box, and on scroll of ONE container: the nearest ancestor that was
   * scrollable AT MOUNT (`getNearestScrollableContainer`), else the document.
   * A panel whose content was still loading at mount was not scrollable yet, so
   * the library listened on the document and never heard the panel scroll.
   * Measured in Chrome: after the panel scrolled 150px, a rectangle drawn at
   * the pointer landed 175px above it, and so did a text box.
   *
   * So the block re-reads the offset itself: on any scroll in the page
   * (capture, because scroll does not bubble) and when the pointer enters the
   * stage, which covers a stage that moved without a scroll or a resize (a
   * collapsing bar above it). One read per frame, and only when the stage
   * actually moved.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    let frame = 0;
    let last = '';
    const sync = () => {
      frame = 0;
      const root = stage.querySelector('.excalidraw');
      if (!root || !apiRef.current) return;
      const { left, top } = root.getBoundingClientRect();
      const at = `${left},${top}`;
      if (at === last) return;
      last = at;
      apiRef.current.refresh();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    window.addEventListener('scroll', schedule, true);
    stage.addEventListener('pointerenter', sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      stage.removeEventListener('pointerenter', sync);
    };
  }, []);

  const commit = useCallback(async (elements: unknown, appState: unknown) => {
    if (!commands?.patchEntity) return;
    const patch = drawingPatch(elements, appState, savedSignatureRef.current);
    if (!patch) return;

    setSave({ phase: 'saving' });
    try {
      const result = await commands.patchEntity(
        detail.id,
        entityPatchInput({ content: patch.content }, versionRef.current),
      );
      // Bank BOTH: the signature so an identical change is a no-op, and the
      // version so the next guarded write is not stale.
      savedSignatureRef.current = patch.signature;
      if (result.entity?.version !== undefined) versionRef.current = result.entity.version;
      setSave({ phase: 'saved' });
      onSaved?.(result);
    } catch (error) {
      /*
       * A version conflict is not an error the user caused, and it must not
       * read like one. It means someone else saved this canvas first, and the
       * honest instruction is to reopen — this component cannot merge two
       * scenes and must not pretend it can.
       */
      const message = error instanceof Error ? error.message : 'The drawing could not be saved.';
      setSave(/conflict|version|stale/i.test(message)
        ? { phase: 'conflict' }
        : { phase: 'error', message });
    }
  }, [commands, detail.id, onSaved]);

  const onChange = useCallback((elements: readonly unknown[], appState: unknown) => {
    const embedded = hasEmbeddedImages(elements, {});
    setImages((was) => (was === embedded ? was : embedded));
    // Phase 1: an image cannot be saved, so do not schedule a write that is
    // certain to be refused — the notice below is the whole response.
    if (embedded) return;
    if (!editable) return;
    if (sceneSignature(elements, appState) === savedSignatureRef.current) return;

    // The SAME state when nothing changed, so a repeat `onChange` renders nothing.
    setSave((prev) => (prev.phase === 'saving' || prev.phase === 'dirty' ? prev : { phase: 'dirty' }));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; void commit(elements, appState); }, SAVE_DEBOUNCE_MS);
  }, [commit, editable]);

  const text = statusText(save, editable);
  const status = (
    <span
      className="drw__status"
      role="status"
      data-testid="drawing-status"
      data-phase={editable ? save.phase : 'read-only'}
      data-tip={text}
      title={text}
    >
      <span className="drw__dot" aria-hidden />
      <span className="drw__status-text">{text}</span>
    </span>
  );
  const failed = save.phase === 'conflict' || save.phase === 'error';

  return (
    <section
      className="drw"
      data-testid="drawing-block"
      aria-label={`Drawing ${detail.title ?? ''}`}
    >
      {/* In the action strip where the host offers a slot; in place where it
          does not (a fixture, a host with no bar). */}
      {barSlot ? createPortal(status, barSlot) : <header className="drw__bar">{status}</header>}

      {/* The canvas binds single keys to tools (`t` text, `r` rectangle, `/`…),
          so it tells the app's keyboard to stand back: plain keys reach
          Excalidraw, Mod-chords still reach the app. */}
      <div ref={stageRef} className="drw__stage" data-owns-keys="canvas">
        <Suspense fallback={<p className="drw__loading" role="status">Loading the canvas…</p>}>
          <ExcalidrawCanvas
            excalidrawAPI={onApi as never}
            initialData={{
              elements: scene.elements as never,
              appState: { ...scene.appState, collaborators: new Map() } as never,
              scrollToContent: true,
            }}
            theme={theme}
            viewModeEnabled={!editable}
            onChange={onChange as never}
          />
        </Suspense>
        {images || failed ? (
          <div className="drw__notices">
            {images ? (
              <p className="drw__notice" role="alert" data-testid="drawing-image-notice">
                Images can’t be saved in a drawing yet — this canvas has one, so changes are paused.
                Remove the image to start saving again, or attach it as a file instead.
              </p>
            ) : null}
            {failed ? (
              <p className="drw__notice" role="alert" data-testid="drawing-save-notice">{text}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The app's light or dark, read live from the style store (the value
 * `useTheme` derives), so the canvas follows a theme switch without a remount.
 * Excalidraw's dark mode inverts the canvas, so a saved white background
 * still reads dark: the theme is the viewer's, never part of the scene.
 */
function useAppTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeStyle, () => (getStyleState().active.darkish ? 'dark' : 'light'));
}

function statusText(save: SaveState, editable: boolean): string {
  if (!editable) return 'Read-only';
  switch (save.phase) {
    case 'clean': return 'Saved';
    case 'dirty': return 'Unsaved changes…';
    case 'saving': return 'Saving…';
    case 'saved': return 'Saved';
    case 'conflict': return 'Someone else saved this drawing — reopen it to keep editing.';
    case 'error': return save.message;
  }
}
