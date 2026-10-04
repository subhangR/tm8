import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Palette } from './palette';
import { tint } from './scenery';
import type { WorldEncounter } from './world';

export interface CharacterMotion { moving: boolean; heading: number; arrival: number; }
/** Original little explorer: oversized cap, scarf, backpack, articulated hands and boots. */
export function Character({ palette, motion, reduced, trainer = false, phase = 'active' }: {
  palette: Palette; motion?: MutableRefObject<CharacterMotion>; reduced: boolean; trainer?: boolean; phase?: WorldEncounter['phase'];
}) {
  const body = useRef<THREE.Group>(null), left = useRef<THREE.Group>(null), right = useRef<THREE.Group>(null);
  const arms = useRef<THREE.Group>(null), scarf = useRef<THREE.Mesh>(null);
  const skin = useMemo(() => tint(palette.card, palette.brand, .25), [palette]);
  const cloth = trainer ? palette.merged : palette.info;
  useFrame((s, delta) => {
    if (!body.current) return;
    const t = s.clock.elapsedTime, amount = reduced ? .22 : 1, walk = motion?.current.moving ? 1 : 0;
    const step = Math.sin(t * 13) * .65 * walk * amount;
    if (left.current) left.current.rotation.x = step;
    if (right.current) right.current.rotation.x = -step;
    if (arms.current) arms.current.rotation.z = phase === 'victory' ? -.7 : Math.sin(t * 3) * .07 * amount;
    if (scarf.current) scarf.current.rotation.x = Math.sin(t * 5) * .1 * amount;
    body.current.position.y = (.035 * Math.sin(t * 2.5) + Math.abs(Math.sin(t * 13)) * .085 * walk) * amount;
    const arrival = motion ? Math.max(0, 1 - (t - motion.current.arrival) / .5) : 0;
    body.current.scale.set(1 + arrival * .15 * amount, 1 - arrival * .16 * amount, 1 + arrival * .15 * amount);
    body.current.rotation.z = reduced ? (phase === 'fainted' ? -Math.PI / 2 : 0) : THREE.MathUtils.damp(body.current.rotation.z, phase === 'fainted' ? -Math.PI / 2 : 0, 8, delta);
    if (phase === 'fainted') { body.current.position.y = .3; }
    else if (motion) body.current.rotation.y += Math.atan2(Math.sin(motion.current.heading - body.current.rotation.y), Math.cos(motion.current.heading - body.current.rotation.y)) * (1 - Math.exp(-14 * delta));
    else body.current.rotation.y = .7 + Math.sin(t * .8) * .08 * amount;
  });
  return <group>
    <mesh rotation-x={-Math.PI / 2} position-y={.025}><circleGeometry args={[.46, 24]} /><meshBasicMaterial color={palette.ink} transparent opacity={.2} depthWrite={false} /></mesh>
    <group ref={body}>
      <group ref={left} position={[-.17, .44, 0]}><mesh position={[0, -.18, .045]}><capsuleGeometry args={[.12, .22, 3, 6]} /><meshToonMaterial color={palette.ink} /></mesh></group>
      <group ref={right} position={[.17, .44, 0]}><mesh position={[0, -.18, .045]}><capsuleGeometry args={[.12, .22, 3, 6]} /><meshToonMaterial color={palette.ink} /></mesh></group>
      <mesh position-y={.7}><capsuleGeometry args={[.27, .28, 4, 8]} /><meshToonMaterial color={cloth} /></mesh>
      <mesh position={[0, .72, -.26]}><boxGeometry args={[.42, .43, .21]} /><meshToonMaterial color={palette.brand} /></mesh>
      <mesh position={[0, .77, -.38]}><boxGeometry args={[.29, .09, .04]} /><meshToonMaterial color={palette.wait} /></mesh>
      <group ref={arms} position-y={.84}>
        {[-1, 1].map((x) => <group key={x} position={[x * .31, -.1, 0]} rotation-z={x * .15}>
          <mesh><capsuleGeometry args={[.105, .23, 3, 6]} /><meshToonMaterial color={cloth} /></mesh>
          <mesh position-y={-.18}><icosahedronGeometry args={[.115, 1]} /><meshToonMaterial color={skin} /></mesh>
        </group>)}
      </group>
      <mesh position-y={1.24}><sphereGeometry args={[.38, 12, 8]} /><meshToonMaterial color={skin} /></mesh>
      <mesh position={[0, 1.43, -.035]}><sphereGeometry args={[.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshToonMaterial color={trainer ? palette.merged : palette.brand} /></mesh>
      <mesh position={[0, 1.43, .27]} scale={[1, .23, 1]}><sphereGeometry args={[.32, 10, 6]} /><meshToonMaterial color={trainer ? palette.merged : palette.brand} /></mesh>
      <mesh position={[0, 1.56, .25]}><octahedronGeometry args={[.09]} /><meshToonMaterial color={palette.wait} /></mesh>
      {[-1, 1].map((x) => <mesh key={x} position={[x * .13, 1.23, .35]}><sphereGeometry args={[.039, 6, 6]} /><meshBasicMaterial color={palette.ink} /></mesh>)}
      <mesh position={[0, 1.02, .13]}><torusGeometry args={[.23, .067, 5, 12]} /><meshToonMaterial color={palette.wait} /></mesh>
      <mesh ref={scarf} position={[.15, .87, .31]} rotation-z={-.3}><boxGeometry args={[.12, .3, .045]} /><meshToonMaterial color={palette.wait} /></mesh>
    </group>
  </group>;
}
