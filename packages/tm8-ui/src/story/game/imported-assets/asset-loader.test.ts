import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEmbeddedGLB, loadGameAsset, readGameAsset } from './asset-loader';
import { getImportedAsset } from './registry';
// Small valid GLB fixture keeps transport tests independent of Node filesystem types.
// The CSP browser check exercises the 27 actual compressed/textured models.
const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'fixture' }] });
const chunk = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
const bytes = new Uint8Array(20 + chunk.length);
const header = new DataView(bytes.buffer);
[0x46546c67, 2, bytes.length, chunk.length, 0x4e4f534a].forEach((value, i) => header.setUint32(i * 4, value, true));
bytes.set(chunk, 20);
const payload = `data:model/gltf-binary;base64,${btoa(String.fromCharCode(...bytes))}`;
const robot = { ...getImportedAsset('robot')!, clips: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('game asset transport', () => {
  it('keeps diagnostic URLs short when the artifact provides embedded payloads', async () => {
    vi.stubGlobal('__TM8_GAME_ASSETS__', { 'robot.glb': payload });
    vi.resetModules();
    const registry = await import('./registry');
    expect(registry.getImportedAsset('robot')?.url).toMatch(/game\/cc0\/robot\.glb$/);
    expect(registry.getImportedAsset('robot')?.embeddedData).toBe(payload);
  });
  it('parses a self-contained GLB from memory without fetching a data URL', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const gltf = await loadGameAsset({ ...robot, embeddedData: payload });
    expect(gltf.animations.map(clip=>clip.name)).toEqual(robot.clips);
    expect(gltf.scene.children.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(new Uint8Array(decodeEmbeddedGLB(payload))).toEqual(new Uint8Array(bytes));
  });
  it('retains the standard URL loading path', async () => {
    vi.stubGlobal('ProgressEvent', class { constructor(public type: string) {} });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes.buffer, { headers: { 'Content-Length': String(bytes.length) } }));
    const gltf = await loadGameAsset({ ...robot, url: 'https://assets.example/robot.glb' });
    expect(gltf.scene.children[0]?.name).toBe('fixture');
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0]![0] as Request).url).toBe('https://assets.example/robot.glb');
  });
  it('shares pending and decoded resources across semantic aliases', async () => {
    const asset = { ...robot, sha256: 'cache-fixture', embeddedData: payload };
    let pending: unknown;
    try { readGameAsset(asset); } catch (value) { pending = value; }
    expect(pending).toBeInstanceOf(Promise);
    expect(() => readGameAsset({ ...asset, id: 'worker' })).toThrow(pending);
    await pending;
    expect(readGameAsset(asset)).toBe(readGameAsset({ ...asset, id: 'worker' }));
  });
  it('reports malformed embedded content without dumping base64 or cause', async () => {
    const error = await loadGameAsset({ ...robot, embeddedData: 'data:model/gltf-binary;base64,'+'A'.repeat(200_000) }).catch(error=>error);
    expect(error.message).toBe('Game asset "robot" could not be loaded (embedded GLB).');
    expect(error.cause).toBeUndefined();
    expect(()=>decodeEmbeddedGLB('data:model/gltf-binary;base64,!')).toThrow('Invalid embedded GLB encoding');
  });
});
