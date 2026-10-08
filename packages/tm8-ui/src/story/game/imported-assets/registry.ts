import manifest from './manifest.json';
export type ImportedAssetId = 'terrain-grass' | 'path-straight' | 'path-crossing' | 'tree' | 'tree-pine' | 'rock' | 'gate' | 'hub' | 'office' | 'library' | 'code-factory' | 'task-building' | 'task-building-blue' | 'task-building-yellow' | 'construction-lot' | 'construction-foundation' | 'construction-scaffolding' | 'construction-walls-up' | 'construction-topped-out' | 'construction-done' | 'rubble' | 'robot' | 'desk' | 'plaque' | 'cart' | 'shipping-yard' | 'mailbox' | 'crate' | 'fence' | 'worker';
export type ConstructionStage = 'lot' | 'foundation' | 'scaffolding' | 'walls-up' | 'topped-out' | 'done';
export type RobotPose = 'working' | 'waiting' | 'blocked' | 'idle' | 'attention';
export interface ImportedAsset {
  id: ImportedAssetId;
  label: string;
  url: string;
  /** Default footprint width 1; characters default to height 1. Caller scale multiplies this. */
  scale: number;
  /** Translation in source units, applied BEFORE scale: centers X/Z and grounds minimum Y. */
  groundOffset: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  clips: string[];
  licence: 'CC0-1.0';
  source: string;
  sourceFile: string;
  bytes: number;
  sha256: string;
  /** Honest description when a semantic role reuses a visually related prop. */
  adaptation?: string;
}
const base = import.meta.env.BASE_URL ?? './';
// Static tm8 artifacts can embed GLBs when their file allowlist excludes binary model files.
const inlineAssets = (globalThis as typeof globalThis & { __TM8_GAME_ASSETS__?: Record<string, string> }).__TM8_GAME_ASSETS__;
export const IMPORTED_ASSETS: readonly ImportedAsset[] = (manifest as Array<Omit<ImportedAsset, 'url'> & { file: string }>).map((asset) => ({ ...asset, url: inlineAssets?.[asset.file] ?? `${base}game/cc0/${asset.file}` }));
export function getImportedAsset(id: string): ImportedAsset | undefined { return IMPORTED_ASSETS.find((asset) => asset.id === id); }
/** Input is 0..1. Progress alone never means done; completed status selects construction-done.
 * Prefer the authoritative model constructionStage when rendering. */
export function constructionAssetForProgress(progress: number | null | undefined): ImportedAssetId {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress!)) : 0;
  return p >= 1 ? 'construction-topped-out' : p >= .67 ? 'construction-walls-up' : p >= .34 ? 'construction-scaffolding' : p > 0 ? 'construction-foundation' : 'construction-lot';
}
/** RobotExpressive has no tool-use clip: Working uses a restrained gesture, documented in ledger. */
export const QUATERNIUS_ROBOT_POSES: Readonly<Record<RobotPose, string>> = { working: 'Yes', waiting: 'Idle', blocked: 'No', idle: 'Idle', attention: 'Wave' };
export const WORKER_POSES: Readonly<Record<RobotPose, string>> = { working: 'Interact', waiting: 'Idle', blocked: 'Idle', idle: 'Idle', attention: 'Cheer' };
export const ROBOT_POSES = WORKER_POSES;
export function constructionAssetForStage(stage: ConstructionStage): ImportedAssetId { return `construction-${stage}`; }
/** These roles deliberately retain the established procedural shapes; they are not downloaded assets. */
export const PROCEDURAL_ASSET_GAPS = {
  plaque: { assetType: 'session-stele', reason: 'No dedicated plaque in selected CC0 packs.' },
  mailbox: { assetType: 'task-mailbox', reason: 'No dedicated mailbox in selected CC0 packs.' },
} as const;
