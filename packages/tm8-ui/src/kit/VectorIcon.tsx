/**
 * VectorIcon — a drawn glyph on a 16×16 grid, stroked in `currentColor`.
 *
 * WHY THIS EXISTS, stated once because the reason is the whole design: a text
 * character is not an icon. The kind marks shipped as monochrome geometry —
 * `◻ ◍ ◆ ◉ ▣ ▦ ◈ ❖ ◇ ⬢` — and at the 13–16px they are actually drawn at, ten
 * of them are the same small blob. A reader looking at the Connections tab
 * could see WHAT was linked and not WHICH KIND it was, which is the defect
 * this component was built to end.
 *
 * It is also the fix the tile chevrons already found (MaestroTaskTile L215):
 * "typographic arrows sit on their own font's baseline", so text glyphs land
 * at different optical heights from each other and from the text beside them.
 * A path in a square viewBox centres exactly, every time, in every font.
 *
 * PURE PRESENTATION. It knows nothing about kinds — it is handed paths. The
 * per-kind artwork is registry DATA (`domain/kind-art.ts`), which is what
 * keeps §15.2 intact: no component here learns a kind.
 */
export function VectorIcon({
  paths,
  size = 16,
  strokeWidth = 1.4,
  filled = false,
  className,
  title,
}: {
  /** SVG path `d` strings on the 16×16 grid. Stroked, unless `filled`. */
  paths: readonly string[];
  size?: number;
  strokeWidth?: number;
  /**
   * Fill the paths in `currentColor` and draw no stroke. The house artwork in
   * `domain/kind-art.ts` is stroked outline geometry and must stay that way
   * (a filled kind mark would read as "selected" beside the stroked ones), but
   * an official third-party glyph is authored as a SOLID silhouette — stroking
   * its outline draws the outline of an outline and turns to mud at 13px.
   */
  filled?: boolean;
  className?: string;
  /**
   * An accessible name. With one, the icon is a labelled `img` — the mark IS
   * the information (a bare kind badge with no word beside it). Without one it
   * is decorative and hidden, because a word already says what it says.
   */
  title?: string;
}) {
  return (
    <svg
      /* `kit-vicon` carries the alignment (see kit.css). It is ALWAYS present,
         so an icon dropped into a caller's own span inherits the baseline fix
         without that caller having to know about it — which is what let the
         old text glyphs be swapped in place, wrapper by wrapper, with no
         layout change at any of the ~30 sites. */
      className={className ? `kit-vicon ${className}` : 'kit-vicon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={filled ? undefined : strokeWidth}
      strokeLinecap={filled ? undefined : 'round'}
      strokeLinejoin={filled ? undefined : 'round'}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
