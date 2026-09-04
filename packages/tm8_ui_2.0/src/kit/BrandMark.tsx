import { RibbonMark } from './RibbonMark';

/**
 * BrandMark — the tm8 wordmark, drawn wherever the brand line appears (the
 * shell tab bar, the auth stage, the invite landing).
 *
 * WHAT CHANGED, AND WHY IT IS NOT JUST A NEW ASSET. This used to be a raster
 * (`public/tm8-mark.png`) that every call site followed with the literal text
 * `tm8` — so the brand was a decorative glyph sitting next to a word that
 * repeated it. It is now one thing: the letters "tm", and the Möbius ribbon
 * standing in for the 8. That is the wordmark layout the design shipped, and
 * it is why the ribbon's `wordmark` box is smaller and less tilted than the
 * standalone mark's — beside letters it has to sit on a baseline.
 *
 * STILL, NOT TURNING. The mark lives in the header for the whole session. A
 * logo that rotates forever burns a frame's work for as long as the app is
 * open and asks the eye to track something that never resolves; motion here
 * would also spend the signal that makes the BOOT mark mean "waiting". So the
 * ribbon holds its rest pose, and turning is reserved for wait states.
 *
 * The letters inherit their font, size and colour from the brand line that
 * hosts them — mono/brass at 11.5px in the tab bar, 13px on the auth and
 * invite stages — so this adds no type of its own and no webfont.
 *
 * ACCESSIBILITY. The whole thing is one image with the accessible name "tm8":
 * the "8" is a drawing, so without a name a reader would announce a bare "tm".
 * Call sites that already label a wrapping control (the tab bar's door button
 * says "tm8 — back to conversations") nest this inside that label rather than
 * doubling it.
 */
export function BrandMark() {
  return (
    <span className="kit-brandmark" role="img" aria-label="tm8">
      <span className="kit-brandmark__letters" aria-hidden="true">
        tm
      </span>
      {/* THE 8 TURNS, as it does on the splash (owner, 2026-08-31). `animated`
          was already the knob — the splash passes it and this call site did
          not, so the same mark was alive on the way in and static forever
          after. RibbonMark checks `prefers-reduced-motion` itself and stops
          turning, so this is not a motion the reader cannot refuse. */}
      <RibbonMark className="kit-brandmark__eight" layout="wordmark" animated />
    </span>
  );
}
