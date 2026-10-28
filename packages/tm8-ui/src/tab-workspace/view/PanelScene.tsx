/**
 * THE PANEL'S SCENE, DRAWN (task 01a18396). Each painted scene is a few soft
 * layers of vector silhouette — sky, a sun or moon, ridges, trees, dunes, water — on one
 * 480×120 canvas, cropped to the panel's width from the centre and faded into
 * the panel's surface at the foot. No image files: the art is generated from
 * fixed seeds, so it is identical on every load and costs no request.
 *
 * COLOURS ARE CSS VARIABLES (`--sc-*`, `panel-scene.css`), so one drawing has
 * a day palette and a night one and follows the theme without re-rendering.
 *
 * COMPOSITION. The free gap in the title row — between "Space: <name>" and
 * the icons — sits near x≈258 at every panel width, so that is where each
 * scene puts its sun, moon or planet. Peaks and treetops rise around it, and
 * the near layers lie behind the new-item tile.
 */
import { useId, useMemo, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { PANEL_SCENE_CATALOG, type PaintedSceneId, type PanelScene } from './panelSceneStore';

const W = 480;
const H = 120;
/** The title row's free gap: the sun, moon or planet sits here. */
const FOCAL_X = 258;

const paint = (name: string): CSSProperties => ({ fill: `var(--sc-${name})` });
const stop = (name: string, opacity?: number): CSSProperties => ({
  stopColor: `var(--sc-${name})`,
  ...(opacity !== undefined ? { stopOpacity: opacity } : {}),
});

/** A small seeded PRNG (mulberry32): the same seed draws the same scene. */
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A peak or a dip on a ridge: `height` up (negative = down) at `x`, `width` wide. */
type Bump = readonly [x: number, height: number, width: number];

/**
 * A mountain ridge: midpoint displacement for the rock, plus gaussian bumps
 * for the peaks the composition wants where it wants them.
 */
function ridgePath(seed: number, base: number, roughness: number, bumps: readonly Bump[]): string {
  const rand = seeded(seed);
  const n = 64;
  const h = new Array<number>(n + 1).fill(0);
  h[0] = (rand() - 0.5) * roughness;
  h[n] = (rand() - 0.5) * roughness;
  for (let step = n, amp = roughness; step > 1; step /= 2, amp *= 0.55) {
    for (let i = step / 2; i < n; i += step) {
      h[i] = (h[i - step / 2]! + h[i + step / 2]!) / 2 + (rand() - 0.5) * amp;
    }
  }
  const points = h.map((dy, i) => {
    const x = (i / n) * W;
    const lift = bumps.reduce((sum, [bx, bh, bw]) => sum + bh * Math.exp(-(((x - bx) / bw) ** 2)), 0);
    return `${r1(x)} ${r1(base + dy - lift)}`;
  });
  return `M0 ${H}L${points.join('L')}L${W} ${H}Z`;
}

/** A soft line through `points` (Catmull-Rom as cubic Béziers), closed to the foot. */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  let d = `M0 ${H}L${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r1(c1[0]!)} ${r1(c1[1]!)} ${r1(c2[0]!)} ${r1(c2[1]!)} ${p2[0]} ${p2[1]}`;
  }
  return `${d}L${W} ${H}Z`;
}

/** A row of two-tier pines standing on `base`, kept low near the focal gap. */
function treelinePath(seed: number, base: number, minH: number, maxH: number, gap: number): string {
  const rand = seeded(seed);
  let d = `M0 ${H}L0 ${base}`;
  for (let x = -4 + rand() * 4; x < W + 6; x += gap * (0.7 + rand() * 0.6)) {
    const calm = 1 - 0.45 * Math.exp(-(((x - FOCAL_X) / 46) ** 2));
    const h = (minH + rand() * (maxH - minH)) * calm;
    const w = h * 0.3;
    const b = base + rand() * 2;
    d +=
      `L${r1(x - w)} ${r1(b)}L${r1(x - 0.3 * w)} ${r1(b - 0.5 * h)}L${r1(x - 0.7 * w)} ${r1(b - 0.5 * h)}` +
      `L${r1(x)} ${r1(b - h)}L${r1(x + 0.7 * w)} ${r1(b - 0.5 * h)}L${r1(x + 0.3 * w)} ${r1(b - 0.5 * h)}L${r1(x + w)} ${r1(b)}`;
  }
  return `${d}L${W} ${base}L${W} ${H}Z`;
}

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  twinkle: number | null;
}

