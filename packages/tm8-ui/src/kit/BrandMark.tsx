/**
 * BrandMark — the tm8 product mark, drawn wherever the brand line appears
 * (the shell tab bar, the auth stage, the invite landing).
 *
 * It replaces the `◈` placeholder glyph those four call sites used to share.
 * The asset is a raster served from the app root (`public/tm8-mark.png`), sized
 * in `em` so it tracks whatever font-size the brand line is set at — 11.5px in
 * the tab bar, 13px in the auth and invite stages — instead of each site
 * carrying its own pixel number. `alt` is empty on purpose: every call site
 * already prints the "tm8" wordmark next to it, so a description here would be
 * read out twice.
 */
export function BrandMark() {
  return <img className="kit-brandmark" src="/tm8-mark.png" alt="" />;
}
