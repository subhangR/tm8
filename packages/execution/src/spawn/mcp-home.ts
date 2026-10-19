import { parse, stringify } from '@iarna/toml';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile, chmod, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
/** Session-owned Codex home: share the model login, never inherited connector configuration. */
export async function isolateCodexMcpHome(manifestPath:string,env:Record<string,string>):Promise<void> {
 const source=resolve(env.CODEX_HOME || join(env.HOME || homedir(),'.codex'));
 const target=join(dirname(manifestPath),'mcp-homes',basename(manifestPath,'.json'),'codex');
 await mkdir(target,{recursive:true,mode:0o700});await chmod(target,0o700);
 const linked=source!==target && await linkCodexLogin(source,target);
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
 // A keyring entry is keyed by the CODEX_HOME path, so this home could never
 // read the operator's, and `auto` would save a refresh into a new entry under
 // this home's key and delete the linked file: the source would keep the
 // spent refresh token. The login handed over here is a file; keep it one.
 if(linked && (config.cli_auth_credentials_store==='auto' || config.cli_auth_credentials_store==='keyring'))config.cli_auth_credentials_store='file';
 await writeFile(join(target,'config.toml'),stringify(config),{mode:0o600});
 env.CODEX_HOME=target;
}

/*
 * THE LOGIN IS SHARED, NOT COPIED.
 *
 * A ChatGPT login's refresh token is single use. codex-cli (0.153.2, and
 * openai/codex main) refreshes when the access token is within five minutes
 * of expiry (it lives ten days) or on a 401, sends the refresh token to
 * auth.openai.com/oauth/token, and saves the rotated pair into
 * `$CODEX_HOME/auth.json`; the server answers a second use of the old token
 * with `refresh_token_reused`, which Codex treats as terminal ("log out and
 * sign in again"). See codex-rs/login/src/auth/manager.rs
 * (`should_refresh_proactively`, `refresh_token`, `persist_tokens`).
 *
 * A COPY per session therefore broke the login. The first session to refresh
 * kept the only live refresh token in its own copy, while the source, and every
 * session copied from it afterwards, held the spent one: everything worked
 * until the shared access token expired, and then the operator and every new
 * session were logged out.
 *
 * So the session's `auth.json` is a SYMLINK to the source file. That is the
 * layout Codex itself is built for when several processes share one home:
 *   - it saves with open(O_TRUNC|O_CREAT|O_WRONLY) on the path, never a
 *     rename (`FileAuthStorage::save` in auth/storage.rs), so a save follows
 *     the link and lands in the source;
 *   - before refreshing it reloads the file and skips the refresh if another
 *     process already rotated the token (`refresh_token`'s guarded reload),
 *     and a 401 reloads from disk first (`UnauthorizedRecovery`).
 * The operator's own terminals and every session then coordinate through one
 * file, as two Codex terminals on one machine already do.
 *
 * A REGULAR FILE found at the target is a copy from before this change (or a
 * future Codex that saves by rename). If it holds a newer refresh of the same
 * account than the source, it is the only live token, so it is written back
 * into the source before the link replaces it. The source wins every tie.
 *
 * Removing the link (logout, the exit scrub) removes the link, not the source.
 * Nothing here logs or throws a file's contents (I5).
 */
async function linkCodexLogin(source:string,target:string):Promise<boolean> {
 const sourceAuth=join(source,'auth.json');const targetAuth=join(target,'auth.json');
 try{await lstat(sourceAuth);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(targetAuth,{force:true});return false;}
 // Best effort: a salvage that cannot run must not block the launch.
 try{await salvageNewerSessionLogin(sourceAuth,targetAuth);}catch{/* the link below still applies */}
 // Swap the link in by rename so a process that reads the login now sees the
 // old file or the link, never nothing.
 const staged=join(target,`.auth.json.${randomUUID()}`);
 try{
  await symlink(sourceAuth,staged);
 }catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code!=='EPERM' && code!=='ENOTSUP' && code!=='EOPNOTSUPP')throw error;
  // No symlinks on this filesystem (or OS account): the old copy, with the risk above.
  await copyFile(sourceAuth,staged);await chmod(staged,0o600);
 }
 try{await rename(staged,targetAuth);}
 catch(error){await rm(staged,{force:true});throw error;}
 return true;
}

interface LoginFacts { accountId:string; refreshToken:string; lastRefresh:number }

/** What decides which copy is newer; null when the file is not a ChatGPT login. Never throws contents. */
function loginFacts(raw:string):LoginFacts|null {
 let value:unknown;
 try{value=JSON.parse(raw);}catch{return null;}
 if(!value || typeof value!=='object')return null;
 const record=value as Record<string,unknown>;
 const tokens=record.tokens as Record<string,unknown>|undefined|null;
 if(!tokens || typeof tokens!=='object')return null;
 const accountId=tokens.account_id,refreshToken=tokens.refresh_token,lastRefresh=Date.parse(String(record.last_refresh));
 if(typeof accountId!=='string' || !accountId || typeof refreshToken!=='string' || !refreshToken || !Number.isFinite(lastRefresh))return null;
 return {accountId,refreshToken,lastRefresh};
}

async function readIfPresent(path:string):Promise<string|null> {
 try{return await readFile(path,'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}

/**
 * Write a session's regular-file login back into the source when it is a
 * strictly newer refresh of the same account. Serialised per source file in
 * this process and, across tm8 processes on the node, by an exclusive lock
 * file; the source is re-read under the lock, so a newer source always wins.
 * Best effort: anything unexpected leaves the source alone.
 */
async function salvageNewerSessionLogin(sourceAuth:string,targetAuth:string):Promise<void> {
 let stats;
 try{stats=await lstat(targetAuth);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!stats.isFile())return;
 const session=loginFacts(await readFile(targetAuth,'utf8'));
 if(session===null)return;
 // Write through any link the operator keeps at the source path.
 let real:string;
 try{real=await realpath(sourceAuth);}catch{return;}
 await withSourceLock(real,async()=>{
  const current=await readIfPresent(real);
  if(current===null)return; // Logged out since: do not resurrect the login.
  const facts=loginFacts(current);
  if(facts===null || facts.accountId!==session.accountId)return;
  if(facts.refreshToken===session.refreshToken || session.lastRefresh<=facts.lastRefresh)return;
  const staged=`${real}.tm8-${randomUUID()}`;
  try{
   await copyFile(targetAuth,staged);await chmod(staged,0o600);await rename(staged,real);
  }catch{
   await rm(staged,{force:true});
  }
 });
}

const sourceLocks=new Map<string,Promise<void>>();
const LOCK_STALE_MS=30_000;const LOCK_WAIT_MS=5_000;

async function withSourceLock(real:string,work:()=>Promise<void>):Promise<void> {
 const previous=sourceLocks.get(real)??Promise.resolve();
 const run=previous.then(async()=>{
  const lock=`${real}.tm8-lock`;
  const deadline=Date.now()+LOCK_WAIT_MS;
  for(;;){
   try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});break;}
   catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')return;
    const held=await lstat(lock).catch(()=>null);
    if(held && Date.now()-held.mtimeMs>LOCK_STALE_MS){await rm(lock,{force:true});continue;}
    if(Date.now()>deadline)return; // Another writer is busy: leave the source to it.
    await new Promise((done)=>setTimeout(done,25));
   }
  }
  try{await work();}finally{await rm(lock,{force:true});}
 });
 const settled=run.catch(()=>undefined);
 sourceLocks.set(real,settled);
 try{await run;}finally{if(sourceLocks.get(real)===settled)sourceLocks.delete(real);}
}
