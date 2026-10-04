import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
/** Session-owned Codex home: copy model login only, never inherited connector configuration. */
export async function isolateCodexMcpHome(manifestPath:string,env:Record<string,string>):Promise<void> {
 const source=env.CODEX_HOME || join(env.HOME || homedir(),'.codex');
 const target=join(dirname(manifestPath),'codex');
 await mkdir(target,{recursive:true,mode:0o700});await chmod(target,0o700);
 if(source!==target) {
  try{const auth=await readFile(join(source,'auth.json'));await writeFile(join(target,'auth.json'),auth,{mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(join(target,'auth.json'),{force:true});}
 }
 // Rewrite on resume too: user/model-created ambient connectors cannot persist.
 await writeFile(join(target,'config.toml'),'# tm8 session configuration\n[mcp_servers]\n',{mode:0o600});
 env.CODEX_HOME=target;
}
