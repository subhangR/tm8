/** node inline-artifact.mjs <built-directory>. Run ONLY on a disposable artifact export.
 * Embeds existing exported GLBs as data URLs, injects bootstrap before module execution,
 * removes the binary copies; runtime/source files and licence evidence are unchanged.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir)) throw new Error('Pass an absolute disposable build/export directory');
const models = path.join(dir,'game/cc0');
const filenames=(await fs.readdir(models)).filter(f=>f.endsWith('.glb'));
if (!filenames.length) throw new Error('No exported GLBs found');
const mapping = {};
for (const file of filenames) mapping[file]='data:model/gltf-binary;base64,'+(await fs.readFile(path.join(models,file))).toString('base64');
await fs.writeFile(path.join(dir,'game-cc0-inline.js'),'globalThis.__TM8_GAME_ASSETS__ = '+JSON.stringify(mapping)+';\n');
for (const file of (await fs.readdir(dir)).filter(f=>f.endsWith('.html'))) {
 const target=path.join(dir,file);const html=await fs.readFile(target,'utf8');
 await fs.writeFile(target,html.replace('<head>','<head>\n<script src="./game-cc0-inline.js"></script>'));
}
for (const file of filenames) await fs.unlink(path.join(models,file));
console.log(`Embedded ${filenames.length} GLBs in game-cc0-inline.js; licence evidence retained.`);
