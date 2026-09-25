/**
 * Render the in-app Möbius ribbon 8 (`RibbonMark`, standalone layout, rest
 * pose) to `public/tm8-mark.svg` — the ONE vector every icon is cut from.
 *
 * WHY RENDER THE COMPONENT rather than keep a drawn asset: the favicon, the
 * PWA icons and the desktop app icon used to be traced from an old raster (an
 * 8 with eyes and arms) that the app itself stopped drawing when BrandMark
 * moved to the ribbon. Rendering the component means the icons are the mark
 * the app shows, by construction, and they cannot drift from it.
 *
 *   bun scripts/render-ribbon-svg.tsx && python3 scripts/gen-pwa-icons.py
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { RibbonMark } from '../src/kit/RibbonMark';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tm8-mark.svg');
const markup = renderToStaticMarkup(<RibbonMark animated={false} />)
  // Runtime-only attributes: the breathe transform is scale(1.0000) at rest,
  // and the test id means nothing outside the app.
  .replace(/ style="[^"]*"/, '')
  .replace(/ data-testid="[^"]*"/, '')
  .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
writeFileSync(out, `${markup}\n`);
console.log(`wrote ${out} (${markup.length} bytes)`);