function starfield(seed: number, count: number, maxY: number): Star[] {
  const rand = seeded(seed);
  return Array.from({ length: count }, (_, i) => ({
    x: r1(rand() * W),
    y: r1(rand() ** 1.4 * maxY),
    r: r1(0.35 + rand() ** 3 * 0.8),
    o: r1(0.35 + rand() * 0.6),
    twinkle: i % 9 === 0 ? r1(rand() * 6) : null,
  }));
}

function Stars({ seed, count, maxY, layer = true }: { seed: number; count: number; maxY: number; layer?: boolean }) {
  const stars = useMemo(() => starfield(seed, count, maxY), [seed, count, maxY]);
  return (
    <g className={layer ? 'tws-scene__stars' : undefined} style={paint('star')}>
      {stars.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={s.y}
          r={s.r}
          opacity={s.o}
          className={s.twinkle !== null ? 'tws-scene__twinkle' : undefined}
          style={s.twinkle !== null ? { animationDelay: `${s.twinkle}s` } : undefined}
        />
      ))}
    </g>
  );
}

/** Sky, then a halo and a disc at the focal point: the sun by day, the moon by night. */
function SkyAndLight({ id, cy, r, haloR = 46 }: { id: string; cy: number; r: number; haloR?: number }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="1" style={stop('sky-low')} />
        </linearGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" style={stop('halo', 0.9)} />
          <stop offset="1" style={stop('halo', 0)} />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <circle cx={FOCAL_X} cy={cy} r={haloR} fill={`url(#${id}-halo)`} />
      <circle cx={FOCAL_X} cy={cy} r={r} style={paint('light')} />
    </>
  );
}

function Mountains({ id }: { id: string }) {
  const layers = useMemo(
    () => [
      ridgePath(11, 58, 9, [[FOCAL_X - 70, 26, 38], [FOCAL_X + 74, 22, 44], [FOCAL_X, -6, 22], [40, 8, 50]]),
      ridgePath(23, 68, 10, [[FOCAL_X - 130, 20, 48], [FOCAL_X + 130, 24, 50], [FOCAL_X - 10, 6, 30]]),
      ridgePath(37, 82, 9, [[FOCAL_X + 30, 12, 60], [70, 10, 60]]),
      ridgePath(41, 98, 7, [[FOCAL_X - 90, 8, 70], [420, 10, 60]]),
    ],
    [],
  );
  return (
    <>
      <SkyAndLight id={id} cy={52} r={8} />
      <Stars seed={5} count={50} maxY={60} />
      {layers.map((d, i) => (
        <path key={i} d={d} style={paint(`l${i + 1}`)} />
      ))}
    </>
  );
}

function Forest({ id }: { id: string }) {
  const layers = useMemo(
    () => [
      treelinePath(3, 60, 10, 20, 7),
      treelinePath(8, 72, 12, 22, 8),
      treelinePath(14, 86, 14, 26, 9),
      treelinePath(19, 104, 16, 30, 11),
    ],
    [],
  );
  return (
    <>
      <SkyAndLight id={id} cy={44} r={7} haloR={56} />
      <Stars seed={9} count={40} maxY={50} />
      <defs>
        <linearGradient id={`${id}-mist`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('mist', 0)} />
          <stop offset="1" style={stop('mist', 0.8)} />
        </linearGradient>
      </defs>
      {layers.map((d, i) => (
        <g key={i}>
          <path d={d} style={paint(`l${i + 1}`)} />
          {i < layers.length - 1 ? <rect y={52 + i * 13} width={W} height={16} fill={`url(#${id}-mist)`} /> : null}
        </g>
      ))}
    </>
  );
}

