/** One compact compositor: soft highlight bloom, edge tilt shift and vignette. */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function DioramaFinish() {
  const { gl, scene, camera, size, viewport } = useThree();
  const effect = useMemo(() => {
    const composer = new EffectComposer(gl);
    const render = new RenderPass(scene, camera);
    const grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 resolution; varying vec2 vUv;
        void main() {
          vec3 source = texture2D(tDiffuse, vUv).rgb;
          float edge = smoothstep(.20, .51, abs(vUv.y - .47));
          vec2 stepSize = (1. + edge * 2.4) / resolution;
          vec3 soft = (texture2D(tDiffuse, vUv + vec2(stepSize.x, stepSize.y)).rgb
            + texture2D(tDiffuse, vUv + vec2(-stepSize.x, stepSize.y)).rgb
            + texture2D(tDiffuse, vUv + vec2(stepSize.x, -stepSize.y)).rgb
            + texture2D(tDiffuse, vUv - stepSize).rgb) * .25;
          vec3 color = mix(source, soft, edge * .6) + max(soft - .72, 0.) * .12;
          vec2 q = (vUv - .5) * vec2(.85, 1.);
          color *= 1. - smoothstep(.1, .65, dot(q,q)) * .25;
          gl_FragColor = vec4(color, 1.);
        }`,
    });
    const output = new OutputPass();
    composer.addPass(render); composer.addPass(grade); composer.addPass(output);
    return { composer, render, grade, output };
  }, [gl, scene, camera]);
  useEffect(() => {
    effect.composer.setPixelRatio(viewport.dpr);
    effect.composer.setSize(size.width, size.height);
    effect.grade.uniforms.resolution!.value.set(size.width * viewport.dpr, size.height * viewport.dpr);
  }, [effect, size, viewport.dpr]);
  useEffect(() => () => {
    effect.composer.dispose(); effect.render.dispose(); effect.grade.dispose(); effect.output.dispose();
  }, [effect]);
  useFrame((_, delta) => effect.composer.render(delta), 1);
  return null;
}
