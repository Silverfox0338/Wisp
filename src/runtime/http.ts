import {lookup as dnsLookup,type LookupAddress} from 'node:dns';
import {request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList,isIP,type LookupFunction} from 'node:net';
import {WispError} from '../diagnostics.js';
import {version} from '../version.js';
import {host,isHost,record,type Value} from './interpreter.js';
import {jsonCompatible} from './stdlib.js';

export interface ApiConfig {baseUrl:string;headers:Record<string,string>;query:Record<string,string>;timeoutMs:number;cacheSeconds:number}
export interface HttpConfig {allow:string[];apis:Record<string,ApiConfig>}
export interface HttpRequest {method:string;url:URL;headers:Record<string,string>;body?:string}
export interface HttpReply {status:number;headers:Record<string,string>;body:string}
/** Sends one request without following redirects; the client handles redirects, limits, and errors. */
export type HttpTransport=(request:HttpRequest,signal:AbortSignal)=>Promise<HttpReply>;
export interface HttpLimits {deadline?:number;signal?:AbortSignal}

export const HTTP_MAX_RESPONSE_BYTES=1024*1024;
const MAX_REQUEST_BYTES=65536,MAX_TEXT=65536,DEFAULT_TIMEOUT_MS=8000,MAX_REDIRECTS=3,CONCURRENCY=8,CACHE_ENTRIES=256;
const METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD'];
const FORBIDDEN_HEADERS=new Set(['host','content-length','connection','transfer-encoding','upgrade','te','trailer','keep-alive','proxy-authorization','proxy-connection','expect']);
export const HEADER_NAME=/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

const blocked=new BlockList();
for(const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(network,prefix,'ipv4');
// IPv4 rules also cover IPv4-mapped IPv6 addresses such as ::ffff:7f00:1.
for(const [network,prefix] of [['::',128],['::1',128],['64:ff9b::',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]] as const)blocked.addSubnet(network,prefix,'ipv6');
/** True for loopback, private, link-local, metadata, multicast, and reserved addresses. */
export function isPrivateAddress(address:string):boolean{
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);if(mapped)return blocked.check(mapped[1]!,'ipv4');
  const family=isIP(address);if(!family)return true;
  return blocked.check(address,family===4?'ipv4':'ipv6');
}
function blockedError(target:string):Error{return Object.assign(new Error(`${target} resolves to a private or reserved address`),{code:'WISP_BLOCKED'});}
const guardedLookup=((hostname:string,options:{all?:boolean},callback:(error:Error|null,address:string|LookupAddress[],family?:number)=>void)=>{
  dnsLookup(hostname,{...options,all:true},(error,addresses)=>{
    if(error)return callback(error,'',0);
    if(!addresses.length||addresses.some(item=>isPrivateAddress(item.address)))return callback(blockedError(hostname),'',0);
    if(options.all)return callback(null,addresses);
    callback(null,addresses[0]!.address,addresses[0]!.family);
  });
}) as unknown as LookupFunction;
function flatten(headers:IncomingHttpHeaders):Record<string,string>{const out:Record<string,string>=Object.create(null) as Record<string,string>;for(const [name,value] of Object.entries(headers))if(value!==undefined)out[name]=Array.isArray(value)?value.join(', '):value;return out;}

/** Node transport that connects only to public addresses unless allowPrivate is set (tests only). */
export function createNodeTransport(options:{allowPrivate?:boolean}={}):HttpTransport{return (request,signal)=>new Promise((resolve,reject)=>{
  const literal=request.url.hostname.replace(/^\[|\]$/g,'');
  if(!options.allowPrivate&&isIP(literal)&&isPrivateAddress(literal))return reject(blockedError(literal));
  const send=request.url.protocol==='https:'?httpsRequest:httpRequest;
  const outgoing=send(request.url,{method:request.method,headers:request.headers,signal,...(options.allowPrivate?{}:{lookup:guardedLookup})},response=>{
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>HTTP_MAX_RESPONSE_BYTES){response.destroy();reject(new WispError('HTTP003','Response exceeds 1 MiB'));return;}chunks.push(chunk);});
    response.on('end',()=>resolve({status:response.statusCode??0,headers:flatten(response.headers),body:Buffer.concat(chunks).toString('utf8')}));
    response.on('error',reject);
  });
  outgoing.on('error',reject);
  if(request.body!==undefined)outgoing.write(request.body);
  outgoing.end();
});}