function Ocean({ id }: { id: string }) {
  const horizon = 56;
  const glints = useMemo(() => {
    const rand = seeded(17);
    return Array.from({ length: 16 }, (_, i) => {
      const y = horizon + 3 + i * 3.4 + rand() * 1.5;
      const w = 4 + (i + 2) * 2.2 * (0.6 + rand() * 0.6);
      return { x: r1(FOCAL_X - w / 2 + (rand() - 0.5) * 6), y: r1(y), w: r1(w), o: r1(0.85 - i * 0.04) };
    });
  }, []);
  const swell = useMemo(() => {
    const rand = seeded(29);
    return Array.from({ length: 9 }, (_, i) => {
      const y = horizon + 8 + i * 6;
      const x = rand() * W;
      return { x: r1(x), y, w: r1(24 + rand() * 50) };
    });
  }, []);
  return (
    <>
      <SkyAndLight id={id} cy={horizon - 1} r={10} haloR={60} />
      <Stars seed={13} count={45} maxY={horizon - 4} />
      <defs>
        <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('l1')} />
          <stop offset="1" style={stop('l2')} />
        </linearGradient>
      </defs>
      <path d={smoothPath([[0, horizon - 7], [36, horizon - 11], [70, horizon - 6], [104, horizon - 2], [140, horizon]])} style={paint('l3')} />
      <path d={smoothPath([[352, horizon], [388, horizon - 4], [420, horizon - 9], [452, horizon - 6], [480, horizon - 8]])} style={paint('l3')} />
      <rect y={horizon} width={W} height={H - horizon} fill={`url(#${id}-sea)`} />
      <g style={paint('glint')}>
        {glints.map((g, i) => (
          <rect key={i} x={g.x} y={g.y} width={g.w} height={0.9} rx={0.45} opacity={g.o} />
        ))}
      </g>
      <g style={paint('swell')}>
        {swell.map((s, i) => (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={0.8} rx={0.4} opacity={0.5} />
        ))}
      </g>
    </>
  );
}

function Aurora({ id }: { id: string }) {
  const ridges = useMemo(
    () => [
      ridgePath(51, 70, 10, [[FOCAL_X - 100, 18, 50], [FOCAL_X + 90, 20, 56], [FOCAL_X, -4, 30]]),
      ridgePath(57, 88, 8, [[FOCAL_X + 160, 14, 60], [FOCAL_X - 170, 12, 60]]),
    ],
    [],
  );
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="1" style={stop('sky-low')} />
        </linearGradient>
        <linearGradient id={`${id}-veil`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('veil-b', 0)} />
          <stop offset="0.45" style={stop('veil-b', 0.55)} />
          <stop offset="1" style={stop('veil-a', 0)} />
        </linearGradient>
        <linearGradient id={`${id}-veil2`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('veil-a', 0)} />
          <stop offset="0.6" style={stop('veil-a', 0.7)} />
          <stop offset="1" style={stop('veil-a', 0)} />
        </linearGradient>
        <filter id={`${id}-soft`} x="-10%" y="-50%" width="120%" height="200%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <Stars seed={21} count={80} maxY={80} layer={false} />
      <g filter={`url(#${id}-soft)`} className="tws-scene__veil">
        <path
          d="M-10 30C60 8 120 42 190 22S320 4 380 26S460 30 490 14L490 60C440 70 380 52 320 58S200 70 130 54S30 62 -10 66Z"
          fill={`url(#${id}-veil2)`}
        />
        <path d="M60 18C130 2 200 30 260 12S380 0 440 18L440 44C380 30 320 50 260 36S130 30 60 44Z" fill={`url(#${id}-veil)`} />
      </g>
      {ridges.map((d, i) => (
        <path key={i} d={d} style={paint(`l${i + 1}`)} />
      ))}
    </>
  );
}

