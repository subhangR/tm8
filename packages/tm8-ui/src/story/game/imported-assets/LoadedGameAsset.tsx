import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { AnimationMixer, Mesh, SkinnedMesh } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { getImportedAsset, type ImportedAsset, type ImportedAssetId } from './registry';
export interface LoadedGameAssetProps {
  assetId: ImportedAssetId;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  clip?: string;
  reducedMotion?: boolean;
  fallback?: ReactNode;
}
class AssetBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function Model({ asset, clip, reducedMotion }: { asset: ImportedAsset; clip?: string; reducedMotion?: boolean }) {
  const gltf = useGLTF(asset.url);
  const object = useMemo(() => {
    const instance = clone(gltf.scene);
    instance.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
    return instance;
  }, [gltf.scene]);
  useEffect(() => () => {
    object.traverse((node) => { if (node instanceof SkinnedMesh) node.skeleton.dispose(); });
  }, [object]);
  const mixer = useMemo(() => new AnimationMixer(object), [object]);
  useEffect(() => {
    const animation = gltf.animations.find((a) => a.name === clip);
    if (!animation) return;
    const action = mixer.clipAction(animation);
    action.reset().play();
    mixer.update(0);
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(object); };
  }, [gltf.animations, clip, mixer, object]);
  useFrame((_, delta) => { if (!reducedMotion) mixer.update(Math.min(delta, .1)); });
  return <group scale={asset.scale}><group position={asset.groundOffset}><primitive object={object} dispose={null} /></group></group>;
}
/** Cached downloads, independent skeletons/mixers; cached source geometry is never disposed by instances. */
export function LoadedGameAsset({ assetId, position, rotation, scale = 1, clip, reducedMotion, fallback = null }: LoadedGameAssetProps) {
  const asset = getImportedAsset(assetId);
  return <group position={position} rotation={rotation} scale={scale}>
    {asset ? <AssetBoundary key={asset.id} fallback={fallback}><Suspense fallback={fallback}><Model asset={asset} clip={clip} reducedMotion={reducedMotion} /></Suspense></AssetBoundary> : fallback}
  </group>;
}