function fail(code:string,message:string):never{throw new WispError(code,message);}
function plainMap(value:Value,label:string):Record<string,Value>{if(!value||typeof value!=='object'||Array.isArray(value)||isHost(value))fail('HTTP001',`${label} must be a map`);return value as Record<string,Value>;}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;}
interface RequestOptions {headers:Record<string,string>;query:Record<string,string>;body?:string;timeoutMs?:number}
function requestOptions(value:Value):RequestOptions{
  const result:RequestOptions={headers:{},query:{}};if(value===null)return result;
  const map=plainMap(value,'Request options');
  for(const key of Object.keys(map))if(!['headers','query','json','body','timeout_ms'].includes(key))fail('HTTP001',`Unknown request option ${key}`);
  if(map.headers!==undefined)for(const [name,item] of Object.entries(plainMap(map.headers,'headers'))){
    if(!HEADER_NAME.test(name)||FORBIDDEN_HEADERS.has(name.toLowerCase()))fail('HTTP001',`Header ${name} cannot be set`);
    if(typeof item!=='string'||item.length>4096||/[\r\n]/.test(item))fail('HTTP001',`Header ${name} must be a single-line string of at most 4096 characters`);
    result.headers[name.toLowerCase()]=item;
  }
  if(map.query!==undefined)for(const [name,item] of Object.entries(plainMap(map.query,'query'))){if(typeof item!=='string'&&typeof item!=='number'&&typeof item!=='boolean')fail('HTTP001',`Query value ${name} must be a string, number, or boolean`);result.query[name]=String(item);}
  if(map.json!==undefined&&map.body!==undefined)fail('HTTP001','Use either json or body, not both');
  if(map.json!==undefined){if(!jsonCompatible(map.json))fail('HTTP001','json must be JSON-compatible');result.body=JSON.stringify(map.json);result.headers['content-type']??='application/json';}
  if(map.body!==undefined){if(typeof map.body!=='string')fail('HTTP001','body must be a string');result.body=map.body;}
  if(result.body!==undefined&&Buffer.byteLength(result.body)>MAX_REQUEST_BYTES)fail('HTTP003','Request body exceeds 64 KiB');
  if(map.timeout_ms!==undefined){const timeout=map.timeout_ms;if(typeof timeout!=='number'||!Number.isInteger(timeout)||timeout<1||timeout>60000)fail('HTTP001','timeout_ms must be an integer from 1 to 60000');result.timeoutMs=timeout;}
  return result;
}
function responseValue(reply:HttpReply):Value{
  let json:Value=null;
  if(/[/+]json\b/i.test(reply.headers['content-type']??'')&&reply.body.trim()){
    let parsed:unknown;try{parsed=JSON.parse(reply.body);}catch{parsed=undefined;}
    if(parsed!==undefined){if(!jsonCompatible(parsed))fail('HTTP003','Response JSON exceeds Wisp limits');json=deepFreeze(parsed) as Value;}
  }
  return record({status:reply.status,ok:reply.status>=200&&reply.status<300,headers:record(reply.headers),text:reply.body.slice(0,MAX_TEXT),truncated:reply.body.length>MAX_TEXT,json}) as Value;
}

