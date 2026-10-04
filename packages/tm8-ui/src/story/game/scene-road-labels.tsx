/** Road destination signs: two pooled DOM labels in the scene's .sgm-labels layer, projected per frame. */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameControl } from './control';
import type { World } from './world';
import { blankRoadLabel, writeRoadLabels, type RoadLabel } from './road-labels';
import './story-game-roads.css';

/** World units from the player to each sign, along its heading. */
const SIGN_OFFSET = 2.8;
const SIGN_HEIGHT = 1.1;

/** One pooled sign plus the last values written, so a still frame touches no DOM and builds no strings. */
export interface RoadSignSlot {
  node: HTMLDivElement; dir: HTMLElement; title: HTMLElement; steps: HTMLElement;
  shown: boolean; placeId: string; count: number; deg: number; x: number; y: number; opacity: number;
}

/** The fixed pool: built once per mount, removed on unmount. */
export function createRoadSignPool(layer: HTMLElement, size = 2): RoadSignSlot[] {
  const doc = layer.ownerDocument;
  return Array.from({ length: size }, () => {
    const node = doc.createElement('div'), dir = doc.createElement('i'), title = doc.createElement('span'), steps = doc.createElement('span');
    node.className = 'sgm-world-label sgm-roadsign'; node.style.display = 'none';
    dir.className = 'sgm-roadsign__dir'; title.className = 'sgm-roadsign__title'; steps.className = 'sgm-roadsign__steps';
    node.append(dir, title, steps); layer.append(node);
    return { node, dir, title, steps, shown: false, placeId: '', count: -1, deg: Number.NaN, x: Number.NaN, y: Number.NaN, opacity: -1 };
  });
}

export function hideRoadSign(slot: RoadSignSlot): void {
  if (slot.shown) { slot.node.style.display = 'none'; slot.shown = false; }
}

/** Writes one sign at screen pixel (x, y) pointing `deg` clockwise from screen right. Only changed values touch the DOM. */
export function paintRoadSign(slot: RoadSignSlot, label: RoadLabel, x: number, y: number, deg: number, reduced: boolean): void {
  // Reduced motion: no fade, the sign simply toggles with the threshold.
  const opacity = reduced ? 1 : Math.round(label.opacity * 100) / 100;
  if (!slot.shown) { slot.node.style.display = 'flex'; slot.shown = true; }
  if (slot.placeId !== label.placeId) { slot.placeId = label.placeId; slot.title.textContent = label.title; slot.node.dataset.placeId = label.placeId; }
  if (slot.count !== label.steps) { slot.count = label.steps; slot.steps.textContent = `${label.steps} ${label.steps === 1 ? 'step' : 'steps'}`; }
  const rx = Math.round(x), ry = Math.round(y), rd = Math.round(deg);
  if (slot.deg !== rd) { slot.deg = rd; slot.node.style.setProperty('--sgm-dir', `${rd}deg`); }
  if (slot.x !== rx || slot.y !== ry) { slot.x = rx; slot.y = ry; slot.node.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`; }
  if (slot.opacity !== opacity) { slot.opacity = opacity; slot.node.style.opacity = String(opacity); }
}

/** The labels layer is the sibling the scene renders next to the canvas. */
function labelsLayer(canvas: HTMLElement): HTMLElement | null {
  for (let at = canvas.parentElement; at; at = at.parentElement) {
    const layer = at.querySelector<HTMLElement>(':scope > .sgm-labels');
    if (layer) return layer;
  }
  return null;
}

export function RoadLabels({ world, control, playerPos, hidden, reduced }: { world: World; control: GameControl; playerPos: MutableRefObject<THREE.Vector3>; hidden: boolean; reduced: boolean }) {
  const { camera, gl } = useThree();
  const pool = useRef<RoadSignSlot[]>([]);
  const labels = useRef<[RoadLabel, RoadLabel]>([blankRoadLabel(), blankRoadLabel()]);
  const from = useRef(new THREE.Vector3()), to = useRef(new THREE.Vector3());
  useEffect(() => {
    const layer = labelsLayer(gl.domElement);
    if (!layer) return;
    const slots = createRoadSignPool(layer);
    pool.current = slots;
    return () => { pool.current = []; for (const s of slots) s.node.remove(); };
  }, [gl]);
  useFrame(() => {
    const slots = pool.current;
    if (!slots.length) return;
    const pos = playerPos.current;
    const count = hidden || control.overview ? 0 : writeRoadLabels(world, pos.x, pos.z, labels.current);
    const width = gl.domElement.clientWidth, height = gl.domElement.clientHeight;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!, label = labels.current[i];
      if (i >= count || !label || label.opacity <= 0) { hideRoadSign(slot); continue; }
      const dx = Math.sin(label.angle), dz = Math.cos(label.angle);
      from.current.set(pos.x, SIGN_HEIGHT, pos.z).project(camera);
      to.current.set(pos.x + dx * SIGN_OFFSET, SIGN_HEIGHT, pos.z + dz * SIGN_OFFSET).project(camera);
      const fx = (from.current.x * .5 + .5) * width, fy = (-from.current.y * .5 + .5) * height;
      const tx = (to.current.x * .5 + .5) * width, ty = (-to.current.y * .5 + .5) * height;
      paintRoadSign(slot, label, tx, ty, Math.atan2(ty - fy, tx - fx) * 180 / Math.PI, reduced);
    }
  });
  return null;
}
