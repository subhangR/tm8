import { useEffect, useState } from 'react';

/**
 * RibbonMark — the tm8 figure-8, as a Möbius ribbon in pseudo-3D.
 *
 * This is a near-verbatim port of the design source (see
 * `.scratch/tm8-loader/tm8-loader-source.jsx`, extracted from the
 * `tm8-loader-spin-rewind.html` bundle). The geometry, the shading and the
 * three motion helpers are carried across unchanged on purpose: the mark is
 * the thing being reviewed, so a "tidier" reimplementation would be reviewing
 * something else. Deliberate deviations from the source are only these:
 *
 *  - the `up: false` curve is dropped. The shipped configuration is
 *    `up = true`, so the other branch was dead code that could only drift.
 *    (The wordmark layout was dropped with it and has since been brought
 *    back — see `LAYOUT`.)
 *  - the authored-clock engine (`animations-v3.jsx`, ~54KB of scene editor) is
 *    not a runtime dependency. Its two easings and its `animate()` are inlined
 *    below verbatim, and one shared rAF replaces the composition stage.
 *
 * COST, MEASURED. Every frame rebuilds the whole z-sorted <polygon> band
 * through React, so the bill is per mounted, turning mark. That sounded
 * expensive enough to gate the follow-up lanes on measuring it. It is not, at
 * the scale anything here mounts: two marks turning together in Chat Home cost
 * nothing detectable — 120.5fps median with them and 120.5 without, p95 9.2ms
 * either way (packages/tm8-ui/gate-evidence/chat-ribbon.md).
 *
 * What DOES matter at glyph size is that the quads stop being visible long
 * before they stop being computed, which is what `segments` is for, and that
 * marks must not multiply per row — a list that mounts one per item is still
 * the way this gets expensive. `animated={false}` is the other half of that:
 * a mark that lives on screen for the whole session should not turn at all.
 */

const TAU = Math.PI * 2;

type V3 = [number, number, number];

const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vcross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vdot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vnorm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Segments at full size. The design authored 150 and boot ships all of them.
 *
 * It is a BUDGET, not a constant, because the number that is right at 150px is
 * absurd at 14px: a glyph-size mark spends 150 quads to cover ~11px of arc
 * each, which is a third of a pixel — under the device's own sampling grid, so
 * the extra quads cannot be seen, only paid for. `segments` lets a small mount
 * buy what it can actually show. Measured, not guessed: see `chat-home.css` for
 * the numbers behind the two sizes that ship.
 */
const N_SEG = 150;

/** The centreline: a lemniscate stood upright, with a little depth in z. */
function curveP(t: number): V3 {
  const s1 = Math.sin(t);
  const s2 = Math.sin(2 * t);
  const c1 = Math.cos(t);
  return [s2 * 0.4, -s1 * 0.95, c1 * 0.3];
}

/**
 * Ribbon stations: centreline ± half-width along a frame that twists by π over
 * the loop — a true Möbius half-twist, which is why the band reads as one
 * surface rather than two edges. Shape-only, so it is computed once for the
 * life of the module and shared by every mounted mark.
 */
const stationCache = new Map<number, { A: V3; B: V3 }[]>();
function stations(n: number) {
  const hit = stationCache.get(n);
  if (hit) return hit;
  const w = 0.155;
  const dt = 0.001;
  const out: { A: V3; B: V3 }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * TAU;
    const P = curveP(t);
    const Tg = vnorm(vsub(curveP(t + dt), curveP(t - dt)));
    const N1 = vnorm(vcross(Tg, [0, 0, 1]));
    const N2 = vcross(Tg, N1);
    const ph = t / 2 + Math.PI / 2;
    const D: V3 = [
      N1[0] * Math.cos(ph) + N2[0] * Math.sin(ph),
      N1[1] * Math.cos(ph) + N2[1] * Math.sin(ph),
      N1[2] * Math.cos(ph) + N2[2] * Math.sin(ph),
    ];
    out.push({
      A: [P[0] + D[0] * w, P[1] + D[1] * w, P[2] + D[2] * w],
      B: [P[0] - D[0] * w, P[1] - D[1] * w, P[2] - D[2] * w],
    });
  }
  stationCache.set(n, out);
  return out;
}