function Space({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="1" style={stop('sky-low')} />
        </linearGradient>
        <radialGradient id={`${id}-neb-a`}>
          <stop offset="0" style={stop('neb-a', 0.55)} />
          <stop offset="1" style={stop('neb-a', 0)} />
        </radialGradient>
        <radialGradient id={`${id}-neb-b`}>
          <stop offset="0" style={stop('neb-b', 0.45)} />
          <stop offset="1" style={stop('neb-b', 0)} />
        </radialGradient>
        <radialGradient id={`${id}-planet`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" style={stop('planet-lit')} />
          <stop offset="1" style={stop('planet-dark')} />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <ellipse cx={FOCAL_X - 70} cy={30} rx={130} ry={34} fill={`url(#${id}-neb-a)`} />
      <ellipse cx={FOCAL_X + 90} cy={70} rx={120} ry={40} fill={`url(#${id}-neb-b)`} />
      <Stars seed={42} count={110} maxY={H} layer={false} />
      <g transform={`rotate(-16 ${FOCAL_X} 40)`}>
        <ellipse cx={FOCAL_X} cy={40} rx={21} ry={4.6} fill="none" style={{ stroke: 'var(--sc-ring)' }} strokeWidth={1.1} />
        <circle cx={FOCAL_X} cy={40} r={10.5} fill={`url(#${id}-planet)`} />
        <path d={`M${FOCAL_X - 21} 40A21 4.6 0 0 0 ${FOCAL_X + 21} 40`} fill="none" style={{ stroke: 'var(--sc-ring)' }} strokeWidth={1.1} />
      </g>
    </>
  );
}

function Dunes({ id }: { id: string }) {
  return (
    <>
      <SkyAndLight id={id} cy={50} r={11} haloR={54} />
      <Stars seed={33} count={45} maxY={56} />
      <path d={smoothPath([[0, 64], [80, 58], [170, 64], [FOCAL_X, 60], [340, 54], [420, 60], [480, 56]])} style={paint('l1')} />
      <path d={smoothPath([[0, 74], [60, 70], [150, 78], [230, 70], [320, 76], [400, 66], [480, 72]])} style={paint('l2')} />
      <path d={smoothPath([[0, 90], [100, 82], [200, 92], [300, 84], [390, 92], [480, 86]])} style={paint('l3')} />
      <path d={smoothPath([[0, 104], [120, 98], [240, 106], [360, 98], [480, 104]])} style={paint('l4')} />
    </>
  );
}

/* ---- Snow and the festive scenes (Subhang 2026-10-28: "snow themes, one
   for Christmas, one for Halloween… Diwali") ---------------------------------- */

interface Flake {
  x: number;
  y: number;
  r: number;
  dur: number;
  delay: number;
}

/**
 * Falling snow. Each flake is drawn where it rests under reduced motion, and
 * otherwise falls from above the band to below it on its own clock.
 */
function Snowfall({ seed, count }: { seed: number; count: number }) {
  const flakes = useMemo<Flake[]>(() => {
    const rand = seeded(seed);
    return Array.from({ length: count }, () => ({
      x: r1(rand() * W),
      y: r1(rand() * H),
      r: r1(0.5 + rand() ** 2 * 1.2),
      dur: r1(7 + rand() * 7),
      delay: r1(-rand() * 14),
    }));
  }, [seed, count]);
  return (
    <g style={paint('flake')}>
      {flakes.map((f, i) => (
        <circle
          key={i}
          className="tws-scene__flake"
          cx={f.x}
          cy={f.y}
          r={f.r}
          opacity={0.55 + f.r * 0.25}
          style={
            {
              '--fall-from': `${r1(-f.y - 6)}px`,
              '--fall-to': `${r1(H + 6 - f.y)}px`,
              animationDuration: `${f.dur}s`,
              animationDelay: `${f.delay}s`,
            } as CSSProperties
          }
        />
      ))}
    </g>
  );
}

function Snow({ id }: { id: string }) {
  const trees = useMemo(() => treelinePath(61, 70, 10, 22, 8), []);
  return (
    <>
      <SkyAndLight id={id} cy={42} r={7} haloR={50} />
      <Stars seed={63} count={40} maxY={56} />
      <path d={smoothPath([[0, 60], [90, 52], [190, 60], [FOCAL_X, 57], [350, 50], [430, 58], [480, 54]])} style={paint('l1')} />
      <path d={trees} style={paint('l2')} />
      <path d={smoothPath([[0, 78], [110, 70], [220, 78], [330, 68], [480, 76]])} style={paint('l3')} />
      <path d={smoothPath([[0, 98], [140, 90], [280, 98], [400, 90], [480, 96]])} style={paint('l4')} />
      <Snowfall seed={67} count={70} />
    </>
  );
}

/** A big three-tier pine: [path, tiers] so the lights can follow its edges. */
function bigPine(x: number, base: number, h: number) {
  const tiers = [
    { top: base - h, bottom: base - h * 0.58, hw: h * 0.17 },
    { top: base - h * 0.8, bottom: base - h * 0.28, hw: h * 0.26 },
    { top: base - h * 0.55, bottom: base, hw: h * 0.36 },
  ];
  const d = tiers
    .map((t) => `M${r1(x - t.hw)} ${r1(t.bottom)}L${x} ${r1(t.top)}L${r1(x + t.hw)} ${r1(t.bottom)}Z`)
    .join('');
  const halfWidthAt = (y: number) =>
    Math.max(0, ...tiers.filter((t) => y >= t.top && y <= t.bottom).map((t) => (t.hw * (y - t.top)) / (t.bottom - t.top)));
  return { d, halfWidthAt };
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outer : inner;
    return `${r1(cx + r * Math.cos(a))} ${r1(cy + r * Math.sin(a))}`;
  });
  return `M${pts.join('L')}Z`;
}

