import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { resolvePublicAddresses } from '@tm8/mcp';

export interface McpHttpResult { status: number; headers: Record<string,string>; body: string }
export interface McpHttpInput { url: string; method: 'GET'|'POST'|'DELETE'; headers?: Record<string,string>; body?: string }
/** Policy must come from the approved definition, never request input. */
export async function mcpHttp(input: McpHttpInput, allowPrivateNetwork = false): Promise<McpHttpResult> {
  const url = new URL(input.url);
  if (url.username || url.password || url.hash || !['https:','http:'].includes(url.protocol) || (!allowPrivateNetwork && url.protocol!=='https:')) throw new Error('MCP endpoint refused');
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  const addresses = allowPrivateNetwork
    ? isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await lookup(hostname,{all:true})
    : await resolvePublicAddresses(url,{protocols:['https:']});
  const address = addresses[0];
  if (!address) throw new Error('MCP endpoint refused');
  const pinned: LookupFunction = (_host,options,cb) => {
    if (options.all) (cb as unknown as (err:null, rows: typeof addresses)=>void)(null,[address]);
    else cb(null,address.address,address.family);
  };
  return new Promise((resolve,reject) => {
    let complete = false;
    const fail = () => { if (!complete) { complete=true; reject(new Error('MCP endpoint unavailable')); } };
    const req = (url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:input.method,headers:input.headers,lookup:pinned,agent:false},res=>{
      const chunks: Buffer[]=[]; let size=0;
      res.on('data',(chunk: Buffer)=>{ size+=chunk.length; if(size>2*1024*1024) { fail();req.destroy(); } else chunks.push(chunk); });
      res.on('error',fail);
      res.on('end',()=>{
        clearTimeout(timer);
        if(complete)return;
        complete=true;
        const status=res.statusCode??502;
        // Never forward credentials to a redirect destination.
        if(status>=300 && status<400) { reject(new Error('MCP endpoint redirect refused'));return; }
        const headers: Record<string,string>={};
        for(const name of ['content-type','mcp-session-id','www-authenticate']) {const value=res.headers[name];if(typeof value==='string')headers[name]=value;}
        resolve({status,headers,body:Buffer.concat(chunks).toString('utf8')});
      });
    });
    const timer=setTimeout(()=>{fail();req.destroy();},15000);
    req.on('error',()=>{clearTimeout(timer);fail();});
    if(input.body) req.write(input.body);
    req.end();
  });
}
