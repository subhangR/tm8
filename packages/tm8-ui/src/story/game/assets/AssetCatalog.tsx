/**
 * THE ASSET CATALOG — every canonical type, state and container, rendered by
 * the game's own instanced batch (`SceneryBatch`) from the kit. Dev harness
 * only (asset-catalog-dev.html); never part of the production bundle.
 *
 * Sheets: types · states · containers · plot · kit · overview. `?theme=dark`,
 * `?silhouette=1` (every part in ink: shape alone must tell types apart),
 * `?sockets=1` (attachment points), `?reduced=1`.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { readPalette, type Palette } from '../palette';
import { SceneryBatch } from '../scene-batch';
import { daylightColor, landscapeColors, type Part } from '../scenery';
import { ASSET_SPECS, ENTITY_ASSET_TYPES, type AssetState, type AssetType } from './registry';
import { KIT_BLOCKS, buildAsset, buildBlock, type BuiltAsset } from './prototypes';
import './asset-catalog.css';

export type CatalogSheet = 'types' | 'states' | 'containers' | 'plot' | 'kit' | 'overview';
export const CATALOG_SHEETS: readonly CatalogSheet[] = ['types', 'states', 'containers', 'plot', 'kit', 'overview'];

interface Item { type: AssetType; state?: AssetState; count?: number; progress?: number; caption?: string }
interface Label { x: number; z: number; title: string; sub: string; tag?: string; count?: number; y?: number; badge?: boolean }
interface Layout { parts: Part[]; labels: Label[]; sockets: Array<{ x: number; y: number; z: number; name: string }>; bounds: number; across?: number; depth?: number; zoom: 'gameplay' | 'fit' | 'overview' }

const R = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };   // screen right
const D = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };  // away from the camera (screen up)
const STATE_WORD: Readonly<Record<AssetState, string>> = { planned: 'planned / half-built', working: 'working', waiting: 'waiting', blocked: 'blocked', done: 'done', cancelled: 'cancelled' };
const DECISION_TAG = { owner: 'OWNER', default: 'DEFAULT', proposal: 'PROPOSAL' } as const;

function grid(rows: Item[][], colGap: number, rowGap: number, palette: Palette, flat: string | null): Layout {
  const out: Layout = { parts: [], labels: [], sockets: [], bounds: 0, zoom: 'gameplay' };
  rows.forEach((row, r) => row.forEach((item, c) => {
    const across = (c - (row.length - 1) / 2) * colGap, depth = ((rows.length - 1) / 2 - r) * rowGap;
    const x = R.x * across + D.x * depth, z = R.z * across + D.z * depth;
    const built = buildAsset(item.type, palette, { state: item.state, count: item.count ?? 0, progress: item.progress ?? null, x, z, flat });
    push(out, built, item, x, z);
    out.across = Math.max(out.across ?? 0, Math.abs(across) + colGap / 2); out.depth = Math.max(out.depth ?? 0, Math.abs(depth) + rowGap / 2);
    out.bounds = Math.max(out.bounds, out.across, out.depth);
  }));
  return out;
}
function push(out: Layout, built: BuiltAsset, item: Item, x: number, z: number, labelled = true): void {
  out.parts.push(...built.parts);
  for (const [name, p] of Object.entries(built.sockets)) out.sockets.push({ ...p, name });
  const spec = ASSET_SPECS[item.type];
  if (labelled) out.labels.push({
    x: x - D.x * (built.footprint + .5), z: z - D.z * (built.footprint + .5),
    title: item.caption ?? spec.label,
    sub: spec.states.length > 1 ? STATE_WORD[built.state] : spec.family,
    tag: DECISION_TAG[spec.decision],
  });
  if (item.count && built.sockets.badge) out.labels.push({ ...built.sockets.badge, title: String(item.count), sub: '', badge: true });
}

const STATE_ROWS: Item[][] = [
  ASSET_SPECS['task-workshop'].states.map((state) => ({ type: 'task-workshop', state })),
  [...ASSET_SPECS['session-robot'].states.map((state) => ({ type: 'session-robot' as const, state, caption: `Running session (${state === 'planned' ? 'idle' : state === 'waiting' ? 'attention' : state})` })),
    ...ASSET_SPECS['session-stele'].states.map((state) => ({ type: 'session-stele' as const, state, caption: `Ended session (${state === 'done' ? 'completed' : state === 'blocked' ? 'failed' : 'stopped'})` }))],
  [...ASSET_SPECS['story-keep'].states.map((state) => ({ type: 'story-keep' as const, state, progress: state === 'done' ? 1 : state === 'planned' ? 0 : .45 })),
    { type: 'story-gate', state: 'working' }, { type: 'story-gate', state: 'blocked' }],
  [...ASSET_SPECS['pr-tollgate'].states.map((state) => ({ type: 'pr-tollgate' as const, state, caption: `Pull request (${({ working: 'open', waiting: 'review', blocked: 'changes', done: 'merged', cancelled: 'closed', planned: 'draft' } as const)[state]})` })),
    { type: 'attention-belfry', state: 'waiting' }, { type: 'attention-belfry', state: 'done' }],
  [{ type: 'doc-lectern', state: 'planned', caption: 'Document (draft)' }, { type: 'doc-lectern', state: 'done' }, { type: 'artifact-vitrine', state: 'planned', caption: 'Artifact (empty)' }, { type: 'artifact-vitrine', state: 'done' },
    { type: 'drawing-easel', state: 'planned', caption: 'Drawing (blank)' }, { type: 'drawing-easel', state: 'done' }, { type: 'worktree-branch', state: 'working' }, { type: 'teammate-camp', state: 'working' }],
];

const CONTAINER_ROWS: Item[][] = [
  [{ type: 'story-library', count: 14 }, { type: 'story-code-factory', state: 'working', count: 5 }, { type: 'story-code-factory', state: 'planned', count: 0, caption: 'Story Code Factory (idle)' }],
  [{ type: 'task-library', count: 0, caption: 'Task Library · 0' }, { type: 'task-library', count: 4, caption: 'Task Library · 4' }, { type: 'task-library', count: 27, caption: 'Task Library · 27' },
    { type: 'task-mailbox', count: 0, caption: 'Mailbox · 0' }, { type: 'task-mailbox', count: 3, caption: 'Mailbox · 3' }, { type: 'task-mailbox', count: 41, caption: 'Mailbox · 41' }],
  [{ type: 'task-code-shed', state: 'working' }, { type: 'mailbox-categories', count: 4 }, { type: 'session-stele', state: 'done', count: 5, caption: 'Stele cluster · 5 runs' }, { type: 'commit-milestone' }, { type: 'message-letter' }],
];

/** A task plot composed through sockets: Library left, Mailbox right, robot at its stand, steles behind. */
function taskPlot(out: Layout, palette: Palette, flat: string | null, x: number, z: number, o: { state: AssetState; robot: AssetState | null; library: number; mail: number; steles: number; caption: string }) {
  const task = buildAsset('task-workshop', palette, { state: o.state, x, z, flat });
  push(out, task, { type: 'task-workshop', state: o.state, caption: o.caption }, x, z);
  const s = task.sockets;
  const lib = buildAsset('task-library', palette, { count: o.library, x: s.left!.x, z: s.left!.z, flat });
  push(out, lib, { type: 'task-library', count: o.library }, s.left!.x, s.left!.z, false);
  const mail = buildAsset('task-mailbox', palette, { count: o.mail, x: s.right!.x, z: s.right!.z, flat });
  push(out, mail, { type: 'task-mailbox', count: o.mail }, s.right!.x, s.right!.z, false);
  if (o.robot) out.parts.push(...buildAsset('session-robot', palette, { state: o.robot, x: s.robot!.x, z: s.robot!.z, flat }).parts);
  if (o.steles) {
    const st = buildAsset('session-stele', palette, { state: 'done', count: o.steles, x: s.back!.x, z: s.back!.z - .3, flat });
    push(out, st, { type: 'session-stele', count: o.steles > 3 ? o.steles : 0 }, s.back!.x, s.back!.z, false);
  }
}

