import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
/** Trusted local connector code sees its injected key. No model/provider env is inherited. */
export async function mcpStdio(input:{command:string;args:string[];env:Record<string,string>;method:string;params:Record<string,unknown>;beforeSend:()=>Promise<void>}):Promise<unknown> {
 await input.beforeSend();
 const child=spawn(input.command,input.args,{shell:false,env:{PATH:process.env.PATH??'/usr/bin:/bin',...input.env},stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
 let size=0;let nextId=0;
 const waiting=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 const fail=()=>{for(const waiter of waiting.values())waiter.reject(new Error('MCP subprocess unavailable'));waiting.clear();child.kill('SIGKILL');};
 child.on('error',fail);child.on('exit',fail);
 child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024)fail();});
 child.stderr.on('data',()=>{}); // Never surface arbitrary subprocess output containing injected secrets.
 lines.on('line',line=>{try{const message=JSON.parse(line) as {id:number;result?:unknown;error?:unknown};const waiter=waiting.get(message.id);if(!waiter)return;waiting.delete(message.id);if(message.error)waiter.reject(new Error('MCP subprocess request failed'));else waiter.resolve(message.result);}catch{fail();}});
 const timer=setTimeout(fail,15000);
 const rpc=async(method:string,params:Record<string,unknown>)=>{
  await input.beforeSend();const id=++nextId;
  return new Promise<unknown>((resolve,reject)=>{waiting.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error)fail();});});
 };
 try {
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'tm8',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return await rpc(input.method,input.params);
 }finally{clearTimeout(timer);lines.close();child.kill('SIGKILL');}
}