function Christmas({ id }: { id: string }) {
  const base = 80;
  const h = 54;
  const tree = useMemo(() => bigPine(FOCAL_X, base, h), []);
  const lights = useMemo(() => {
    const out: { x: number; y: number; c: string; delay: number }[] = [];
    const colours = ['bulb-a', 'bulb-b', 'bulb-c', 'bulb-d'];
    const rand = seeded(71);
    [0.82, 0.7, 0.58, 0.46, 0.34, 0.22, 0.1].forEach((f, row) => {
      const y = base - h * f;
      const hw = tree.halfWidthAt(y) * 0.82;
      const n = Math.max(1, Math.round((hw * 2) / 5));
      for (let i = 0; i < n; i++) {
        const x = FOCAL_X - hw + (n === 1 ? hw : (i * 2 * hw) / (n - 1));
        out.push({ x: r1(x), y: r1(y + (i % 2) * 1.2), c: colours[(i + row) % colours.length]!, delay: r1(rand() * 5) });
      }
    });
    return out;
  }, [tree]);
  const pines = useMemo(() => treelinePath(73, 74, 12, 26, 10), []);
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="1" style={stop('sky-low')} />
        </linearGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" style={stop('halo', 0.85)} />
          <stop offset="1" style={stop('halo', 0)} />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <Stars seed={75} count={70} maxY={70} layer={false} />
      <path d={pines} style={paint('l1')} />
      <circle cx={FOCAL_X} cy={base - h - 2} r={20} fill={`url(#${id}-halo)`} />
      <path d={tree.d} style={paint('tree')} />
      <g>
        {lights.map((l, i) => (
          <circle
            key={i}
            cx={l.x}
            cy={l.y}
            r={0.95}
            className="tws-scene__twinkle"
            style={{ fill: `var(--sc-${l.c})`, animationDelay: `${l.delay}s` }}
          />
        ))}
      </g>
      <path d={starPath(FOCAL_X, base - h - 2, 4.4, 1.8)} style={paint('star-gold')} />
      <path d={smoothPath([[0, 82], [120, 74], [FOCAL_X, 79], [380, 72], [480, 80]])} style={paint('l3')} />
      <path d={smoothPath([[0, 100], [160, 93], [300, 100], [480, 94]])} style={paint('l4')} />
      <Snowfall seed={77} count={60} />
    </>
  );
}

/** A bat on a 12-unit span, centred on its body. */
const BAT =
  'M-6 0Q-4.5-3-2.2-1.2L-1-2.4L0-1.4L1-2.4L2.2-1.2Q4.5-3 6 0Q4.4-1 3.3 0.9Q1.6-0.3 0 1.8Q-1.6-0.3-3.3 0.9Q-4.4-1-6 0Z';

function Pumpkin({ x, y, s = 1, glow }: { x: number; y: number; s?: number; glow: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <circle r={10} fill={`url(#${glow})`} />
      <ellipse rx={4.8} ry={3.7} style={paint('pumpkin')} />
      <path d="M-1.6-3.5Q-0.8-1-1.6 3.5M1.6-3.5Q0.8-1 1.6 3.5" fill="none" style={{ stroke: 'var(--sc-pumpkin-rib)' }} strokeWidth={0.5} />
      <path d="M0-3.6L0.4-5.4L1.2-5.1" fill="none" style={{ stroke: 'var(--sc-stem)' }} strokeWidth={0.8} strokeLinecap="round" />
      <path d="M-2.6-1L-1.6-1.9L-0.9-0.8ZM2.6-1L1.6-1.9L0.9-0.8ZM-2.4 0.9Q0 2.6 2.4 0.9Q0 1.7-2.4 0.9Z" style={paint('glow')} />
    </g>
  );
}

