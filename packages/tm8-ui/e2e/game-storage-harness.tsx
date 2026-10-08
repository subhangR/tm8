/** Entirely synthetic DB fixture, production GameMode/real Seam/map loader/renderer. */
import { createRoot } from 'react-dom/client';
import { _roots } from '@react-three/fiber';
import { Vector3 } from 'three';
import { GameNavigationSaveSchema } from '@tm8/contract';
import { parseGameSave } from '../src/game/local-save';
import GameMode from '../src/game/GameMode';
import { createRealSeam } from '../src/data/real/seam-real';
import { browserWebSocketFactory } from '../src/data/real/socket';
import { createGameMapLoader } from '../src/data/game-maps';
import { buildMapModel } from '../src/story/game/map-model';
import { walkingBounds, walkingEntrance } from '../src/story/game/map-model/walking-world';
import type { GameMapLoader } from '../src/game/types';
import type { MapModel } from '../src/story/game/map-model';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';

const params = new URLSearchParams(location.search);
const required = (key: string) => { const value = params.get(key); if (!value) throw new Error(`Missing synthetic ${key}`); return value; };
const spaceId = required('space'), memberId = required('member'), storyId = required('story'), nestedStoryId = required('nested'), taskId = required('task');
const seam = createRealSeam({ origin: location.origin, fetch: window.fetch.bind(window), webSocketFactory: browserWebSocketFactory(WebSocket),
  getAuthToken: () => (window as unknown as { __storageToken?: string }).__storageToken ?? null });
const saveObservations: unknown[] = [];
const persistence: typeof seam.game = { ...seam.game!, save: async (...args) => {
  const began = Date.now();
  const sent = args[1];
  try {
    const ack = await seam.game!.save(...args);
    const checked = GameNavigationSaveSchema.safeParse(ack.save);
    saveObservations.push({ began, ended: Date.now(), expectedRevision: args[2], sentType: sent.current.type,
      sentMemoryCount: Object.keys(sent.maps).length, revision: ack.revision, repairs: ack.repairs,
      identityMatch: ack.spaceId === spaceId && ack.memberId === memberId,
      sharedValid: checked.success, issues: checked.success ? [] : checked.error.issues.map(issue => ({ code: issue.code, path: issue.path })),
      localValid: !!parseGameSave(ack.save, spaceId, memberId) });
    return ack;
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string };
    saveObservations.push({ began, ended: Date.now(), expectedRevision: args[2], sentType: sent.current.type,
      failed: true, name: failure.name, code: failure.code, message: failure.message?.split('\n')[0].slice(0, 300) });
    throw error;
  }
} };
const productionLoader = createGameMapLoader(seam, spaceId);
const models = new Map<string, MapModel>();
const loads: { kind: string; type: string }[] = [];
const loadMap: GameMapLoader = async (scope, signal, type = 'hub') => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  loads.push({ kind: scope.kind, type });
  const result = await productionLoader(scope, signal, type);
  const key = JSON.stringify([scope.kind, scope.id, type]);
  models.set(key, buildMapModel(result.input, { scope, type }));
  return result;
};

Object.assign(window, { __storageHarness: {
  loads,
  saveObservations,
  model: (key: string) => { const model = models.get(key)!; return { bounds: walkingBounds(model), entrance: walkingEntrance(model),
    places: model.places.map(p => ({ entityId: p.entityId, x: p.x, z: p.z, radius: p.radius })), id: model.id }; },
  // Observe the real renderer's camera and player, independently of persisted DTOs.
  scene: () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="walking-map"] .sgm-stage canvas');
    const state = canvas ? _roots.get(canvas)?.store.getState() : undefined;
    if (!state) return null;
    const forward = state.camera.getWorldDirection(new Vector3()).toArray();
    let player: [number, number, number] | null = null;
    const plots: number[][] = [];
    state.scene.traverse(node => {
      const instance = (node as unknown as { __r3f?: { parent?: { object?: unknown }; props?: { visible?: boolean; position?: unknown[] } } }).__r3f;
      const p = instance?.props;
      // Player's parent group is the only visible=true group at ground y=0.
      if (p?.visible === true && Array.isArray(p.position) && p.position.length === 3 && p.position[1] === 0) player = node.position.toArray();
      if (p && Array.isArray(p.position) && 'onClick' in p && 'onPointerOver' in p && 'onPointerOut' in p) plots.push(node.position.toArray());
    });
    return { camera: { position: state.camera.position.toArray(), zoom: state.camera.zoom, forward }, player, plots,
      drawCalls: state.gl.info.render.calls };
  },
} });
createRoot(document.getElementById('root')!).render(<div className="cv2-root" data-theme="dark" style={{ height: '100vh' }}>
  <GameMode spaceId={spaceId} memberId={memberId} spaceTitle="Synthetic storage world" loadMap={loadMap} persistence={persistence} onInspect={() => {}} />
</div>);
