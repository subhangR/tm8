/**
 * E2E-ONLY vite config for the attention-dock harnesses
 * (`capture-attention-dock.mjs`, `capture-attention-undo.mjs`).
 *
 * WHY THIS EXISTS: the harness mounts a real `EntityDetailPanel`, which pulls in
 * `panels/bodies/DrawingBlock.tsx` and therefore `@excalidraw/excalidraw` — a
 * dependency the install does not carry. The VITEST config already aliases it to
 * `test/excalidraw-stub.tsx` (see the docblock there: it cannot render in jsdom
 * and its `open-color` JSON import throws under node resolution), but that alias
 * lives under `test.alias` and so does not apply to the DEV SERVER. Without it
 * the harness page 500s on an import that no attention test has any interest in.
 *
 * Same alias, same stub, applied at `resolve.alias` so the browser gets it too.
 * Dev and CI never load this file; it is passed explicitly with `--config`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [
        { find: /^@excalidraw\/excalidraw$/, replacement: resolve(here, '../test/excalidraw-stub.tsx') },
        { find: /^@excalidraw\/excalidraw\/index\.css$/, replacement: resolve(here, '../test/excalidraw-stub.css') },
      ],
    },
  }),
);
