import { createInterface } from 'node:readline';
/** The child knows only a connector id and its existing tm8 session bearer. */
export function serveConnectorBridge(serverId:string,env:NodeJS.ProcessEnv=process.env):void {
  if(!/^[0-9a-f-]{36}$/i.test(serverId))throw new Error('Invalid connector id');
  const token=env.TM8_AGENT_RUNTIME_TOKEN || env.TM8_AGENT_TOKEN;
  const sessionId=env.TM8_SESSION_ID || env.TM8_CHAT_ID;
  if(!token || !sessionId)throw new Error('Connector requires a live tm8 session');
  const base=env.TM8_BASE_URL || 'http://127.0.0.1:4610';
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  let queue=Promise.resolve();
  lines.on('line',line=>{queue=queue.then(async()=>{
    let id:unknown=null;
    try {
      if(Buffer.byteLength(line)>1024*1024)throw new Error();
      const message=JSON.parse(line) as {id?:unknown;method?:string;params?:unknown};id=message.id;
      if(id===undefined)return;
      let result:unknown;
      if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'tm8-connector',version:'1'}};
      else if(message.method==='ping')result={};
      else {
        if(!['tools/list','tools/call'].includes(message.method??''))throw new Error();
        const response=await fetch(`${base}/v2/mcp/sessions/${encodeURIComponent(sessionId)}/servers/${serverId}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({sessionId,serverId,message}),signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error();
        const body=await response.json() as {result?:unknown;data?:unknown};result=body.result??body.data??body;
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
    }catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'MCP connector unavailable; check account and session access'}})+'\n');}
  });});
}
