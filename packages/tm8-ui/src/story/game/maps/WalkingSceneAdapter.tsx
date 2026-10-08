import { useRef } from 'react';
import { Vector3 } from 'three';
import { MapScene, type MapSceneProps } from './MapScene';
import type { PlayerProps } from '../scene';
export default function WalkingSceneAdapter({ initial, walking, ...props }: Omit<MapSceneProps, 'walking'> & { initial: { x: number; z: number }; walking: Omit<PlayerProps, 'playerPos'> }) {
  const playerPos = useRef(new Vector3(initial.x, 0, initial.z));
  return <MapScene {...props} walking={{ ...walking, playerPos }}/>;
}
