import type {Client} from 'discord.js';
import {WispError} from '../diagnostics.js';
import {host,record,type Value} from '../runtime/interpreter.js';
import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,resolve,basename} from 'node:path';

const methods=new Set(['GET','POST','PUT','PATCH','DELETE']);
const routePattern=/^\/[a-z0-9_@%.\-/]+$/i;

function plain(value:Value,label:string):unknown {
  let json:string|undefined;
  if(value===undefined)return null;
  try{json=JSON.stringify(value);}catch{throw new WispError('DISCORD005',`${label} must be JSON-compatible`);}
  if(json===undefined||json.length>1024*1024)throw new WispError('DISCORD005',`${label} exceeds the 1 MiB JSON limit or is not JSON-compatible`);
  return JSON.parse(json) as unknown;
}

export function discordApi(client:Client,projectRoot?:string):Value {
  return record({gateway:host((opcode,data,shardId=0)=>{
    if(typeof opcode!=='number'||![3,4,8,31,43].includes(opcode))throw new WispError('DISCORD005','Gateway opcode must be 3, 4, 8, 31, or 43');
    if(typeof shardId!=='number'||!Number.isSafeInteger(shardId)||shardId<0)throw new WispError('DISCORD005','Shard ID must be a nonnegative integer');
    const shard=client.ws.shards.get(shardId);
    if(!shard)throw new WispError('DISCORD005',`Gateway shard ${shardId} is unavailable`);
    shard.send({op:opcode,d:plain(data,'Gateway payload')});
    return null;
  }),request:host(async(method,path,body=null,query=null,reason=null,files=null)=>{
    if(typeof method!=='string'||!methods.has(method.toUpperCase()))throw new WispError('DISCORD005','Discord method must be GET, POST, PUT, PATCH, or DELETE');
    if(typeof path!=='string'||path.length>2048||!routePattern.test(path)||path.includes('//')||path.split('/').includes('..')||path.split('/').includes('.'))throw new WispError('DISCORD005','Discord path must be a relative /api/v10 route without query or fragment');
    if(path.startsWith('/api/'))throw new WispError('DISCORD005','Pass the versioned API path beginning after /api/v10');
    if(reason!==null&&(typeof reason!=='string'||reason.length>512))throw new WispError('DISCORD005','Audit log reason must be a string of at most 512 characters');
    const uploads:{name:string;data:Buffer}[]=[];
    if(files!==null){
      if(!projectRoot||!Array.isArray(files)||files.length>10)throw new WispError('DISCORD005','Files must be a list of at most 10 project-relative paths');
      const root=await realpath(projectRoot);
      for(const file of files){
        if(typeof file!=='string'||!file||isAbsolute(file)||file.includes('\0'))throw new WispError('DISCORD005','File path must be project-relative');
        const target=resolve(root,file),actual=await realpath(target).catch(()=>{throw new WispError('DISCORD005','Upload file is unavailable');});
        const rel=relative(root,actual);
        if(rel.startsWith('..')||isAbsolute(rel))throw new WispError('DISCORD005','Upload file escapes project root');
        const info=await stat(actual);
        if(!info.isFile()||info.size>25*1024*1024)throw new WispError('DISCORD005','Upload must be a file no larger than 25 MiB');
        uploads.push({name:basename(actual),data:await readFile(actual)});
      }
    }
    const params=new URLSearchParams();
    if(query!==null){const input=plain(query,'Query');if(!input||typeof input!=='object'||Array.isArray(input))throw new WispError('DISCORD005','Query must be a map');for(const [key,value] of Object.entries(input)){if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key))throw new WispError('DISCORD005','Invalid query key');for(const item of Array.isArray(value)?value:[value]){if(item===null||typeof item==='object')throw new WispError('DISCORD005','Query values must be strings, numbers, booleans, or lists of those');params.append(key,String(item));}}}
    const tokenRoute=/^\/(?:interactions|webhooks)\/\d+\/[^/]+(?:\/|$)/.test(path);
    const request={fullRoute:path as `/${string}`,method:method.toUpperCase() as Parameters<Client['rest']['request']>[0]['method'],...(body!==null?{body:plain(body,'Body')}:{ }),...(query!==null?{query:params}:{}),...(reason!==null?{reason}: {}),...(tokenRoute?{auth:false}:{}),...(uploads.length?{files:uploads}:{})};
    try{return plain(await client.rest.request(request) as Value,'Discord response') as Value;}catch(error){if(error instanceof WispError)throw error;const status=error&&typeof error==='object'&&'status' in error?String(error.status):'unknown';throw new WispError('DISCORD005',`Discord API request failed (HTTP ${status})`);}
  })}) as Value;
}
