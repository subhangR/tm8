/**
 * COUNT BADGES (story map W7). The numerals the kit never draws: a landmark's
 * member count, a task's Library and Mailbox counts, pending attention. Each
 * is a DOM span in the scene's label layer, projected every frame to the
 * asset's badge anchor (`assetMetrics(type).badgeAnchor`, via `badgesOf`).
 * Nodes are pooled by badge id and reused; visibility follows the place
 * labels — roots only in the overview, else revealed and within LABEL_RADIUS.
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameControl } from './control';
import { badgeText, badgesOf, type PlaceBadge } from './place-asset';
import type { World } from './world';
import './story-game-badges.css';

export interface BadgesProps {
  control: GameControl;
  world: World;
  revealed: ReadonlySet<string>;
  playerPos: MutableRefObject<THREE.Vector3>;
  /** A duel is up: the badges step aside like the place labels do. */
  hidden: boolean;
  /** The place labels' radius, so badges and names appear together. */
  labelRadius: number;
  reduced: boolean;
}

/** One span per badge, keyed by id; text and kind refreshed in place, strays removed. Pure DOM, jsdom-testable. */
export function syncBadgeNodes(container: HTMLElement, badges: readonly PlaceBadge[], pool: Map<string, HTMLSpanElement>): void {
  const wanted = new Set(badges.map((b) => b.id));
  for (const [id, node] of pool) if (!wanted.has(id)) { node.remove(); pool.delete(id); }
  for (const b of badges) {
    let node = pool.get(b.id);
    if (!node) {
      node = container.ownerDocument.createElement('span');
      node.style.display = 'none';
      container.appendChild(node);
      pool.set(b.id, node);
    }
    node.className = `sgm-badge sgm-world-label sgm-badge--${b.kind}`;
    node.dataset['placeId'] = b.placeId;
    node.textContent = badgeText(b);
  }
}

/** The place-label rule, shared so a badge never outlives its name tag. */
export function badgeVisible(b: Pick<PlaceBadge, 'placeId' | 'ring' | 'x' | 'z'>, overview: boolean, revealed: ReadonlySet<string>, px: number, pz: number, radius: number): boolean {
  return overview ? b.ring <= 1 : revealed.has(b.placeId) && Math.hypot(b.x - px, b.z - pz) < radius;
}

export function Badges({ control, world, revealed, playerPos, hidden, labelRadius, reduced }: BadgesProps) {
  const badges = useMemo(() => badgesOf(world), [world]);
  const { camera, gl } = useThree();
  const projected = useRef(new THREE.Vector3());
  const pool = useRef<Map<string, HTMLSpanElement>>(new Map());
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The label layer is the Canvas's sibling inside the stage; the canvas sits two wrappers down.
    let labels: HTMLElement | null = null;
    for (let node = gl.domElement.parentElement; node && !labels; node = node.parentElement) labels = node.querySelector<HTMLElement>(':scope > .sgm-labels');
    if (!labels) return;
    const container = labels.ownerDocument.createElement('div');
    container.className = 'sgm-badges';
    labels.appendChild(container);
    host.current = container;
    syncBadgeNodes(container, badges, pool.current);
    return () => { container.remove(); host.current = null; pool.current.clear(); };
  }, [gl, badges]);
  useEffect(() => { host.current?.classList.toggle('sgm-badges--still', reduced); }, [reduced]);

  useFrame(() => {
    const width = gl.domElement.clientWidth, height = gl.domElement.clientHeight;
    for (const b of badges) {
      const node = pool.current.get(b.id);
      if (!node) continue;
      const show = !hidden && badgeVisible(b, control.overview, revealed, playerPos.current.x, playerPos.current.z, labelRadius);
      node.style.display = show ? 'grid' : 'none';
      if (!show) continue;
      projected.current.set(b.x, b.y, b.z).project(camera);
      node.style.transform = `translate(${(projected.current.x * .5 + .5) * width}px, ${(-projected.current.y * .5 + .5) * height}px) translate(-50%, -50%)`;
    }
  });
  return null;
}
