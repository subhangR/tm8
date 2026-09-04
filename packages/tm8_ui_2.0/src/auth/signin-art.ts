/**
 * THE SIGN-IN PAGE'S GLYPHS — the 16×16 stroked-path idiom, same as
 * `domain/kind-art.ts` and drawn on the same grid.
 *
 * WHY THESE ARE AUTHORED AND NOT IMPORTED. The design was supplied as a React
 * app built on `lucide-react`, which this package does not carry and should not
 * start carrying for one screen: an icon set is a vocabulary, and a second
 * vocabulary on the front door is exactly the drift the kind registry exists to
 * prevent. So the marks are redrawn here to the house grid.
 *
 * FOUR OF THE SIX MODULE MARKS ARE NOT HERE AT ALL, and that is the point:
 * Tasks, Sessions, Chats and Docs are real tm8 kinds and already have drawings
 * in `KIND_ART`. Re-drawing them would have put two different task icons in one
 * product. Only `collab` and `multiAgent` are new, because they are the two
 * modules the design names that are not kinds.
 */

/** 16×16, stroked at 1.4 unless the mount says otherwise. */
export const SIGNIN_ART = {
  /* ── the two module marks with no kind behind them ───────────────────── */

  /** Three nodes joined at a hub — co-creation is a shape, not a person. */
  collab: [
    'M8 6.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
    'M4.1 13.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
    'M11.9 13.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
    'M6.7 6.3 5.4 9.5',
    'M9.3 6.3l1.3 3.2',
    'M6 11.3h4',
  ],
  /** A hub with four satellites: several models, one orchestration. */
  multiAgent: [
    'M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z',
    'M8 5.9V2.9',
    'M8 10.1v3',
    'M5.9 8h-3',
    'M10.1 8h3',
    'M3.7 3.7l1.6 1.6',
    'M12.3 12.3l-1.6-1.6',
  ],

  /* ── the card's own furniture ─────────────────────────────────────────── */

  /** A key — the card's badge. */
  key: [
    'M9.8 8.6a3.1 3.1 0 1 0-2.4-2.4',
    'M7.4 6.2 2.6 11v2.4H5v-1.6h1.6v-1.6h1.5l.7-.7',
  ],
  /** A person — the username field. */
  user: ['M8 8.3a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z', 'M3.3 13.6a4.7 4.7 0 0 1 9.4 0'],
  /** A padlock — the password field. */
  lock: [
    'M3.6 7.2h8.8v6.1H3.6z',
    'M5.7 7.2V5a2.3 2.3 0 0 1 4.6 0v2.2',
  ],
  /** An open eye. */
  eye: ['M1.6 8S4.1 3.7 8 3.7 14.4 8 14.4 8 11.9 12.3 8 12.3 1.6 8 1.6 8z', 'M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z'],
  /** The same eye, struck through. */
  eyeOff: [
    'M6.3 4a6.6 6.6 0 0 1 1.7-.2c3.9 0 6.4 4.2 6.4 4.2a12 12 0 0 1-1.9 2.4',
    'M4.1 5.1A11.7 11.7 0 0 0 1.6 8S4.1 12.2 8 12.2c1 0 1.9-.3 2.7-.7',
    'M2.4 2.4l11.2 11.2',
  ],
  /** An arrow — the primary's trailing mark, and each module row's chevron. */
  arrowRight: ['M2.9 8h9.4', 'M8.9 4.6 12.3 8l-3.4 3.4'],
  /** A sun. */
  sun: [
    'M8 10.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z',
    'M8 1.5v1.6', 'M8 13v1.6', 'M1.5 8h1.6', 'M13 8h1.6',
    'M3.4 3.4 4.5 4.5', 'M11.5 11.5l1.1 1.1', 'M12.6 3.4l-1.1 1.1', 'M4.5 11.5 3.4 12.6',
  ],
  /** A crescent. */
  moon: ['M13.2 9.4A5.7 5.7 0 0 1 6.6 2.8a5.9 5.9 0 1 0 6.6 6.6z'],
  /** Two people — "built for teams". */
  team: [
    'M6.2 7.6a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
    'M1.9 13.2a4.3 4.3 0 0 1 8.6 0',
    'M10.6 3.4a2.2 2.2 0 0 1 0 4.3',
    'M11.6 9.5a4.3 4.3 0 0 1 2.5 3.7',
  ],
  /** One person in a frame — "built for individuals". */
  individual: [
    'M8 8.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z',
    'M4.6 12.9a3.5 3.5 0 0 1 6.8 0',
    'M2.4 2.4h11.2v11.2H2.4z',
  ],
} as const;

export type SignInGlyph = keyof typeof SIGNIN_ART;