/**
 * The design source hardcoded its brass. This package bans inline hex in
 * components (`hex-ban.test.ts` — §14 is a package law), and obeying it turns
 * out to be the better behaviour anyway: `--pn-brand` is not one colour but
 * two, warmer and lighter on the dark ground than on the light one, so a
 * literal would have been wrong in one theme out of two.
 *
 * Only used before the token resolves — the first paint, and any host that
 * mounts the mark outside `.cv2-root`. Kept as channel numbers rather than a
 * string both to satisfy the ban and because it is what `shade` wants.
 */
const FALLBACK_INK: V3 = [178, 106, 43];

/** Accepts what `getPropertyValue` may return: `#rgb`, `#rrggbb`, or `rgb(...)`. */
function parseColor(css: string): V3 | null {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    const wide = h.length === 6;
    const at = (i: number) =>
      wide ? parseInt(h.slice(i * 2, i * 2 + 2), 16) : parseInt(h[i] + h[i], 16);
    return [at(0), at(1), at(2)];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/** Posterized print-style shading. k in 0..1, 0.5 = base ink. */
function shade(b: V3, k: number) {
  let r: number;
  let g: number;
  let bl: number;
  if (k < 0.5) {
    const f = (0.5 - k) * 2 * 0.78;
    r = b[0] * (1 - f);
    g = b[1] * (1 - f);
    bl = b[2] * (1 - f);
  } else {
    const f = (k - 0.5) * 2 * 0.58;
    r = b[0] + (255 - b[0]) * f;
    g = b[1] + (255 - b[1]) * f;
    bl = b[2] + (255 - b[2]) * f;
  }
  return `rgb(${r | 0},${g | 0},${bl | 0})`;
}

/* -- motion ---------------------------------------------------------------
   `animate` and the two easings are lifted exactly from animations-v3.jsx so
   the curve the designer authored is the curve that ships. Summing two
   `animate`s is the source's own idiom for a there-and-back: before the seam
   the second term is still at its `from` of 0, after it the first is pinned
   at its `to`. */

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function animate(from: number, to: number, start: number, end: number, ease: (t: number) => number) {
  return (t: number) => {
    if (t <= start) return from;
    if (t >= end) return to;
    return from + (to - from) * ease((t - start) / (end - start));
  };
}

/**
 * The two scene lists the design shipped. Both are 2s seamless loops that end
 * where they began; they differ in pacing, which is the whole choice. Held as
 * a prop rather than picked here because the call is still open pending the
 * artifact review.
 */
export type RibbonMotion = 'spin-rewind' | 'clock-counter';

const MOTION: Record<RibbonMotion, { mid: number; total: number; ease: (t: number) => number }> = {
  // Spin up / Ease off / Rewind / Settle — accelerates away, then unwinds.
  'spin-rewind': { mid: 1, total: 2, ease: easeInOutCubic },
  // Clockwise / Counter-clockwise — one even-paced turn each way.
  'clock-counter': { mid: 1, total: 2, ease: easeInOutSine },
};

export const RIBBON_LOOP_SECONDS = 2;

/* -- the shared clock -----------------------------------------------------
   ONE rAF for the whole module, not one per mark. Marks that mount together
   therefore also turn together, which is what you want when more than one is
   on screen. The loop only runs while something is subscribed. */

type Sub = (t: number) => void;
const subscribers = new Set<Sub>();
let frame = 0;
let originMs = 0;

function tick(now: number) {
  if (!originMs) originMs = now;
  const t = ((now - originMs) / 1000) % RIBBON_LOOP_SECONDS;
  for (const fn of subscribers) fn(t);
  frame = requestAnimationFrame(tick);
}

function subscribe(fn: Sub) {
  subscribers.add(fn);
  if (!frame) {
    originMs = 0;
    frame = requestAnimationFrame(tick);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/**
 * Reduced motion holds the mark at t=0 — its rest pose, the frame the loop
 * both starts and ends on. jsdom ships no `matchMedia`, so this is guarded
 * rather than assumed; without the guard every test that renders a boot state
 * would throw.
 */
function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Resolves the base ink from the mark's own element, so it picks up whichever
 * theme it was mounted under. Read once after mount rather than per frame:
 * `getComputedStyle` forces a style flush, and this component renders 60+
 * times a second.
 *
 * `--pn-ribbon-ink` FIRST, then `--pn-brand`. The override exists because
 * brand is not always the right ink: the chat composer mounts the mark inside
 * a button that is ITSELF filled with brand, where a brand mark is invisible.
 * A host that needs a different ink sets the variable in its own stylesheet
 * and stays inside the token system — which `ink` cannot do, since it takes a
 * parsed colour and `var(--pn-card)` is not one.
 *
 * PICK A MID-TONE. `shade` walks DOWN toward black and UP toward white from
 * whatever it is given, so an ink at either extreme spends half its ramp
 * against a ceiling and the band goes flat over that half. Brass is a good
 * base because it sits in the middle. Pure white is the worst case and it is
 * also the obvious-looking choice on a filled button — see the note over
 * `.tch-send__mark` in chat-home.css for what that cost, measured.
 */
const INK_TOKENS = ['--pn-ribbon-ink', '--pn-brand'];

function useInk(explicit: string | undefined, el: SVGSVGElement | null): V3 {
  const [resolved, setResolved] = useState<V3 | null>(null);
  useEffect(() => {
    if (explicit) {
      setResolved(parseColor(explicit));
      return;
    }
    if (!el || typeof getComputedStyle !== 'function') return;
    const style = getComputedStyle(el);
    for (const name of INK_TOKENS) {
      const parsed = parseColor(style.getPropertyValue(name) ?? '');
      if (parsed) {
        setResolved(parsed);
        return;
      }
    }
  }, [explicit, el]);
  return resolved ?? FALLBACK_INK;
}

function useLoopTime(animated: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!animated) return;
    if (prefersReducedMotion()) return;
    if (typeof requestAnimationFrame !== 'function') return;
    return subscribe(setT);
  }, [animated]);
  return animated ? t : 0;
}

