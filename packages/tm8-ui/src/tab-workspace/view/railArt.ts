/**
 * Workspace rail glyphs (design log R36), on the VectorIcon 16×16 grid,
 * stroked, drawn at 18px. Section ids are `homeRailGroups()` ids.
 */
export const RAIL_SECTION_ART: Readonly<Record<string, readonly string[]>> = {
  /* stacked layers */
  work: ['M8 2.6 13.4 5.4 8 8.2 2.6 5.4z', 'M2.6 8.2 8 11l5.4-2.8', 'M2.6 10.9 8 13.7l5.4-2.8'],
  /* books on a shelf */
  library: ['M3 3.4h2.6v9.8H3z', 'M6.8 4.6h2.6v8.6H6.8z', 'M10.5 5.6l2.3-.6 2 7.9-2.3.6z'],
  /* two people */
  people: [
    'M6.2 8.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
    'M2 13.4a4.2 4.2 0 0 1 8.4 0',
    'M10.6 3.8a2.1 2.1 0 1 1 0 4.2',
    'M11.4 9.3a4 4 0 0 1 2.8 4.1',
  ],
  /* </> — not a branch (collides with pull_request / commit) */
  code: ['M5.4 4.6 2.4 8l3 3.4', 'M10.6 4.6l3 3.4-3 3.4', 'M9.2 3.2 6.8 12.8'],
};

/** » while collapsed; « (mirrored) while expanded. */
export const RAIL_EXPAND_ART: readonly string[] = ['M4 4.4 7.6 8 4 11.6', 'M8.6 4.4 12.2 8l-3.6 3.6'];
export const RAIL_COLLAPSE_ART: readonly string[] = ['M12 4.4 8.4 8l3.6 3.6', 'M7.4 4.4 3.8 8l3.6 3.6'];
