import { describe, expect, it } from 'vitest';
import { constructionAssetForProgress, constructionAssetForStage, QUATERNIUS_ROBOT_POSES, getImportedAsset, IMPORTED_ASSETS, PROCEDURAL_ASSET_GAPS, ROBOT_POSES, WORKER_POSES } from './registry';
describe('imported game assets', () => {
  it('maps normalized progress through all six stages, regardless of work status', () => {
    expect([null,-1,0,.01,.34,.67,1,2,NaN].map(constructionAssetForProgress)).toEqual([
      'construction-lot','construction-lot','construction-lot','construction-foundation','construction-scaffolding','construction-walls-up','construction-topped-out','construction-topped-out','construction-lot',
    ]);
    expect([0,.2,.4,.6,.8,1].map(p=>getImportedAsset(constructionAssetForProgress(p))?.id)).not.toContain(undefined);
    expect(constructionAssetForProgress(.7)).not.toBe('rubble');
    expect(constructionAssetForStage('done')).toBe('construction-done');
    expect(constructionAssetForProgress(.3399)).toBe('construction-foundation');
    expect(constructionAssetForProgress(.6699)).toBe('construction-scaffolding');
    expect(constructionAssetForProgress(.9999)).toBe('construction-walls-up');
  });
  it('only exposes supported animation clips, independently of asset identity', () => {
    for (const clip of Object.values(WORKER_POSES)) expect(getImportedAsset('worker')?.clips).toContain(clip);
    for (const clip of Object.values(QUATERNIUS_ROBOT_POSES)) expect(getImportedAsset('robot')?.clips).toContain(clip);
    expect(WORKER_POSES.blocked).toBe('Idle');
    expect(ROBOT_POSES).toEqual(WORKER_POSES);
  });
  it('makes gaps and provenance explicit while keeping all URLs local', () => {
    expect(getImportedAsset('missing')).toBeUndefined();
    expect(PROCEDURAL_ASSET_GAPS.mailbox.assetType).toBe('task-mailbox');
    expect(PROCEDURAL_ASSET_GAPS.plaque.assetType).toBe('session-stele');
    expect(new Set(IMPORTED_ASSETS.map(a=>a.id)).size).toBe(IMPORTED_ASSETS.length);
    for (const asset of IMPORTED_ASSETS) {
      expect(asset.licence).toBe('CC0-1.0');
      expect(asset.url).toMatch(/game\/cc0\/.+\.glb$/);
      expect(asset.url).not.toMatch(/^https?:/);
      expect(asset.source).toMatch(/^https:\/\//);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
