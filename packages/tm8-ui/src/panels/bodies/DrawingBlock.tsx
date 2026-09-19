/**
 * The Excalidraw canvas, as a panel block.
 *
 * Unlike `BlueprintBlock` — which is read-only because Craft's studio is where
 * a graph is edited — this block IS the editor. A drawing has no studio screen
 * of its own, so the panel is the only place it is ever drawn.
 *
 * THREE THINGS SHAPE THIS COMPONENT:
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
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';

import { entityPatchInput, type AuthoringCommands } from '../../authoring/commands';
import { drawingPatch, hasEmbeddedImages, sceneOf, sceneSignature } from './drawing-scene';

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

export function DrawingBlock({
  detail,
  commands,
  onSaved,
}: {
  detail: EntityDetail;
  commands?: Pick<AuthoringCommands, 'patchEntity'> | null;
  onSaved?: (result: CommandResult) => void;
}) {
  const scene = useMemo(() => sceneOf(detail.content), [detail.content]);
  const editable = Boolean(commands?.patchEntity);

  /*
   * The version this component will guard its next write with.
   *
   * It cannot simply read `detail.version` at save time: a debounced save
   * lands AFTER the host has re-rendered with the version the previous save
   * produced, and using the prop would race that re-render. The command result
   * carries the authoritative new version, so that is what we bank.
   */
  const versionRef = useRef(detail.version);
  // The signature of what the SERVER holds. Anything else is unsaved.
  const savedSignatureRef = useRef(sceneSignature(scene.elements, scene.appState));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: 'clean' });
  const [images, setImages] = useState(false);

  /*
   * Re-point at a DIFFERENT entity. Not at every `detail` change: a save
   * produces a new detail object, and resetting the saved signature from it
   * would be circular. Only identity resets the baseline.
   */
  useEffect(() => {
    versionRef.current = detail.version;
    savedSignatureRef.current = sceneSignature(scene.elements, scene.appState);
    setSave({ phase: 'clean' });
    setImages(hasEmbeddedImages(scene.elements, scene.files));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  // A pending timer must never outlive the component: it would write after the
  // panel closed, under a version nobody is watching.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

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

    setSave((prev) => (prev.phase === 'saving' ? prev : { phase: 'dirty' }));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void commit(elements, appState); }, SAVE_DEBOUNCE_MS);
  }, [commit, editable]);

  return (
    <section className="drw" data-testid="drawing-block" aria-label={`Drawing ${detail.title ?? ''}`}>
      <header className="drw__bar">
        <span className="drw__status" role="status" data-testid="drawing-status">
          {statusText(save, editable)}
        </span>
      </header>

      {images ? (
        <p className="drw__notice" role="alert" data-testid="drawing-image-notice">
          Images can’t be saved in a drawing yet — this canvas has one, so changes are paused.
          Remove the image to start saving again, or attach it as a file instead.
        </p>
      ) : null}

      <div className="drw__stage">
        <Suspense fallback={<p className="drw__loading" role="status">Loading the canvas…</p>}>
          <ExcalidrawCanvas
            initialData={{
              elements: scene.elements as never,
              appState: { ...scene.appState, collaborators: new Map() } as never,
              scrollToContent: true,
            }}
            viewModeEnabled={!editable}
            onChange={onChange as never}
          />
        </Suspense>
      </div>
    </section>
  );
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
