import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Palette } from './palette';
import type { World } from './world';
import { daylightColor, landscapeColors, seedOf, tint, type Part } from './scenery';

const coast = (a: number) => 1 + .023 * Math.sin(a * 5) + .018 * Math.cos(a * 9);
export function Island({ world, palette, onGround, reduced }: { world: World; palette: Palette; reduced: boolean; onGround: (x: number, z: number) => void }) {
  const c = useMemo(() => landscapeColors(palette), [palette]);
  const geo = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 96);
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), f = coast(Math.atan2(z, x));
      pos.setX(i, x * f); pos.setZ(i, z * f);
    }
    geometry.computeVertexNormals(); return geometry;
  }, []);
  const meadow = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ color: c.grass, roughness: 1, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMeadowShade = { value: new THREE.Color(c.leaf) };
      shader.vertexShader = 'varying vec3 vMeadow;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvMeadow = (modelMatrix * vec4(position, 1.)).xyz;');
      shader.fragmentShader = 'varying vec3 vMeadow; uniform vec3 uMeadowShade;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float field = sin(vMeadow.x * .38 + sin(vMeadow.z * .27)) * cos(vMeadow.z * .31);
        float meadowPatch = smoothstep(-.35, .65, field);
        vec2 cell = floor(vMeadow.xz * 6.);
        float grain = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        diffuseColor.rgb = mix(diffuseColor.rgb, uMeadowShade, meadowPatch * .24) * (.96 + grain * .08);
      `);
    };
    return mat;
  }, [c]);
  useEffect(() => () => { geo.dispose(); }, [geo]);
  useEffect(() => () => meadow.dispose(), [meadow]);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uRadius: { value: world.extent }, uSea: { value: new THREE.Color(c.sea) }, uFoam: { value: new THREE.Color(c.sand) }, uShallows: { value: new THREE.Color(c.shallows) } }), [world.extent, c]);
  useFrame((s) => { uniforms.uTime.value = s.clock.elapsedTime * (reduced ? .18 : 1); });
  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onGround(e.point.x, e.point.z); };
  return <group>
    <mesh rotation-x={-Math.PI / 2} position-y={-1.12} onClick={click}>
      <planeGeometry args={[world.extent * 14, world.extent * 14]} />
      <shaderMaterial uniforms={uniforms} vertexShader={`varying vec2 vWorld; void main(){ vec4 p = modelMatrix * vec4(position,1.); vWorld=p.xz; gl_Position=projectionMatrix*viewMatrix*p; }`}
        fragmentShader={`varying vec2 vWorld; uniform float uTime; uniform float uRadius; uniform vec3 uSea; uniform vec3 uFoam; uniform vec3 uShallows;
          void main(){
            float a=atan(vWorld.y,vWorld.x); float r=uRadius*(1.+.023*sin(a*5.)+.018*cos(a*9.));
            float shore=length(vWorld)-r;
            float wave=sin(vWorld.x*.7+uTime*.55)*cos(vWorld.y*.55-uTime*.4);
            vec3 water=mix(uSea,uShallows, exp(-max(shore,0.)*.16)*.75 + wave*.025);
            float foam=(1.-smoothstep(.035,.14,abs(sin(shore*3.-uTime*.8)))) * exp(-max(shore,0.)*.5);
            water=mix(water,uFoam,foam*.42);
            float spark=pow(max(0.,sin(vWorld.x*2.3+uTime)*cos(vWorld.y*2.-uTime*.6)),24.);
            water+=uShallows*spark*.16;
            gl_FragColor=vec4(water,1.);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`} />
    </mesh>
    <mesh position-y={-.67} scale={[world.extent + .2, .95, world.extent + .2]} onClick={click}><primitive object={geo} attach="geometry" /><meshStandardMaterial color={c.stone} flatShading roughness={1} /></mesh>
    <mesh position-y={-.21} scale={[world.extent + .25, .24, world.extent + .25]} onClick={click}><primitive object={geo} attach="geometry" /><meshStandardMaterial color={c.sand} flatShading roughness={1} /></mesh>
    <mesh receiveShadow position-y={-.08} scale={[world.extent, .17, world.extent]} onClick={click}><primitive object={geo} attach="geometry" /><primitive object={meadow} attach="material" /></mesh>
  </group>;
}

/** Soft ground occlusion for every building and tree, in a single instanced draw. */
export function GroundShadows({ parts, palette }: { parts: Part[]; palette: Palette }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const shadows = useMemo(() => parts.filter((p) => (p.geo === 'orb' && p.sy > .5) || (p.geo === 'cylinder' && p.sx > .8 && p.y < .3)), [parts]);
  useEffect(() => {
    const dummy = new THREE.Object3D();
    shadows.forEach((p, i) => {
      dummy.position.set(p.x + .15, .017, p.z + .12); dummy.rotation.x = -Math.PI / 2;
      dummy.scale.set(p.sx * 1.5, p.sz * 1.5, 1); dummy.updateMatrix(); ref.current?.setMatrixAt(i, dummy.matrix);
    });
    if (ref.current) { ref.current.instanceMatrix.needsUpdate = true; ref.current.computeBoundingSphere(); }
  }, [shadows]);
  const uniforms = useMemo(() => ({ color: { value: new THREE.Color(daylightColor(palette) === palette.card ? palette.ink : palette.card) } }), [palette]);
  return <instancedMesh ref={ref} args={[undefined, undefined, shadows.length]} renderOrder={1}>
    <planeGeometry args={[2, 2]} />
    <shaderMaterial transparent depthWrite={false} uniforms={uniforms}
      vertexShader="varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.); }"
      fragmentShader="varying vec2 vUv; uniform vec3 color; void main(){ float a=pow(max(0.,1.-length(vUv-.5)*2.),1.5)*.3; gl_FragColor=vec4(color,a); }" />
  </instancedMesh>;
}

export function Atmosphere({ world, palette, reduced }: { world: World; palette: Palette; reduced: boolean }) {
  const cloud = useRef<THREE.Group>(null), birds = useRef<THREE.Group>(null);
  const positions = useMemo(() => {
    const values = new Float32Array(100 * 3);
    for (let i = 0; i < 100; i++) {
      const a = seedOf(`${world.storyId}/mote/${i}`) * Math.PI * 2;
      const r = Math.sqrt(seedOf(`mote/${i}/${world.storyId}`)) * world.extent;
      values[i * 3] = Math.cos(a) * r; values[i * 3 + 1] = .5 + seedOf(`height${i}`) * 3; values[i * 3 + 2] = Math.sin(a) * r;
    }
    return values;
  }, [world.storyId, world.extent]);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, color: { value: new THREE.Color(tint(palette.wait, palette.card, .65)) } }), [palette]);
  useFrame((s) => {
    const t = s.clock.elapsedTime * (reduced ? .15 : 1); uniforms.uTime.value = t;
    if (cloud.current) { cloud.current.position.x = Math.sin(t * .035) * 2; cloud.current.position.z = Math.cos(t * .025); }
    if (birds.current) { birds.current.rotation.y = t * .065; birds.current.position.y = Math.sin(t * .8) * .25; }
  });
  return <group>
    <points frustumCulled={false}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
      <shaderMaterial transparent depthWrite={false} uniforms={uniforms}
        vertexShader={`uniform float uTime; varying float vLight; void main(){ vec3 p=position; p.x+=sin(uTime*.3+p.z)*.45; p.y+=sin(uTime*.5+p.x)*.3; vLight=.45+.3*sin(uTime+p.z); gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); gl_PointSize=3.; }`}
        fragmentShader={`uniform vec3 color; varying float vLight; void main(){ float a=1.-smoothstep(.05,.5,length(gl_PointCoord-.5)); gl_FragColor=vec4(color,a*vLight); }`} />
    </points>
    <group ref={cloud}>
      {[0, 1, 2, 3, 4].map((i) => <group key={i} position={[Math.cos(i * 1.7) * world.extent * .83, 5.8 + i % 2, Math.sin(i * 1.7) * world.extent * .83]}>
        {[0, 1, 2].map((j) => <mesh key={j} position={[j * 1.05, Math.sin(j) * .35, 0]} scale={[1.8, .5 + j % 2 * .24, .8]}>
          <icosahedronGeometry args={[1, 1]} /><meshBasicMaterial color={daylightColor(palette)} transparent opacity={.23} depthWrite={false} />
        </mesh>)}
      </group>)}
    </group>
    <group ref={birds}>
      {[0, 1, 2].map((i) => <group key={i} position={[4 + i * .9, 6 + i * .2, -5 - i]} rotation-y={-.8}>
        {[-1, 1].map((s) => <mesh key={s} position={[s * .17, .02, 0]} rotation-z={s * .28}><boxGeometry args={[.38, .04, .13]} /><meshBasicMaterial color={palette.card} /></mesh>)}
      </group>)}
    </group>
  </group>;
}
