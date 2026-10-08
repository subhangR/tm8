import { TextureLoader } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ImportedAsset } from './registry';

/** Decode locally: fetch(data:) is forbidden by the artifact host's connect-src. */
export function decodeEmbeddedGLB(source: string): ArrayBuffer {
  const prefix = 'data:model/gltf-binary;base64,';
  if (!source.startsWith(prefix)) throw new Error('Invalid embedded GLB encoding');
  let binary: string;
  try { binary = atob(source.slice(prefix.length)); }
  catch { throw new Error('Invalid embedded GLB encoding'); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.byteLength < 20) throw new Error('Invalid embedded GLB header');
  const header = new DataView(bytes.buffer);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== bytes.length) {
    throw new Error('Invalid embedded GLB header');
  }
  return bytes.buffer;
}

/** ImageBitmapLoader fetches blob: URLs (connect-src). TextureLoader instead uses
 * image elements, matching the existing host img-src permission for blob:/data:.
 * Keep GLTFLoader's texture/sampler/colour-space handling and bundled meshopt decode.
 */
function createLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register((parser) => {
    parser.textureLoader = new TextureLoader(parser.options.manager).setCrossOrigin('anonymous');
    return { name: 'TM8_image_element_textures' };
  });
}

export async function loadGameAsset(asset: ImportedAsset): Promise<GLTF> {
  try {
    const loader = createLoader();
    const embedded = asset.embeddedData ?? (asset.url.startsWith('data:') ? asset.url : undefined);
    return embedded
      ? await loader.parseAsync(decodeEmbeddedGLB(embedded), '')
      : await loader.loadAsync(asset.url);
  } catch {
    // Never include a loader error/cause: some THREE errors contain the entire data URL.
    throw new Error(`Game asset "${asset.id}" could not be loaded (${asset.embeddedData || asset.url.startsWith('data:') ? 'embedded GLB' : 'GLB URL'}).`);
  }
}

type Resource = { status: 'pending'; promise: Promise<void> } | { status: 'ready'; gltf: GLTF } | { status: 'failed'; error: Error };
const resources = new Map<string, Resource>();
/** Suspense cache shares decoded geometry/textures. Instances still clone their own skins. */
export function readGameAsset(asset: ImportedAsset): GLTF {
  const key = asset.embeddedData ? `embedded:${asset.sha256}` : asset.url;
  let resource = resources.get(key);
  if (!resource) {
    const promise = loadGameAsset(asset).then(
      (gltf) => { resources.set(key, { status: 'ready', gltf }); },
      (error: Error) => { resources.set(key, { status: 'failed', error }); },
    );
    resource = { status: 'pending', promise };
    resources.set(key, resource);
  }
  if (resource.status === 'pending') throw resource.promise;
  if (resource.status === 'failed') throw resource.error;
  return resource.gltf;
}
