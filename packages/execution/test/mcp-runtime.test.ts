import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateCodexMcpHome } from '../src/spawn/mcp-home.js';
import { connectorBridgeConfig } from '../src/spawn/manifest.js';
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