function Halloween({ id }: { id: string }) {
  const hills = useMemo(
    () => [
      ridgePath(81, 64, 5, [[FOCAL_X + 60, 8, 40], [FOCAL_X - 60, 6, 36], [60, 10, 60]]),
      ridgePath(83, 84, 4, [[400, 10, 60], [120, 8, 70]]),
    ],
    [],
  );
  const bats = [
    { x: FOCAL_X - 30, y: 18, s: 0.9, d: 0 },
    { x: FOCAL_X + 26, y: 12, s: 0.7, d: 0.8 },
    { x: FOCAL_X + 6, y: 26, s: 0.55, d: 1.6 },
    { x: FOCAL_X - 120, y: 10, s: 0.5, d: 0.4 },
    { x: FOCAL_X + 130, y: 16, s: 0.6, d: 1.2 },
  ];
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="0.75" style={stop('sky-low')} />
        </linearGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" style={stop('halo', 0.7)} />
          <stop offset="1" style={stop('halo', 0)} />
        </radialGradient>
        <radialGradient id={`${id}-lantern`}>
          <stop offset="0" style={stop('glow', 0.5)} />
          <stop offset="1" style={stop('glow', 0)} />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <Stars seed={85} count={40} maxY={50} layer={false} />
      <circle cx={FOCAL_X} cy={36} r={40} fill={`url(#${id}-halo)`} />
      <circle cx={FOCAL_X} cy={36} r={14} style={paint('light')} />
      <circle cx={FOCAL_X - 4} cy={32} r={2.4} style={{ fill: 'var(--sc-crater)' }} />
      <circle cx={FOCAL_X + 5} cy={40} r={1.6} style={{ fill: 'var(--sc-crater)' }} />
      <g style={paint('ink')}>
        {bats.map((b, i) => (
          <g key={i} transform={`translate(${b.x} ${b.y}) scale(${b.s})`}>
            <path d={BAT} className="tws-scene__bat" style={{ animationDelay: `${b.d}s` }} />
          </g>
        ))}
      </g>
      <path d={hills[0]!} style={paint('l1')} />
      {/* A bare tree on the right hill. */}
      <g fill="none" style={{ stroke: 'var(--sc-ink)' }} strokeLinecap="round">
        <path d="M392 64L390 44" strokeWidth={2.2} />
        <path d="M390 50L380 40L374 41M384 44L382 35M390 46L400 36L408 35M398 38L399 30M391 44L392 34" strokeWidth={1} />
      </g>
      <Pumpkin x={FOCAL_X - 52} y={57} s={0.9} glow={`${id}-lantern`} />
      <Pumpkin x={FOCAL_X + 44} y={55} glow={`${id}-lantern`} />
      <Pumpkin x={FOCAL_X + 56} y={58} s={0.7} glow={`${id}-lantern`} />
      <path d={hills[1]!} style={paint('l2')} />
    </>
  );
}

function Burst({ cx, cy, r, colour, rays, delay }: { cx: number; cy: number; r: number; colour: string; rays: number; delay: number }) {
  const lines = Array.from({ length: rays }, (_, i) => {
    const a = (i * 2 * Math.PI) / rays + (i % 2) * 0.12;
    const len = i % 2 ? r * 0.82 : r;
    return {
      x1: r1(cx + Math.cos(a) * r * 0.28),
      y1: r1(cy + Math.sin(a) * r * 0.28),
      x2: r1(cx + Math.cos(a) * len),
      y2: r1(cy + Math.sin(a) * len),
    };
  });
  return (
    <g className="tws-scene__burst" style={{ animationDelay: `${delay}s`, stroke: `var(--sc-${colour})`, fill: `var(--sc-${colour})` }}>
      {lines.map((l, i) => (
        <g key={i}>
          <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={0.7} strokeLinecap="round" opacity={0.85} />
          <circle cx={l.x2} cy={l.y2} r={0.8} stroke="none" />
        </g>
      ))}
    </g>
  );
}

