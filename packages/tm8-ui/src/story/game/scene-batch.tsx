import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { type Part, type Solid } from './scenery';
import type { Palette } from './palette';
import { KIT_GEOMETRIES } from './assets/geometry';

/** The kit's twelve unit solids; one instanced batch each. */
const geometries = KIT_GEOMETRIES;
interface Props {
  parts: Part[]; revealed: ReadonlySet<string>; palette: Palette; reduced: boolean;
  onPlaceClick: (id: string, open: boolean) => void;
}
export function SceneryBatch(props: Props) {
  const buckets = useMemo(() => Object.keys(geometries).map((geo) => ({ geo: geo as Solid, parts: props.parts.filter((p) => p.geo === geo) })).filter((b) => b.parts.length > 0), [props.parts]);
  return <group>{buckets.map((b) => <Batch key={b.geo} {...props} {...b} />)}</group>;
}
function Batch({ geo, parts, palette, revealed, reduced, onPlaceClick }: Props & { geo: Solid }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const clock = useThree((s) => s.clock);
  const initial = useRef(revealed);
  // A new geometry from a live graph refresh starts already-known places fully raised.
  initial.current = revealed;
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uMotion: { value: 1 }, uMist: { value: new THREE.Color(palette.surface) } }), [palette.surface]);
  const data = useMemo(() => {
    const geometry = geometries[geo]();
    const births = new Float32Array(parts.length), motion = new Float32Array(parts.length);
    parts.forEach((p, i) => { births[i] = !p.placeId || initial.current.has(p.placeId) ? -1000 : 1000000; motion[i] = p.motion; });
    geometry.setAttribute('aBirth', new THREE.InstancedBufferAttribute(births, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aMotion', new THREE.InstancedBufferAttribute(motion, 1));
    return geometry;
  }, [geo, parts]);
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: .91, metalness: .025, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = `attribute float aBirth; attribute float aMotion; uniform float uTime; uniform float uMotion; varying float vReveal; varying float vGlow;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
        vReveal = uMotion < .5 ? step(aBirth, uTime) : smoothstep(0., 1., clamp((uTime - aBirth) / 1.1, 0., 1.));
        vGlow = step(2.5, aMotion) * (1. - step(3.5, aMotion));
        vec4 worldPart = instanceMatrix * vec4(transformed, 1.);
        worldPart.y -= (1. - vReveal) * .85;
        float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z;
        if (aMotion > .5 && aMotion < 1.5) worldPart.x += sin(uTime * 1.6 + phase) * .055 * uMotion * max(position.y + .5, 0.);
        if (aMotion > 1.5 && aMotion < 2.5) worldPart.y += sin(uTime * 1.8 + phase) * .09 * uMotion;
        if (aMotion > 3.5) { worldPart.y += mod(uTime * .25 + phase, .7) * uMotion; worldPart.x += sin(uTime + phase) * .1 * uMotion; }
        vec4 mvPosition = modelViewMatrix * worldPart;
        gl_Position = projectionMatrix * mvPosition;
      `);
      shader.fragmentShader = `uniform vec3 uMist; varying float vReveal; varying float vGlow;\n${shader.fragmentShader}`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(uMist * .76, diffuseColor.rgb, .28 + vReveal * .72);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * .55 * vReveal;');
    };
    mat.customProgramCacheKey = () => 'story-diorama-v1';
    return mat;
  }, [uniforms]);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const transform = new THREE.Object3D(), color = new THREE.Color();
    parts.forEach((p, i) => {
      transform.position.set(p.x, p.y, p.z); transform.rotation.set(p.rx, p.ry, p.rz); transform.scale.set(p.sx, p.sy, p.sz); transform.updateMatrix();
      mesh.current!.setMatrixAt(i, transform.matrix); mesh.current!.setColorAt(i, color.set(p.color));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [parts]);
  useEffect(() => {
    const birth = data.getAttribute('aBirth') as THREE.InstancedBufferAttribute;
    parts.forEach((p, i) => {
      if (!p.placeId) return;
      if (revealed.has(p.placeId) && birth.getX(i) > 999999) birth.setX(i, clock.elapsedTime);
      else if (!revealed.has(p.placeId)) birth.setX(i, 1000000);
    });
    birth.needsUpdate = true;
  }, [revealed, clock, data, parts]);
  useEffect(() => () => { data.dispose(); }, [data]);
  useEffect(() => () => { material.dispose(); }, [material]);
  useFrame((state) => { uniforms.uTime.value = state.clock.elapsedTime; uniforms.uMotion.value = reduced ? .16 : 1; });
  const click = (e: ThreeEvent<MouseEvent>, open: boolean) => {
    const part = e.instanceId === undefined ? null : parts[e.instanceId];
    if (part?.placeId) { e.stopPropagation(); onPlaceClick(part.placeId, open); }
  };
  return <instancedMesh ref={mesh} args={[data, material, parts.length]} castShadow onClick={(e) => click(e, false)} onDoubleClick={(e) => click(e, true)} />;
}