/** Shared HTTP client; scripts receive per-invocation `http` and `apis` values from {@link HttpClient.api}. */
export class HttpClient {
  private readonly cache=new Map<string,{expires:number;value:Value}>();
  private readonly active=new Map<string,number>();
  private readonly waiting=new Map<string,(()=>void)[]>();
  constructor(readonly config:HttpConfig={allow:[],apis:{}},private readonly transport:HttpTransport=createNodeTransport()){}
  allowed(url:URL):boolean{return this.config.allow.some(entry=>{const plain=entry.startsWith('http://'),pattern=plain?entry.slice(7):entry;if(url.protocol!=='https:'&&!(plain&&url.protocol==='http:'))return false;const hostname=url.hostname.toLowerCase();return pattern.startsWith('*.')?hostname.endsWith(pattern.slice(1)):hostname===pattern;});}
  api(limits:HttpLimits={}):{http:Value;apis:Value}{
    const verbs=(send:(method:string,target:Value,options:Value)=>Promise<Value>)=>record({
      get:host((target,options=null)=>send('GET',target,options)),post:host((target,options=null)=>send('POST',target,options)),put:host((target,options=null)=>send('PUT',target,options)),patch:host((target,options=null)=>send('PATCH',target,options)),delete:host((target,options=null)=>send('DELETE',target,options)),
      request:host((method,target,options=null)=>{if(typeof method!=='string'||!METHODS.includes(method.toUpperCase()))fail('HTTP001',`Method must be one of ${METHODS.join(', ')}`);return send(method.toUpperCase(),target,options);})
    }) as Value;
    const http=verbs((method,target,options)=>this.send(method,this.rawUrl(target),requestOptions(options),undefined,limits));
    const apis=record(Object.fromEntries(Object.keys(this.config.apis).map(name=>[name,verbs((method,target,options)=>this.send(method,this.apiUrl(name,target),requestOptions(options),name,limits))]))) as Value;
    return {http,apis};
  }
  private rawUrl(target:Value):URL{
    if(typeof target!=='string'||target.length>2048)fail('HTTP001','URL must be a string of at most 2048 characters');
    let url:URL;try{url=new URL(target);}catch{fail('HTTP001','Invalid URL');}
    if(url.protocol!=='https:'&&url.protocol!=='http:')fail('HTTP001','URL must use https');
    if(url.username||url.password)fail('HTTP001','URL must not contain credentials');
    if(!this.allowed(url))throw new WispError('HTTP002',`${url.protocol==='http:'?'Plain HTTP to ':'Host '}${url.hostname} is not allowed; add it to http.allow in wisp.json`,undefined,undefined,undefined,'Prefer a named API under http.apis when the service needs a key.');
    return url;
  }
  private apiUrl(name:string,target:Value):URL{
    if(typeof target!=='string'||target.length>2048)fail('HTTP001','API path must be a string of at most 2048 characters');
    if(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target))fail('HTTP001',`Use a path relative to the ${name} API base URL`);
    const base=new URL(this.config.apis[name]!.baseUrl),path=target.split(/[?#]/)[0]!;
    if(path.split('/').some(part=>{let decoded=part;try{decoded=decodeURIComponent(part);}catch{return true;}return decoded==='.'||decoded==='..';}))fail('HTTP001','API path must not contain . or .. segments');
    const url=new URL(base.href.replace(/\/$/,'')+'/'+target.replace(/^\//,''));
    if(url.origin!==base.origin)fail('HTTP002',`API path escapes the ${name} base URL`);
    return url;
  }
  private acquire(key:string):Promise<()=>void>{
    const release=()=>{const next=this.waiting.get(key)?.shift();if(next)next();else this.active.set(key,(this.active.get(key)??1)-1);};
    const count=this.active.get(key)??0;if(count<CONCURRENCY){this.active.set(key,count+1);return Promise.resolve(release);}
    return new Promise(resolve=>{const queue=this.waiting.get(key)??[];queue.push(()=>resolve(release));this.waiting.set(key,queue);});
  }
  private async send(method:string,url:URL,options:RequestOptions,apiName:string|undefined,limits:HttpLimits):Promise<Value>{
    const api=apiName?this.config.apis[apiName]:undefined;
    for(const [name,value] of Object.entries(options.query))url.searchParams.set(name,value);
    if(api)for(const [name,value] of Object.entries(api.query))url.searchParams.set(name,value);
    const headers:Record<string,string>={'user-agent':`Wisp/${version}`,accept:'application/json, text/plain;q=0.9, */*;q=0.5',...options.headers};
    if(api)for(const [name,value] of Object.entries(api.headers))headers[name.toLowerCase()]=value;
    if(options.body!==undefined&&(method==='GET'||method==='HEAD'))fail('HTTP001',`${method} requests cannot have a body`);
    const cacheKey=api&&api.cacheSeconds>0&&method==='GET'?`${apiName} ${url.href}`:undefined;
    const cached=cacheKey?this.cache.get(cacheKey):undefined;if(cached&&cached.expires>Date.now())return cached.value;
    const timeout=Math.min(options.timeoutMs??api?.timeoutMs??DEFAULT_TIMEOUT_MS,limits.deadline===undefined?Infinity:limits.deadline-Date.now());
    if(timeout<=0)throw new WispError('HTTP004','Request timed out before it was sent');
    if(limits.signal?.aborted)throw new WispError('RUNTIME007','Execution cancelled');
    const signal=AbortSignal.any([AbortSignal.timeout(timeout),...(limits.signal?[limits.signal]:[])]);
    const release=await this.acquire(apiName??'*');
    try{
      let current:HttpRequest={method,url,headers,body:options.body};
      for(let hop=0;;hop++){
        const reply=await this.transport(current,signal);
        const location=reply.headers.location;
        if([301,302,303,307,308].includes(reply.status)&&location){
          if(hop>=MAX_REDIRECTS)fail('HTTP003',`Too many redirects (more than ${MAX_REDIRECTS})`);
          let next:URL;try{next=new URL(location,current.url);}catch{fail('HTTP003','Invalid redirect location');}
          if(api?next.origin!==current.url.origin:!this.allowed(next))fail('HTTP002',`Redirect to ${next.hostname} is not allowed`);
          const keep=reply.status===307||reply.status===308,nextHeaders={...current.headers};if(!keep)delete nextHeaders['content-type'];
          current={method:keep||current.method==='HEAD'?current.method:'GET',url:next,headers:nextHeaders,body:keep?current.body:undefined};continue;
        }
        const value=responseValue(reply);
        if(cacheKey&&reply.status>=200&&reply.status<300){if(this.cache.size>=CACHE_ENTRIES)this.cache.delete(this.cache.keys().next().value!);this.cache.set(cacheKey,{expires:Date.now()+api!.cacheSeconds*1000,value});}
        return value;
      }
    }catch(error){
      if(error instanceof WispError)throw error;
      if(limits.signal?.aborted)throw new WispError('RUNTIME007','Execution cancelled');
      if(signal.aborted)throw new WispError('HTTP004',`Request timed out after ${timeout} ms`);
      if((error as {code?:unknown}).code==='WISP_BLOCKED')throw new WispError('HTTP002',`Blocked request: ${(error as Error).message}`);
      throw new WispError('HTTP004',`Request failed: ${error instanceof Error?error.message:String(error)}`);
    }finally{release();}
  }
}
