import { parse, stringify } from '@iarna/toml';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
/**
 * The CODEX_HOME a session's child actually runs with, derived from its
 * manifest path the same way `isolateCodexMcpHome` creates it. Codex writes
 * the session's rollouts under `<this>/sessions`, so resume and the
 * transcript readers must look here; recording the pre-isolation home instead
 * names a directory the child never wrote to.
 */
export function codexMcpHomeFor(manifestPath:string):string {
 return join(dirname(manifestPath),'mcp-homes',basename(manifestPath,'.json'),'codex');
}
const SESSION_UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `codexMcpHomeFor` from a data dir and session id; null for a non-uuid id, so no caller can steer it outside the data dir. */
export function codexSessionHome(dataDir:string,sessionId:string):string|null {
 if(!SESSION_UUID_RE.test(sessionId))return null;
 return codexMcpHomeFor(join(dataDir,'manifests',`${sessionId}.json`));
}
/** Session-owned Codex home: copy model login only, never inherited connector configuration. */
export async function isolateCodexMcpHome(manifestPath:string,env:Record<string,string>):Promise<void> {
 const source=env.CODEX_HOME || join(env.HOME || homedir(),'.codex');
 const target=codexMcpHomeFor(manifestPath);
 await mkdir(target,{recursive:true,mode:0o700});await chmod(target,0o700);
 if(source!==target) {
  try{const auth=await readFile(join(source,'auth.json'));await writeFile(join(target,'auth.json'),auth,{mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(join(target,'auth.json'),{force:true});}
 }
 // Preserve model/provider and runtime preferences while clearing connector tables at every level.
 let config:ReturnType<typeof parse>={};
 try {config=parse(await readFile(join(source,'config.toml'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Codex configuration could not be isolated');}
 const clearConnectors=(value:unknown):void=>{
  if(!value || typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)clearConnectors(item);return;}
  const record=value as Record<string,unknown>;
  delete record.mcp_servers;
  for(const item of Object.values(record))clearConnectors(item);
 };
 clearConnectors(config);config.mcp_servers={};
 await writeFile(join(target,'config.toml'),stringify(config),{mode:0o600});
 env.CODEX_HOME=target;
}