function Diya({ x, y, delay, glow }: { x: number; y: number; delay: number; glow: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cy={-3} r={8} fill={`url(#${glow})`} />
      <path d="M-4.2 0Q-3.6 3 0 3.2Q3.6 3 4.2 0Z" style={paint('clay')} />
      <path d="M-4.2 0L4.2 0" style={{ stroke: 'var(--sc-clay-rim)' }} strokeWidth={0.7} />
      <path d="M0-5.4Q1.5-2.6 0.2-0.4Q-1.4-2.4 0-5.4Z" className="tws-scene__flame" style={{ ...paint('flame'), animationDelay: `${delay}s` }} />
    </g>
  );
}

function Diwali({ id }: { id: string }) {
  const garland = useMemo(() => {
    const swag = 160;
    const yAt = (x: number) => 1 + 7 * Math.sin((Math.PI * (((x % swag) + swag) % swag)) / swag);
    const pts = Array.from({ length: 97 }, (_, i) => {
      const x = -4 + i * 5;
      return `${r1(x)} ${r1(yAt(x))}`;
    });
    const bulbs = Array.from({ length: 41 }, (_, i) => {
      const x = 2 + i * 12;
      return { x, y: r1(yAt(x) + 1.6), c: ['bulb-a', 'bulb-b', 'bulb-c'][i % 3]!, d: r1((i * 0.37) % 4) };
    });
    return { d: `M${pts.join('L')}`, bulbs };
  }, []);
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop('sky-top')} />
          <stop offset="1" style={stop('sky-low')} />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" style={stop('flame', 0.45)} />
          <stop offset="1" style={stop('flame', 0)} />
        </radialGradient>
        <radialGradient id={`${id}-diya`}>
          <stop offset="0" style={stop('flame', 0.55)} />
          <stop offset="1" style={stop('flame', 0)} />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <Stars seed={91} count={45} maxY={60} layer={false} />
      <ellipse cx={FOCAL_X} cy={70} rx={140} ry={26} fill={`url(#${id}-glow)`} />
      {/* The big one in the title row's gap; small ones above the title and
          the icons; more out at the edges for a wide panel. */}
      <Burst cx={FOCAL_X} cy={31} r={16} colour="fw-a" rays={16} delay={0} />
      <Burst cx={FOCAL_X - 52} cy={14} r={7} colour="fw-b" rays={10} delay={1.6} />
      <Burst cx={FOCAL_X + 62} cy={13} r={7} colour="fw-c" rays={10} delay={3.1} />
      <Burst cx={FOCAL_X - 200} cy={28} r={12} colour="fw-c" rays={12} delay={2.3} />
      <Burst cx={FOCAL_X + 180} cy={24} r={11} colour="fw-b" rays={12} delay={0.9} />
      <path d={garland.d} fill="none" style={{ stroke: 'var(--sc-string)' }} strokeWidth={0.5} />
      {garland.bulbs.map((b, i) => (
        <circle
          key={i}
          cx={b.x}
          cy={b.y}
          r={1.3}
          className="tws-scene__twinkle"
          style={{ fill: `var(--sc-${b.c})`, animationDelay: `${b.d}s` }}
        />
      ))}
      <path d={smoothPath([[0, 70], [120, 66], [FOCAL_X, 70], [380, 64], [480, 68]])} style={paint('l1')} />
      {[-66, -44, -22, 0, 22, 44, 66].map((dx, i) => (
        <Diya key={dx} x={FOCAL_X + dx} y={58 + Math.abs(dx) * 0.04} delay={(i * 0.31) % 1.8} glow={`${id}-diya`} />
      ))}
      <path d={smoothPath([[0, 96], [160, 90], [320, 96], [480, 90]])} style={paint('l2')} />
    </>
  );
}

const SCENE_ART: Readonly<Record<PaintedSceneId, (props: { id: string }) => ReactNode>> = {
  space: Space,
  mountains: Mountains,
  forest: Forest,
  ocean: Ocean,
  aurora: Aurora,
  dunes: Dunes,
  snow: Snow,
  christmas: Christmas,
  halloween: Halloween,
  diwali: Diwali,
};

