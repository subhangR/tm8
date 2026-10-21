import { McpSelectionsSchema, mcpServerKey, type McpServerView, type OperationName } from '@tm8/contract';
import { readJsonSource } from '../args.js';
import { assertKnownOptions } from './entity.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

export async function mcpSelectionFlag(cmd:CommandContext) {
  const raw=cmd.options.value('mcp-selections');
  if(raw===undefined)return undefined;
  const parsed=McpSelectionsSchema.safeParse(await readJsonSource(raw));
  if(!parsed.success)throw new CliError('--mcp-selections must be an array of {serverId,credentialId?}; [] disables connectors',EXIT_USAGE);
  return parsed.data;
}
const commands: Array<{path:string[];op:OperationName;param?:string;read?:boolean;space?:boolean;secret?:boolean}> = [
  {path:['server','list'],op:'mcp.servers.list',read:true,space:true},
  {path:['server','get'],op:'mcp.servers.get',read:true,param:'serverId'},
  {path:['server','create'],op:'mcp.servers.create',space:true},
  {path:['server','update'],op:'mcp.servers.update',param:'serverId'},
  {path:['server','delete'],op:'mcp.servers.delete',param:'serverId'},
  {path:['server','import'],op:'mcp.servers.import',space:true},
  {path:['server','request'],op:'mcp.servers.request',space:true},
  {path:['server','test'],op:'mcp.servers.test',param:'serverId'},
  {path:['resolve'],op:'mcp.resolve',space:true},
  {path:['credential','list'],op:'mcp.credentials.list',param:'serverId',read:true},
  {path:['credential','readiness'],op:'mcp.credentials.readiness',param:'credentialId',read:true},
  {path:['credential','create'],op:'mcp.credentials.create',param:'serverId',secret:true},
  {path:['credential','rotate'],op:'mcp.credentials.rotate',param:'credentialId',secret:true},
  {path:['credential','revoke'],op:'mcp.credentials.revoke',param:'credentialId'},
  {path:['credential','share'],op:'mcp.credentials.share',param:'credentialId'},
  {path:['credential','unshare'],op:'mcp.credentials.unshare',param:'credentialId'},
  {path:['oauth','begin'],op:'mcp.oauth.begin',param:'serverId'},
  {path:['oauth','callback'],op:'mcp.oauth.callback',secret:true},
];
const MCP_OP_COMMANDS:CommandModule[]=commands.map(spec=>({path:['mcp',...spec.path],run:async (cmd):Promise<ExitCode>=>{
  assertKnownOptions(cmd,['input','expected-version','mutation-id','limit','cursor','target','credential']);
  const params:Record<string,string>={};
  if(spec.space)params.spaceId=requireSpace(cmd.ctx);
  if(spec.param){const id=cmd.args[0];if(!id)throw new CliError(`${spec.param} is required`,EXIT_USAGE);params[spec.param]=id;}
  const source=cmd.options.value('input');
  if(spec.secret&&(!source||(!source.startsWith('@')&&source!=='-')))throw new CliError('Secret input must use --input @file or --input -; never pass secrets in arguments',EXIT_USAGE);
  let parsed:unknown;
  try { parsed=source===undefined?{}:await readJsonSource(source); } catch (error) {
    if(spec.secret)throw new CliError('Unable to read credential JSON input',EXIT_USAGE);
    throw error;
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new CliError('--input must contain an object',EXIT_USAGE);
  const body:Record<string,unknown>={...parsed};
  if(!spec.read && spec.op!=='mcp.resolve'&&spec.op!=='mcp.oauth.callback'){
    body.clientMutationId=resolveMutationId(cmd.options.value('mutation-id'));
    if(cmd.ctx.actor)body.actorId=cmd.ctx.actor.value;
  }
  const version=cmd.options.value('expected-version');
  if(version!==undefined){const n=Number(version);if(!Number.isInteger(n)||n<1)throw new CliError('--expected-version must be a positive integer',EXIT_USAGE);body.expectedVersion=n;}
  const credential=cmd.options.value('credential');if(credential)body.credentialId=credential;
  const query:Record<string,string>={};
  for(const flag of ['limit','cursor']){const value=cmd.options.value(flag);if(value!==undefined)query[flag]=value;}
  const target=cmd.options.value('target');if(target)query.targetId=target;
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx),spec.op,{params,...(spec.read?{query}:{body})}),data=>JSON.stringify(data,null,2));
  return EXIT_OK;
}}));
const MCP_AUDIT_COMMAND:CommandModule={path:['mcp','audit'],run:async (cmd):Promise<ExitCode>=>{
  // §5.6: Space admins see every call in the Space, members the calls they are the root of.
  const flags:Record<string,string>={session:'sessionId',chat:'chatId',connector:'serverId',member:'memberId',outcome:'outcome',limit:'limit',cursor:'cursor'};
  assertKnownOptions(cmd,Object.keys(flags));
  const query:Record<string,string>={};
  for(const [flag,key] of Object.entries(flags)){const value=cmd.options.value(flag);if(value!==undefined)query[key]=value;}
  cmd.out.data(await observedInvoke(clientFor(cmd.ctx),'mcp.audit.list',{params:{spaceId:requireSpace(cmd.ctx)},query}),data=>JSON.stringify(data,null,2));
  return EXIT_OK;
}};

/**
 * `tm8 mcp catalog list` — the §8.2 connector catalog.
 *
 * Its own module rather than a row in the table above, because the Space is a
 * QUERY parameter here, not a path segment: the catalog is node-level static
 * data, and naming a Space only adds where each entry is already registered
 * there. It is therefore the one `mcp` read that works outside a Space.
 */