function layoutOf(sheet: CatalogSheet, palette: Palette, flat: string | null): Layout {
  switch (sheet) {
    case 'types': {
      const items: Item[] = ENTITY_ASSET_TYPES.map((type) => ({ type, state: ASSET_SPECS[type].states.includes('working') ? 'working' : ASSET_SPECS[type].states.includes('done') ? 'done' : undefined, progress: type === 'story-keep' ? .45 : undefined }));
      const rows: Item[][] = [items.slice(0, 6), items.slice(6, 12), items.slice(12)];
      return { ...grid(rows, 6.6, 9, palette, flat), zoom: 'fit' };
    }
    case 'states': return { ...grid(STATE_ROWS, 5.6, 9.5, palette, flat), zoom: 'fit' };
    case 'containers': return { ...grid(CONTAINER_ROWS, 6.6, 9.5, palette, flat), zoom: 'fit' };
    case 'plot': {
      const out: Layout = { parts: [], labels: [], sockets: [], bounds: 15, zoom: 'gameplay' };
      const at = (a: number, d: number) => ({ x: R.x * a + D.x * d, z: R.z * a + D.z * d });
      const p1 = at(-11, -3), p2 = at(0, -3), p3 = at(11, -3);
      taskPlot(out, palette, flat, p1.x, p1.z, { state: 'working', robot: 'working', library: 6, mail: 3, steles: 2, caption: 'Task · working · 1 running session' });
      taskPlot(out, palette, flat, p2.x, p2.z, { state: 'planned', robot: null, library: 0, mail: 1, steles: 0, caption: 'Task · assigned, no running session (no robot)' });
      taskPlot(out, palette, flat, p3.x, p3.z, { state: 'done', robot: null, library: 9, mail: 12, steles: 5, caption: 'Task · done · 5 ended sessions' });
      const keep = at(-6, 6), library = at(3, 7), factory = at(11, 5);
      push(out, buildAsset('story-keep', palette, { state: 'working', progress: .5, x: keep.x, z: keep.z, flat }), { type: 'story-keep', state: 'working' }, keep.x, keep.z);
      push(out, buildAsset('story-library', palette, { count: 15, x: library.x, z: library.z, flat }), { type: 'story-library', count: 15 }, library.x, library.z);
      push(out, buildAsset('story-code-factory', palette, { state: 'working', count: 7, x: factory.x, z: factory.z, flat }), { type: 'story-code-factory', count: 7 }, factory.x, factory.z);
      return out;
    }
    case 'kit': {
      const out: Layout = { parts: [], labels: [], sockets: [], bounds: 0, zoom: 'fit' };
      const cols = 8, rows = Math.ceil(KIT_BLOCKS.length / cols);
      KIT_BLOCKS.forEach((b, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const across = (c - (cols - 1) / 2) * 3.4, depth = ((rows - 1) / 2 - r) * 4.2;
        const x = R.x * across + D.x * depth, z = R.z * across + D.z * depth;
        out.parts.push(...buildBlock(i, palette, x, z, flat));
        out.labels.push({ x: x - D.x * 1.2, z: z - D.z * 1.2, title: b.name, sub: '' });
        out.across = Math.max(out.across ?? 0, Math.abs(across) + 2); out.depth = Math.max(out.depth ?? 0, Math.abs(depth) + 2.5);
        out.bounds = Math.max(out.bounds, out.across, out.depth);
      });
      return out;
    }
    case 'overview': return overview(palette, flat);
  }
}

