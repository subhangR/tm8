/**
 * The Excalidraw stand-in every vitest run uses (aliased in `vite.config.ts`).
 *
 * TWO REASONS, and the second is the one that made this file necessary:
 *
 * 1. jsdom has no canvas. The real Excalidraw cannot draw a single pixel under
 *    this runner, so loading ~47 MB of it into every panel test buys nothing
 *    and costs seconds per file.
 *
 * 2. It does not merely fail to render — it THROWS. Excalidraw depends on
 *    `open-color`, which ships its palette as `.json`, and Node's ESM loader
 *    rejects a bare JSON import without an `import attribute`. Vite rewrites
 *    that on the way to a browser, so the real app is fine; vitest's node
 *    resolution does not, so the lazy import rejects and the whole drawing
 *    body lands in the panel's CatchBoundary. That is how this was found: a
 *    kind-agnostic test asserting every panel mounts its attachment strip
 *    started failing on `drawing` — the strip was gone because the body above
 *    it had crashed.
 *
 * The stub renders a marker and nothing else. A test that needs to DRIVE the
 * canvas (`DrawingBlock.test.tsx`) declares its own `vi.mock`, which takes
 * precedence over this alias and can capture `onChange`.
 */
export function Excalidraw(props: Record<string, unknown>) {
  return (
    <div
      data-testid="excalidraw-stub"
      data-view-mode={props.viewModeEnabled ? 'true' : 'false'}
    />
  );
}

/* Named exports the real package carries, so an importing module does not
   explode on a missing binding if it reaches for one. */
export const exportToBlob = async () => new Blob();
export const serializeAsJSON = () => '{}';
export default { Excalidraw };
