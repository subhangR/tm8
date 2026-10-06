/** Workspace rail glyphs (design log R36), on the VectorIcon 16×16 grid, stroked, drawn at 18px. */

/** » while collapsed; « (mirrored) while expanded. */
export const RAIL_EXPAND_ART: readonly string[] = ['M4 4.4 7.6 8 4 11.6', 'M8.6 4.4 12.2 8l-3.6 3.6'];
export const RAIL_COLLAPSE_ART: readonly string[] = ['M12 4.4 8.4 8l3.6 3.6', 'M7.4 4.4 3.8 8l3.6 3.6'];

/** A bell: the rail's Needs you button (D31, Design Advisor R39). */
export const RAIL_BELL_ART: readonly string[] = [
  'M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1.2 1.4H3z',
  'M6.6 13.6a1.5 1.5 0 0 0 2.8 0',
];

/** A back arrow: the switch from the tools face back to the kinds (the 2×2 grid is Collections'). */
export const RAIL_KINDS_ART: readonly string[] = ['M13 8H3.5', 'M7.2 4.3 3.5 8l3.7 3.7'];