/** One painted scene as an SVG that fills its box, cropped from the centre. */
export function SceneArt({ art }: { art: PaintedSceneId }) {
  /* useId's punctuation is not valid in `url(#…)`. */
  const id = `sc${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const Art = SCENE_ART[art];
  return (
    <svg
      className="tws-scene"
      data-scene={art}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden
      focusable="false"
    >
      <Art id={id} />
    </svg>
  );
}

/** Any scene filling its box: the drawing, or the photo cropped to its band. */
export function SceneSwatch({ scene }: { scene: PanelScene }) {
  if (scene.art) return <SceneArt art={scene.art} />;
  return (
    <img
      className="tws-scene-photo"
      src={scene.src}
      alt=""
      draggable={false}
      decoding="async"
      style={scene.position ? { objectPosition: scene.position } : undefined}
    />
  );
}

/** The scene behind the panel's top, under its row and tile, faded at the foot. */
export function PanelSceneBackdrop({ scene }: { scene: PanelScene }) {
  return (
    <div className="tws-panelhead__scene" data-testid="tws-panel-scene" data-scene-id={scene.id} data-set={scene.set}>
      <SceneSwatch key={scene.id} scene={scene} />
    </div>
  );
}

/** The picker's ⛰ on the 16×16 grid: a frame, a ridge and a sun. */
export const SCENE_ICON_ART = ['M2.5 3.5h11v9h-11z', 'M2.5 11.25l3.25-3.5 2.5 2.5 1.75-1.75 3.5 3.5', 'M10.5 5.25a1.1 1.1 0 1 1 0 2.2a1.1 1.1 0 1 1 0-2.2'];

const MENU_GROUPS = [
  { set: 'painted', heading: 'Painted' },
  { set: 'festive', heading: 'Festive' },
  { set: 'photo', heading: 'Photos' },
] as const;

/**
 * The scene menu: None, then the painted scenes, the festive ones and the
 * photos, each as a
 * small swatch of itself. Resting on a swatch previews it behind the panel;
 * leaving puts the choice back.
 */
export function SceneMenu({
  value,
  onChoose,
  onPreview,
  menuRef,
}: {
  value: string | null;
  onChoose: (id: string | null) => void;
  onPreview: (id: string | null | undefined) => void;
  menuRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className="tws-scenemenu"
      role="menu"
      aria-label="Panel scene"
      data-testid="tws-scenemenu"
      ref={menuRef}
      onPointerLeave={() => onPreview(undefined)}
    >
      <div className="tws-scenemenu__grid">
        <SceneOption id={null} label="None" checked={value === null} onChoose={onChoose} onPreview={onPreview}>
          <span className="tws-scenemenu__thumb" data-none />
        </SceneOption>
      </div>
      {MENU_GROUPS.map((group) => (
        <div key={group.set} role="group" aria-label={group.heading}>
          <p className="tws-scenemenu__heading">{group.heading}</p>
          <div className="tws-scenemenu__grid">
            {PANEL_SCENE_CATALOG.filter((scene) => scene.set === group.set).map((scene) => (
              <SceneOption
                key={scene.id}
                id={scene.id}
                label={scene.label}
                checked={value === scene.id}
                onChoose={onChoose}
                onPreview={onPreview}
              >
                <span className="tws-scenemenu__thumb">
                  <SceneSwatch scene={scene} />
                </span>
              </SceneOption>
            ))}
          </div>
        </div>
      ))}
      <p className="tws-scenemenu__hint">Click the scene to move to the next one.</p>
    </div>
  );
}

function SceneOption({
  id,
  label,
  checked,
  onChoose,
  onPreview,
  children,
}: {
  id: string | null;
  label: string;
  checked: boolean;
  onChoose: (id: string | null) => void;
  onPreview: (id: string | null | undefined) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="tws-scenemenu__opt"
      data-testid={`tws-scenemenu-${id ?? 'none'}`}
      onPointerEnter={() => onPreview(id)}
      onFocus={() => onPreview(id)}
      onClick={() => onChoose(id)}
    >
      {children}
      <span className="tws-scenemenu__name">{label}</span>
    </button>
  );
}