/** A plausible 40-place story map at the game's overview zoom: silhouettes must still read. */
function overview(palette: Palette, flat: string | null): Layout {
  // bounds = the world extent the game would compute for a 34-unit outer ring
  const out: Layout = { parts: [], labels: [], sockets: [], bounds: 38, zoom: 'overview' };
  const put = (item: Item, x: number, z: number, label = false) => push(out, buildAsset(item.type, palette, { state: item.state, count: item.count, progress: item.progress ?? null, x, z, flat }), item, x, z, label);
  put({ type: 'story-keep', state: 'working', progress: .4 }, 0, 0, true);
  put({ type: 'story-library', count: 12 }, -9, 5, true);
  put({ type: 'story-code-factory', state: 'working', count: 6 }, 9, 5, true);
  const ring: Array<[Item, number]> = [
    [{ type: 'task-workshop', state: 'working' }, 20], [{ type: 'task-workshop', state: 'planned' }, 20], [{ type: 'task-workshop', state: 'done' }, 20],
    [{ type: 'task-workshop', state: 'blocked' }, 20], [{ type: 'task-workshop', state: 'waiting' }, 20], [{ type: 'story-gate', state: 'working' }, 20],
    [{ type: 'task-workshop', state: 'working' }, 34], [{ type: 'doc-lectern', state: 'done' }, 34], [{ type: 'artifact-vitrine', state: 'done' }, 34],
    [{ type: 'drawing-easel', state: 'done' }, 34], [{ type: 'pr-tollgate', state: 'waiting' }, 34], [{ type: 'memory-crystal' }, 34],
    [{ type: 'teammate-camp', state: 'planned' }, 34], [{ type: 'task-workshop', state: 'done' }, 34], [{ type: 'attention-belfry', state: 'waiting' }, 34],
    [{ type: 'file-crate' }, 34], [{ type: 'unknown-cairn' }, 34], [{ type: 'story-gate', state: 'done' }, 34],
  ];
  const counts = new Map<number, number>();
  for (const [, r] of ring) counts.set(r, (counts.get(r) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (const [item, r] of ring) {
    const i = seen.get(r) ?? 0; seen.set(r, i + 1);
    const a = (i / counts.get(r)!) * Math.PI * 2 + (r > 25 ? .25 : 0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    put(item, x, z);
    if (item.type === 'task-workshop') {
      const t = buildAsset('task-workshop', palette, { state: item.state, x, z });
      const s = t.sockets;
      put({ type: 'task-library', count: 3 + i }, s.left!.x, s.left!.z);
      put({ type: 'task-mailbox', count: i % 3 }, s.right!.x, s.right!.z);
      if (item.state === 'working' || item.state === 'waiting') put({ type: 'session-robot', state: item.state }, s.robot!.x, s.robot!.z);
      if (item.state === 'done' || item.state === 'blocked') put({ type: 'session-stele', state: item.state === 'done' ? 'done' : 'blocked', count: 2 }, s.back!.x, s.back!.z - .3);
    }
  }
  return out;
}

interface Screen { left: number; top: number }
function Camera({ bounds, across, depth, zoom, labels, onProject }: { bounds: number; across?: number; depth?: number; zoom: Layout['zoom']; labels: Label[]; onProject: (at: Screen[]) => void }) {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.position.set(24, 23, 24); cam.lookAt(0, 0, 0);
    const gameplay = Math.max(22, Math.min(43, size.height / 18));
    // screen-space fit: depth rows foreshorten by the camera pitch (~0.69) and tall assets add ~4 units of headroom
    const fit = Math.min(size.width / ((across ?? bounds) * 2.08), size.height / ((depth ?? bounds) * 1.38 + 4));
    cam.zoom = zoom === 'overview' ? Math.min(size.width, size.height) / (bounds * 2.5) : zoom === 'fit' ? Math.min(gameplay, fit) : gameplay;
    cam.updateProjectionMatrix();
    document.documentElement.dataset.catalogZoom = cam.zoom.toFixed(1);
    document.documentElement.dataset.gameplayZoom = gameplay.toFixed(1);
    cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    onProject(labels.map((l) => { v.set(l.x, l.y ?? 0, l.z).project(cam); return { left: (v.x + 1) / 2 * size.width, top: (1 - v.y) / 2 * size.height }; }));
  }, [camera, size, bounds, across, depth, zoom, labels, onProject]);
  return null;
}

export function AssetCatalog({ sheet, theme, silhouette, sockets, reduced }: { sheet: CatalogSheet; theme: 'light' | 'dark'; silhouette: boolean; sockets: boolean; reduced: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  useLayoutEffect(() => { if (host.current) setPalette(readPalette(host.current)); }, [theme]);
  return <div ref={host} className="cv2-root asset-catalog" data-theme={theme === 'dark' ? 'dark' : undefined}>
    <header className="asset-catalog__head">
      <strong>Story game · asset catalog</strong>
      <nav>{CATALOG_SHEETS.map((s) => <a key={s} className={s === sheet ? 'is-on' : ''} href={`?sheet=${s}${theme === 'dark' ? '&theme=dark' : ''}${silhouette ? '&silhouette=1' : ''}`}>{s}</a>)}</nav>
      <span>{theme} · {silhouette ? 'silhouette (ink only)' : 'palette'} · {sheet === 'overview' ? 'overview zoom' : 'gameplay camera'}</span>
    </header>
    {palette && <Stage sheet={sheet} palette={palette} silhouette={silhouette} sockets={sockets} reduced={reduced} />}
  </div>;
}

function Stage({ sheet, palette, silhouette, sockets, reduced }: { sheet: CatalogSheet; palette: Palette; silhouette: boolean; sockets: boolean; reduced: boolean }) {
  const layout = useMemo(() => layoutOf(sheet, palette, silhouette ? palette.ink : null), [sheet, palette, silhouette]);
  const colors = useMemo(() => landscapeColors(palette), [palette]);
  const revealed = useMemo(() => new Set<string>(), []);
  const small = layout.zoom === 'overview';
  const [at, setAt] = useState<Screen[]>([]);
  return <div className="asset-catalog__stage">
  <Canvas className="asset-catalog__canvas" shadows orthographic camera={{ position: [24, 23, 24], zoom: 30, near: .1, far: 600 }} dpr={[1, 1.5]} gl={{ antialias: true, preserveDrawingBuffer: true }}>
    <color attach="background" args={[colors.sea]} />
    <hemisphereLight args={[daylightColor(palette), palette.info, 1.35]} />
    <directionalLight position={[-30, 60, 25]} color={daylightColor(palette)} intensity={2.8} castShadow shadow-mapSize={[2048, 2048]}
      shadow-camera-left={-layout.bounds * 1.6} shadow-camera-right={layout.bounds * 1.6} shadow-camera-top={layout.bounds * 1.6} shadow-camera-bottom={-layout.bounds * 1.6} shadow-bias={-.0005} shadow-normalBias={.025} />
    <directionalLight position={[10, 5, -10]} color={palette.wait} intensity={.7} />
    <Camera bounds={layout.bounds} across={layout.across} depth={layout.depth} zoom={layout.zoom} labels={layout.labels} onProject={setAt} />
    <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={-.01}><circleGeometry args={[layout.bounds * (layout.zoom === 'overview' ? 1.15 : 1.9), 48]} /><meshStandardMaterial color={colors.grass} roughness={1} /></mesh>
    <SceneryBatch parts={layout.parts} revealed={revealed} palette={palette} reduced={reduced} onPlaceClick={() => undefined} />
    {sockets && layout.sockets.map((s, i) => <mesh key={i} position={[s.x, s.y + .05, s.z]}><octahedronGeometry args={[.12]} /><meshBasicMaterial color={palette.block} /></mesh>)}
  </Canvas>
  {layout.labels.map((l, i) => at[i] && <span key={i} className={l.badge ? 'asset-catalog__badge' : `asset-catalog__label${small ? ' is-small' : ''}`} style={{ left: at[i]!.left, top: at[i]!.top }}>
    {l.badge ? l.title : <><b>{l.title}</b>{l.sub && <i>{l.sub}</i>}{l.tag && !small && <em data-tag={l.tag}>{l.tag}</em>}</>}
  </span>)}
  </div>;
}
