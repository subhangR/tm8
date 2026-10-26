/** ASSET_TOOL_ROOT=/scratch/pipeline node verify.mjs; image pixels are verified in the browser gallery. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(path.join(process.env.ASSET_TOOL_ROOT, 'package.json'));
const { GLTFLoader } = await import(require.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
const { clone } = await import(require.resolve('three/examples/jsm/utils/SkeletonUtils.js'));
const { MeshoptDecoder } = await import(require.resolve('meshoptimizer'));
const { AnimationMixer, Box3 } = await import(require.resolve('three'));
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width:128, height:128, close(){} });
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await fs.readFile(path.join(ui,'src/story/game/imported-assets/manifest.json')));
const ledger = JSON.parse(await fs.readFile(path.join(ui,'public/game/cc0/LICENSES.json')));
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const seen = new Set(); const reports=[];
for (const asset of manifest) {
 assert.equal(asset.licence,'CC0-1.0'); assert(asset.scale > 0); assert(asset.groundOffset.every(Number.isFinite));
 const data = await fs.readFile(path.join(ui,'public/game/cc0',asset.file));
 assert.equal(data.length,asset.bytes); assert.equal(createHash('sha256').update(data).digest('hex'),asset.sha256);
 const json=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
 assert.equal(json.asset.version,'2.0');
 if (asset.id==='worker') assert(!(json.nodes??[]).some(n=>n.mesh!==undefined&&/Sword|Shield|Knight_Cape/.test(n.name??'')), 'Worker retains combat accessory geometry');
 for (const resource of [...(json.buffers??[]),...(json.images??[])]) assert.equal(resource.uri,undefined,'External resource in '+asset.id);
 if (seen.has(asset.file)) continue; seen.add(asset.file);
 const start=performance.now(); const gltf=await loader.parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'');
 assert.deepEqual(gltf.animations.map(a=>a.name),asset.clips);
 gltf.scene.updateMatrixWorld(true);
 const bounds = new Box3().setFromObject(gltf.scene);
 assert(!bounds.isEmpty(),asset.id+' empty geometry');
 // Quantization may introduce small errors; manifest/source normalization must still match decoded scene.
 for (let i=0;i<3;i++) {
  assert(Math.abs(bounds.min.toArray()[i]-asset.bounds.min[i])<.06,asset.id+' min bounds');
  assert(Math.abs(bounds.max.toArray()[i]-asset.bounds.max[i])<.06,asset.id+' max bounds');
 }
 let skins=0, animatedClips=0;
 if (asset.clips.length) {
  const a=clone(gltf.scene),b=clone(gltf.scene); const objects=new Set(); a.traverse(o=>objects.add(o));
  a.traverse(o=>{if(o.isSkinnedMesh){skins++;assert(o.skeleton.bones.every(bone=>objects.has(bone)),'Skeleton clone references original');}});
  assert(skins>0,'Animated asset has no skin');
  for (const animation of gltf.animations) {
   const instance=clone(gltf.scene); const mixer=new AnimationMixer(instance);
   const transforms=()=>{const out=[];instance.traverse(o=>out.push(...o.position.toArray(),...o.quaternion.toArray()));return out;};
   mixer.clipAction(animation).play();mixer.update(0); const before=transforms();mixer.update(Math.min(.37,animation.duration*.35));
   assert(transforms().some((v,i)=>Math.abs(v-before[i])>1e-5),asset.id+' clip not moving: '+animation.name);animatedClips++;
   mixer.stopAllAction();mixer.uncacheRoot(instance);
  }
  assert.notEqual(a.children[0],b.children[0]);
 }
 reports.push({id:asset.id,bytes:data.length,parseMs:Math.round((performance.now()-start)*10)/10,skins,animatedClips});
}
assert.equal(seen.size,ledger.uniqueModels);
assert.equal(reports.reduce((n,a)=>n+a.bytes,0),ledger.totalUniqueBytes);
console.log(JSON.stringify({models:seen.size,semanticAssets:manifest.length,totalBytes:ledger.totalUniqueBytes,reports,note:'Node parse uses image bitmap stub. Browser gallery verifies textures and pixels; parse timings include structural/animation assertions.'},null,2));
