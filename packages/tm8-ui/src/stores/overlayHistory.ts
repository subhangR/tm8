/**
 * overlayHistory — ANDROID BACK CLOSES THE LAYER, NOT THE SCREEN (task t-layers).
 *
 * The phone's drawer and sheets are layers over a screen, not screens. Without
 * this, Android Back (and the desktop back button on a coarse tablet) skips
 * the open drawer and walks the screen underneath away, which reads as the
 * app ignoring the gesture.
 *
 * ── THE MECHANISM ──────────────────────────────────────────────────────────
 *
 * Opening a layer pushes ONE history entry with the SAME URL and a marker in
 * its state (`OVERLAY_STATE_KEY`). Back pops that entry, `popstate` fires, and
 * the layer whose marker is no longer current is dismissed. Closing by ✕,
 * scrim, Escape or swipe dismisses at once and calls `history.back()` to take
 * the marker off again, so markers never pile up.
 *
 * ── WHY THIS IS NOT "FIGHTING BACK" (CONTRACT §5 ruling 1) ─────────────────
 *
 * Nothing here intercepts a route change. The marker has the address of the
 * entry below it, so `hashchange` never fires for it and the router never sees
 * it; this module reacts to `popstate` for ITS OWN marker and nothing else.
 * Back still walks real history: one press, one entry, one thing undone.
 *
 * WHY IT LIVES IN `stores/` AND NOT IN `mobile/`. The mobile shell must not
 * drive history (`mobile/no-router-fork.test.ts`); the store layer is where
 * history is driven, beside `navStore`. The router knows about the marker in
 * the two places it must (`routes/transport.ts`): a push made over a marker
 * replaces it, and a settle keeps it.
 *
 * ── ORDERING ──────────────────────────────────────────────────────────────
 *
 * `history.back()` is asynchronous. A drawer row that opens a sheet closes the
 * drawer (back, in flight) and mounts the sheet (push) in one tap; a push made
 * before the back lands would be the entry the back removes. So pushes wait
 * while a back of ours is in flight, and run when its `popstate` arrives.
 */
import { useCallback, useEffect, useRef } from 'react';
import { OVERLAY_STATE_KEY, overlayIdOf } from '../routes';

interface Layer {
  readonly id: string;
  /** The marker entry for this layer is in history and has not been popped. */
  pushed: boolean;
  readonly onPop: () => void;
}

/** Open layers, bottom first. */
const layers: Layer[] = [];
/** Layers waiting for a back of ours to land before they push. */
const queued: Layer[] = [];
let backsInFlight = 0;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let seq = 0;

/*
 * A back that never produces `popstate` (a sandboxed frame, a test that
 * replaced the window) must not hold every later push hostage. Real browsers
 * deliver it within a frame or two; half a second is generous.
 */
const STALE_BACK_MS = 500;

function canUseHistory(): boolean {
  return typeof window !== 'undefined' && typeof window.history?.pushState === 'function';
}

function pushMarker(layer: Layer): void {
  try {
    window.history.pushState({ [OVERLAY_STATE_KEY]: layer.id }, '');
    layer.pushed = true;
  } catch {
    /* A frame that refuses pushState still gets a working layer; only Back
       falls through to the screen, which is what happened before. */
  }
}

function flushQueued(): void {
  while (backsInFlight === 0 && queued.length > 0) {
    const layer = queued.shift()!;
    if (layers.includes(layer)) pushMarker(layer);
  }
}

function settleBack(): void {
  if (backsInFlight > 0) backsInFlight -= 1;
  if (backsInFlight === 0 && staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  flushQueued();
}

function onPopState(): void {
  const ours = backsInFlight > 0;
  settleBack();
  const at = overlayIdOf(window.history.state);
  const below = at === null ? -1 : layers.findIndex((layer) => layer.id === at);
  /* Everything above the entry we landed on is gone. A back of OUR making
     only ever removes a marker that is in history, so it pops only layers
     that pushed one; a reader's Back also closes a layer whose marker a
     navigation already consumed, because the screen it covered is leaving. */
  for (let i = layers.length - 1; i > below; i -= 1) {
    const layer = layers[i]!;
    if (ours && !layer.pushed) continue;
    layer.pushed = false;
    layers.splice(i, 1);
    layer.onPop();
  }
  flushQueued();
}

function goBack(): void {
  backsInFlight += 1;
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    staleTimer = null;
    backsInFlight = 0;
    flushQueued();
  }, STALE_BACK_MS);
  window.history.back();
}

function open(layer: Layer): void {
  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  layers.push(layer);
  if (backsInFlight > 0) queued.push(layer);
  else pushMarker(layer);
}

/** Take the layer out, and its marker with it when the marker is still on top. */
function release(layer: Layer): void {
  const index = layers.indexOf(layer);
  if (index !== -1) layers.splice(index, 1);
  const q = queued.indexOf(layer);
  if (q !== -1) queued.splice(q, 1);
  /* Only when OUR entry is current. If a navigation consumed the marker the
     current entry is the new screen, and going back would undo the
     navigation the reader just made. */
  if (layer.pushed && overlayIdOf(window.history.state) === layer.id) goBack();
  layer.pushed = false;
}

/**
 * Give an open layer its Back entry.
 *
 * While `active`, the layer holds one marker entry; Back dismisses it through
 * `onPop`. The returned `close` is what every other dismissal (✕, scrim,
 * Escape, swipe) must call: it runs `onPop` NOW and takes the marker off.
 * Unmounting the layer without `close` also takes the marker off, so an owner
 * that simply stops rendering it leaves no dead entry behind.
 *
 * Inert where there is no history (SSR, a frame without `pushState`): `close`
 * still runs `onPop`.
 */
export function useOverlayEntry(active: boolean, onPop: () => void): () => void {
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  const layerRef = useRef<Layer | null>(null);

  useEffect(() => {
    if (!active || !canUseHistory()) return;
    seq += 1;
    const layer: Layer = { id: `layer-${seq}`, pushed: false, onPop: () => onPopRef.current() };
    layerRef.current = layer;
    open(layer);
    return () => {
      if (layerRef.current === layer) layerRef.current = null;
      release(layer);
    };
  }, [active]);

  return useCallback(() => {
    const layer = layerRef.current;
    layerRef.current = null;
    if (layer) release(layer);
    onPopRef.current();
  }, []);
}

/** Test helper: forget every layer and in-flight back. */
export function resetOverlayHistory(): void {
  layers.length = 0;
  queued.length = 0;
  backsInFlight = 0;
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
}
