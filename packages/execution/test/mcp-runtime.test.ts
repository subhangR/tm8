import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateCodexMcpHome } from '../src/spawn/mcp-home.js';
import { connectorBridgeConfig, connectorManifestRecord } from '../src/spawn/manifest.js';
let dir:string|undefined;
afterEach(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
it('isolates Codex connector config per session and re-clears it on resume',async()=>{
 dir=await mkdtemp(join(tmpdir(),'mcp-home-'));const source=join(dir,'source');await mkdir(source);await writeFile(join(source,'auth.json'),'{"fixture":"login"}');await writeFile(join(source,'config.toml'),'model="fixture-model"\n[model_providers.fixture]\nname="Fixture"\n[mcp_servers.ambient]\ncommand="untrusted"');
 const first={CODEX_HOME:source};const second={CODEX_HOME:source};
 await isolateCodexMcpHome(join(dir,'first.json'),first);await isolateCodexMcpHome(join(dir,'second.json'),second);
 expect(first.CODEX_HOME).not.toBe(second.CODEX_HOME);expect(await readFile(join(first.CODEX_HOME,'config.toml'),'utf8')).toContain('fixture-model');expect(await readFile(join(first.CODEX_HOME,'config.toml'),'utf8')).not.toContain('ambient');
 expect(await readFile(join(source,'config.toml'),'utf8')).toContain('ambient');
 await writeFile(join(first.CODEX_HOME,'config.toml'),'[mcp_servers.injected]');await isolateCodexMcpHome(join(dir,'first.json'),first);
 expect(await readFile(join(first.CODEX_HOME,'config.toml'),'utf8')).not.toContain('injected');
});
it('generates only connector references and explicitly empty selection disables connectors',()=>{
 const id='00000000-0000-4000-8000-000000000001';expect(connectorBridgeConfig([])).toEqual({});
 const result=JSON.stringify(connectorBridgeConfig([{serverId:id,credentialId:'credential-reference'}]));expect(result).toContain('--connector');expect(result).not.toContain('credential-reference');
 expect(()=>connectorBridgeConfig([{serverId:'$(echo canary)'}])).toThrow();
});

describe('readable bridge entry names (§4.2, G8)', () => {
 const gmail='00000000-0000-4000-8000-00000000000a', figma='00000000-0000-4000-8000-00000000000b';
 it('names each entry by its server key, so the model reads mcp__gmail__search_messages',()=>{
  const config=connectorBridgeConfig([{serverId:gmail,serverKey:'gmail'},{serverId:figma,serverKey:'figma'}]);
  expect(Object.keys(config).sort()).toEqual(['figma','gmail']);
  // `--connector <id>` stays a UUID: the readable name is the ENTRY name only.
  expect(config['gmail']!.args.slice(-2)).toEqual(['--connector',gmail]);
 });
 it('keeps the opaque name when no resolver named the selection',()=>{
  expect(Object.keys(connectorBridgeConfig([{serverId:gmail}]))).toEqual(['connector_0000000000004000800000000000000a']);
 });
 it('gives two connectors whose keys collide distinct entries',()=>{
  const config=connectorBridgeConfig([{serverId:figma,serverKey:'gmail'},{serverId:gmail,serverKey:'gmail'}]);
  expect(Object.keys(config).sort()).toEqual(['gmail','gmail_2']);
  // The lower id keeps the bare key whichever order the selection arrived in.
  expect(config['gmail']!.args.slice(-1)).toEqual([gmail]);
 });
 it('records the key -> id map for the manifest, sorted and without credentials',()=>{
  const record=connectorManifestRecord([{serverId:figma,serverKey:'figma',credentialId:'cred'},{serverId:gmail,serverKey:'gmail'}]);
  expect(record).toEqual([{serverKey:'figma',serverId:figma},{serverKey:'gmail',serverId:gmail}]);
  expect(JSON.stringify(record)).not.toContain('cred');
  expect(connectorManifestRecord(undefined)).toEqual([]);
 });
});
