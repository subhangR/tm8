/** Offline repeatable conversion. Raw sources stay outside public and outside git.
 * ASSET_TOOL_ROOT=/scratch/pipeline ASSET_SOURCE_ROOT=/scratch/raw node import.mjs
 * Tools: @gltf-transform/{core,functions,extensions}, sharp. No app dependency upgrades.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require = createRequire(path.join(process.env.ASSET_TOOL_ROOT, 'package.json'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { dedup, prune, weld, resample, textureCompress, meshopt } = require('@gltf-transform/functions');
const sharp = require('sharp');
const { GLTFLoader } = await import(require.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
const { Box3 } = await import(require.resolve('three'));
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width:128, height:128, close(){} });
const { MeshoptEncoder, MeshoptDecoder } = await import(require.resolve('meshoptimizer'));
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const raw = process.env.ASSET_SOURCE_ROOT;
if (!raw) throw new Error('ASSET_SOURCE_ROOT required');
const output = path.join(ui, 'public/game/cc0');
await fs.mkdir(path.join(output, 'licences'), { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const kay = 'kaykit/addons/kaykit_medieval_hexagon_pack/Assets/gltf/';
const ken = 'kenney/Models/GLB format/';
const sources = {
 kaykit: { creator: 'Kay Lousberg', page: 'https://kaylousberg.itch.io/kaykit-medieval-hexagon', download: 'https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0', revision: '84fa4e91af6a88989be7c99e0891cede11f2ca38', licenceFile: 'kaykit/LICENSE.txt' },
 characters: { creator: 'Kay Lousberg', page: 'https://kaylousberg.itch.io/kaykit-adventurers', download: 'https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0', revision: '672074b73ba276876a19e8816ecdc5241817ab47', licenceFile: 'kaykit-characters/LICENSE.txt' },
 kenney: { creator: 'Kenney', page: 'https://kenney.nl/assets/fantasy-town-kit', download: 'https://kenney.nl/media/pages/assets/fantasy-town-kit/efe948d309-1754222374/kenney_fantasy-town-kit_2.0.zip', licenceFile: 'kenney/License.txt' },
 quaternius: { creator: 'Quaternius / Tomas Laulhe', page: 'https://quaternius.com/packs/animatedrobot.html', download: 'https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/models/gltf/RobotExpressive/RobotExpressive.glb', revision: 'three.js r180', licenceFile: 'README.md' },
};
// [semantic id, source relative path, creator pack, explicit adaptation]
const selection = [
 ['terrain-grass', kay+'tiles/base/hex_grass.gltf', 'kaykit'],
 ['path-straight', kay+'tiles/roads/hex_road_A.gltf', 'kaykit'],
 ['path-crossing', kay+'tiles/roads/hex_road_M.gltf', 'kaykit'],
 ['tree', kay+'decoration/nature/tree_single_A.gltf', 'kaykit'],
 ['tree-pine', kay+'decoration/nature/tree_single_B.gltf', 'kaykit'],
 ['rock', ken+'rock-small.glb', 'kenney'],
 ['gate', kay+'buildings/neutral/wall_straight_gate.gltf', 'kaykit'],
 ['hub', kay+'buildings/green/building_castle_green.gltf', 'kaykit'],
 ['office', kay+'buildings/blue/building_tavern_blue.gltf', 'kaykit', 'Fantasy tavern reused as team office.'],
 ['library', kay+'buildings/blue/building_church_blue.gltf', 'kaykit', 'Tall reading-hall silhouette reused for Library; labels identify domain role.'],
 ['code-factory', kay+'buildings/red/building_blacksmith_red.gltf', 'kaykit', 'Blacksmith reused as fantasy Code Factory.'],
 ['task-building', kay+'buildings/green/building_home_A_green.gltf', 'kaykit'],
 ['task-building-blue', kay+'buildings/blue/building_home_B_blue.gltf', 'kaykit'],
 ['task-building-yellow', kay+'buildings/yellow/building_home_A_yellow.gltf', 'kaykit'],
 ['construction-lot', kay+'buildings/neutral/building_dirt.gltf', 'kaykit'],
 ['construction-foundation', kay+'buildings/neutral/building_stage_A.gltf', 'kaykit'],
 ['construction-scaffolding', kay+'buildings/neutral/building_scaffolding.gltf', 'kaykit'],
 ['construction-walls-up', kay+'buildings/neutral/building_stage_B.gltf', 'kaykit'],
 ['construction-topped-out', kay+'buildings/neutral/building_stage_C.gltf', 'kaykit'],
 ['construction-done', kay+'buildings/green/building_home_A_green.gltf', 'kaykit'],
 ['rubble', kay+'buildings/neutral/building_destroyed.gltf', 'kaykit', 'Cancelled only. Never select this for blocked or waiting.'],
 ['robot', 'RobotExpressive.glb', 'quaternius', 'Fallback robot only; preferred worker is the KayKit recoloured humanoid. No hammer/carry animation supplied.'],
 ['worker', 'kaykit-characters/addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb', 'characters', 'Knight recoloured blue-grey for workshop crew; sword/shield/cape meshes removed. Retains original skin and 8 useful clips; Interact/Use_Item stand in for work, no dedicated hammer clip.'],
 ['desk', ken+'stall-bench.glb', 'kenney', 'Wooden market workbench reused as a desk.'],
 ['cart', ken+'cart.glb', 'kenney'],
 ['shipping-yard', kay+'buildings/yellow/building_market_yellow.gltf', 'kaykit', 'Market loading stand reused as Shipping Yard; add cart/crate instances.'],
 ['crate', kay+'decoration/props/crate_A_big.gltf', 'kaykit'],
 ['fence', kay+'buildings/neutral/fence_wood_straight.gltf', 'kaykit'],
];
const manifest = [], ledger = [];
const hash = (data) => createHash('sha256').update(data).digest('hex');
const generated = new Map();
for (const [id, sourceFile, pack, adaptation] of selection) {
 const sourcePath = path.join(raw, sourceFile);
 const sourceData = await fs.readFile(sourcePath);
 let record = generated.get(sourceFile);
 if (!record) {
  const document = await io.read(sourcePath);
  if (id === 'worker') {
   // Keep the humanoid rig; remove weapons/shields/cape so the crew reads as workers.
   for (const node of document.getRoot().listNodes()) if (/Sword|Shield|Knight_Cape/.test(node.getName())) node.setMesh(null);
   const keep = new Set(['Idle','Interact','PickUp','Use_Item','Walking_A','Cheer','Sit_Chair_Idle','Hit_A']);
   for (const clip of document.getRoot().listAnimations()) if (!keep.has(clip.getName())) {
    for (const channel of clip.listChannels()) channel.dispose();
    for (const sampler of clip.listSamplers()) sampler.dispose();
    clip.dispose();
   }
   for (const material of document.getRoot().listMaterials()) material.setBaseColorFactor([.72,.82,.89,1]).setMetallicFactor(.15).setRoughnessFactor(.65);
  }
  // No flatten/join on animated models: all joints, bind matrices and morph targets survive.
  await document.transform(dedup(), weld(), resample(), prune(), textureCompress({ encoder: sharp, targetFormat: 'png', resize: [128,128] }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

  const file = `${id}.glb`;
  const binary = await io.writeBinary(document);
  await fs.writeFile(path.join(output,file), binary);
  // THREE includes skin bind matrices; generic POSITION bounds are wrong for rigged characters.
  const loaded = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(binary.buffer.slice(binary.byteOffset,binary.byteOffset+binary.byteLength), '');
  loaded.scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(loaded.scene);
  const bounds = { min:box.min.toArray(), max:box.max.toArray() };
  const size = bounds.max.map((v,i)=>v-bounds.min[i]);
  const scale = 1 / ((id === 'robot' || id === 'worker') ? size[1] : Math.max(size[0],size[2]));
  record = { file, bytes: binary.length, sha256: hash(binary), bounds, scale, groundOffset: [-(bounds.min[0]+bounds.max[0])/2,-bounds.min[1],-(bounds.min[2]+bounds.max[2])/2], clips: document.getRoot().listAnimations().map(a=>a.getName()) };
  generated.set(sourceFile, record);
 }
 manifest.push({ id, label: id.replaceAll('-',' '), ...record, licence: 'CC0-1.0', source: sources[pack].page, sourceFile, ...(adaptation ? { adaptation } : {}) });
 ledger.push({ id, pack, sourceFile, sourceSha256: hash(sourceData), sourceBytes: sourceData.length, outputFile: 'public/game/cc0/'+record.file, sha256:record.sha256, bytes:record.bytes, licence:'CC0-1.0' });
 console.log(id, record.bytes, record.clips.length+' clips');
}
for (const [key, source] of Object.entries(sources)) {
 const licence = await fs.readFile(path.join(raw,source.licenceFile));
 await fs.writeFile(path.join(output, 'licences', key+'.txt'), licence);
 source.evidence = 'licences/'+key+'.txt'; source.evidenceSha256 = hash(licence);
}
await fs.writeFile(path.join(ui,'src/story/game/imported-assets/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(output,'LICENSES.json'),JSON.stringify({ licence:'CC0-1.0', importedAt:'2026-10-08', sources, assets:ledger, proceduralGaps:{ plaque:'Existing session-stele procedural fallback', mailbox:'Existing task-mailbox procedural fallback' }, totalUniqueBytes:[...generated.values()].reduce((n,a)=>n+a.bytes,0), uniqueModels:generated.size },null,2)+'\n');
