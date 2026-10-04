import { McpSelectionsSchema, type OperationName } from '@tm8/contract';
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
export const MCP_COMMANDS:CommandModule[]=commands.map(spec=>({path:['mcp',...spec.path],run:async (cmd):Promise<ExitCode>=>{
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
