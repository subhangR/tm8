/** Fingerprint every selected source glTF/GLB plus its external buffers/textures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ui=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const raw=process.env.ASSET_SOURCE_ROOT;
if(!raw)throw new Error('ASSET_SOURCE_ROOT required');
const ledger=JSON.parse(await fs.readFile(path.join(ui,'public/game/cc0/LICENSES.json')));
const inputs=new Map();
for(const asset of ledger.assets){
 const file=path.join(raw,asset.sourceFile),data=await fs.readFile(file);
 const json=JSON.parse(path.extname(file)==='.gltf'?data.toString():data.subarray(20,20+data.readUInt32LE(12)).toString());
 const files=[file,...[...(json.buffers??[]),...(json.images??[])].filter(r=>r.uri&&!r.uri.startsWith('data:')).map(r=>path.resolve(path.dirname(file),r.uri))];
 for(const input of files){if(inputs.has(input))continue;const bytes=await fs.readFile(input);inputs.set(input,{path:path.relative(raw,input),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
}
const report={rawRootExample:raw,uniqueInputBytes:[...inputs.values()].reduce((n,x)=>n+x.bytes,0),inputs:[...inputs.values()]};
await fs.writeFile(path.join(ui,'public/game/cc0/SOURCE-INPUTS.json'),JSON.stringify(report,null,2)+'\n');
console.log(`${inputs.size} source files; ${report.uniqueInputBytes} bytes -> ${ledger.totalUniqueBytes} imported bytes`);