async function mcpCatalogList(cmd:CommandContext):Promise<ExitCode> {
  assertKnownOptions(cmd,[]);
  const query:Record<string,string>={};
  // The ambient Space when there is one; never required, so `tm8 mcp catalog
  // list` answers before a caller has chosen a Space at all.
  if(cmd.ctx.space)query.spaceId=cmd.ctx.space.value;
  const data=await observedInvoke<unknown>(clientFor(cmd.ctx),'mcp.catalog.list',{query});
  cmd.out.data(data,renderCatalog);
  return EXIT_OK;
}

function renderCatalog(dto:unknown):string {
  const items=((dto??{}) as {items?:unknown}).items;
  if(!Array.isArray(items)||items.length===0)return 'No connectors in the catalog.';
  return items.map(raw=>{
    const entry=raw as {id?:unknown;title?:unknown;kind?:unknown;available?:unknown;summary?:unknown;requirement?:unknown;added?:unknown};
    const added=Array.isArray(entry.added)?entry.added as Array<{approved?:unknown}>:[];
    const state=entry.available===false?'coming soon'
      :added.length===0?'not added'
      :added.some(a=>a.approved===true)?`added (${added.length})`:'requested';
    return [`${String(entry.id)}  ${String(entry.title)}  [${String(entry.kind)}; ${state}]`,
      `    ${String(entry.summary??'')}`,
      ...(entry.requirement?[`    requires: ${String(entry.requirement)}`]:[])].join('\n');
  }).join('\n');
}

/**
 * `tm8 mcp connect <server-id> [--shared]` — connect an account to a connector.
 *
 * One command over two very different doors, because "connect" is what the user
 * wants and the connector's own `auth` decides which door that is: an API key
 * is a secret this process must never see on a command line, and OAuth is a URL
 * to open in a browser. Reading the connector first is what lets one verb cover
 * both, so it is deliberately a composite rather than a table row.
 */
async function mcpConnect(cmd:CommandContext):Promise<ExitCode> {
  assertKnownOptions(cmd,['input','shared','mutation-id','label']);
  const serverId=cmd.args[0];
  if(!serverId)throw new CliError('serverId is required',EXIT_USAGE);
  const shared=cmd.options.bool('shared');
  const client=clientFor(cmd.ctx);
  const server=await observedInvoke<McpServerView>(client,'mcp.servers.get',{params:{serverId},query:{}});
  const definition=server?.definition;
  if(!definition)throw new CliError('MCP connector is unavailable',EXIT_USAGE);
  const label=cmd.options.value('label')??`${mcpServerKey(definition)} account`;
  if(definition.auth.type==='none'){
    throw new CliError(`${definition.name} needs no connection: it declares no authentication`,EXIT_USAGE);
  }
  if(definition.auth.type==='api_key'){
    const source=cmd.options.value('input');
    if(!source||(!source.startsWith('@')&&source!=='-')){
      throw new CliError('An API key connector needs --input @file or --input -; never pass secrets in arguments',EXIT_USAGE);
    }
    let parsed:unknown;
    try{parsed=await readJsonSource(source);}catch{throw new CliError('Unable to read credential JSON input',EXIT_USAGE);}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new CliError('--input must contain an object',EXIT_USAGE);
    const body:Record<string,unknown>={label,...parsed,clientMutationId:resolveMutationId(cmd.options.value('mutation-id')),
      scope:shared?'space':'member'};
    if(cmd.ctx.actor)body.actorId=cmd.ctx.actor.value;
    const data=await observedInvoke<unknown>(client,'mcp.credentials.create',{params:{serverId},body});
    cmd.out.data(data,()=>`Connected ${definition.name}${shared?' for the whole Space':''}.`);
    return EXIT_OK;
  }
  // OAuth. `scope` belongs to the durable pending-state table (§5.4), and 342
  // (#1315) added it, so a scope chosen here survives the redirect and `--shared`
  // asks for a SPACE credential below. The shape probe that guarded this before
  // 342 landed is gone rather than left dead: it could no longer fire.
  const body:Record<string,unknown>={label,clientMutationId:resolveMutationId(cmd.options.value('mutation-id')),
    ...(shared?{scope:'space'}:{})};
  if(cmd.ctx.actor)body.actorId=cmd.ctx.actor.value;
  const data=await observedInvoke<unknown>(client,'mcp.oauth.begin',{params:{serverId},body});
  cmd.out.data(data,dto=>{
    const begun=(dto??{}) as {authorizationUrl?:unknown;expiresAt?:unknown};
    return [`Open this URL in a browser signed in to tm8 to finish connecting ${definition.name}:`,
      String(begun.authorizationUrl??'(no authorization url returned)'),
      ...(begun.expiresAt?[`The link expires at ${String(begun.expiresAt)}.`]:[])].join('\n');
  });
  return EXIT_OK;
}

/**
 * The table-driven one-operation commands, plus the two composites: `catalog
 * list`, whose Space rides the query, and `connect`, which chooses its door
 * from the connector it reads first.
 */
/**
 * The table-driven one-operation commands, plus `audit` (§5.6) and the two
 * composites: `catalog list`, whose Space rides the query, and `connect`,
 * which chooses its door from the connector it reads first.
 */
export const MCP_COMMANDS:CommandModule[]=[
  ...MCP_OP_COMMANDS,
  MCP_AUDIT_COMMAND,
  {path:['mcp','catalog','list'],run:mcpCatalogList},
  {path:['mcp','connect'],run:mcpConnect},
];