/* -- the mark -------------------------------------------------------------- */

/**
 * Design-space boxes, both taken from the source's `Piece`. The two layouts are
 * not the same drawing at two sizes: the wordmark's ribbon sits at a smaller
 * scale in a tighter box and at a shallower tilt, because next to the letters
 * it has to read as a glyph on a baseline rather than as a standalone mark.
 *
 * The geometry never changes — CSS only ever scales the finished viewBox.
 */
const LAYOUT = {
  mark: { S: 290, W: 560, H: 700, tilt: 9 },
  wordmark: { S: 208, W: 360, H: 520, tilt: 8 },
} as const;

export type RibbonLayout = keyof typeof LAYOUT;

export function RibbonMark({
  motion = 'spin-rewind',
  layout = 'mark',
  animated = true,
  ink,
  segments = N_SEG,
  className,
}: {
  /** Which authored scene list drives the rotation. */
  motion?: RibbonMotion;
  /** `mark` for the standalone glyph, `wordmark` for the 8 in "tm8". */
  layout?: RibbonLayout;
  /**
   * Turning costs a frame's work forever, so it is opt-out. A transient wait
   * state (boot, a working indicator) should turn; a brand mark that sits in
   * the header for the whole session should not — it would burn a rAF for as
   * long as the app is open and ask the eye to track something that never
   * resolves. Still marks hold t=0, the pose the loop starts and ends on.
   */
  animated?: boolean;
  /**
   * Override the base ink. Defaults to `--pn-ribbon-ink`, then `--pn-brand`,
   * for the mounted theme. Takes a parsed colour, so a host wanting a token
   * should set `--pn-ribbon-ink` in CSS rather than pass `var(...)` here.
   */
  ink?: string;
  /**
   * How many quads the band is built from. 150 is what the design authored and
   * what any mark large enough to show them should keep. Small mounts pass
   * fewer — see `N_SEG` for why that is a budget rather than a downgrade.
   */
  segments?: number;
  className?: string;
}) {
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const baseInk = useInk(ink, el);
  const T = useLoopTime(animated);
  const { mid, total, ease } = MOTION[motion];
  const { S, W, H, tilt: tiltBase } = LAYOUT[layout];
  // A non-integer or <3 count would produce a degenerate band (and NaN out of
  // the tangent at a zero-length step), so it is clamped rather than trusted.
  const nSeg = Math.max(3, Math.round(segments));

  const angle = animate(0, 360, 0, mid, ease)(T) + animate(0, -360, mid, total, ease)(T);
  const flowPhase = ((T / total) * 2) % 1;
  const breathe = 1 + 0.012 * Math.sin((TAU * T) / total);
  const tilt = tiltBase + 2.5 * Math.sin((TAU * T) / total);

  const st = stations(nSeg);
  const cA = Math.cos((angle * Math.PI) / 180);
  const sA = Math.sin((angle * Math.PI) / 180);
  const cB = Math.cos((tilt * Math.PI) / 180);
  const sB = Math.sin((tilt * Math.PI) / 180);
  const F = 2600;
  const cx = W / 2;
  const cy = H / 2;
  const L = vnorm([-0.35, -0.5, 0.85]);

  const tx = (p: V3): V3 => {
    const x = p[0] * S;
    const y = p[1] * S;
    const z = p[2] * S;
    const x1 = x * cA + z * sA;
    const z1 = -x * sA + z * cA;
    return [x1, y * cB - z1 * sB, y * sB + z1 * cB];
  };
  const proj = (p: V3) => {
    const f = F / (F - p[2]);
    return [cx + p[0] * f, cy + p[1] * f];
  };

  const quads: { z: number; i: number; fill: string; pts: string }[] = [];
  let pA = tx(st[0].A);
  let pB = tx(st[0].B);
  for (let i = 0; i < nSeg; i++) {
    const A2 = tx(st[i + 1].A);
    const B2 = tx(st[i + 1].B);
    const u = (i + 0.5) / nSeg;
    const n = vnorm(vcross(vsub(A2, pA), vsub(pB, pA)));
    let k = 0.24 + 0.76 * Math.abs(vdot(n, L));
    k += 0.13 * Math.sin(TAU * (u * 2 - flowPhase));
    k = Math.max(0, Math.min(1, k));
    const a = proj(pA);
    const b = proj(A2);
    const c = proj(B2);
    const d = proj(pB);
    quads.push({
      z: (pA[2] + A2[2] + B2[2] + pB[2]) / 4,
      i,
      fill: shade(baseInk, k),
      pts: `${a[0].toFixed(1)},${a[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)} ${d[0].toFixed(1)},${d[1].toFixed(1)}`,
    });
    pA = A2;
    pB = B2;
  }
  // Painter's algorithm: far quads first, so the near half of the band covers
  // the far half where the loop crosses itself.
  quads.sort((a, b) => a.z - b.z);

  return (
    <svg
      ref={setEl}
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', overflow: 'visible', transform: `scale(${breathe.toFixed(4)})` }}
      data-testid="ribbon-mark"
    >
      {quads.map((q) => (
        // The stroke is the same colour as the fill: it closes the hairline
        // seams between adjacent quads, it is not an outline.
        <polygon
          key={q.i}
          points={q.pts}
          fill={q.fill}
          stroke={q.fill}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
