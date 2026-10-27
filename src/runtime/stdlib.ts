import {randomInt} from 'node:crypto';
import {WispError} from '../diagnostics.js';
import type {StorageBackend} from '../storage/types.js';
import {dataBag,host,record,type HostFunction,type Value} from './interpreter.js';
function number(value:Value,label:string):number{if(typeof value!=='number'||!Number.isFinite(value))throw new WispError('RUNTIME002',`${label} must be a finite number`);return value;}
function string(value:Value,label:string):string{if(typeof value!=='string')throw new WispError('RUNTIME002',`${label} must be a string`);return value;}
function storageHost(call:HostFunction['call']):HostFunction{return host(async(...args)=>{try{return await call(...args);}catch(error){if(error instanceof WispError)throw error;if(error instanceof Error&&typeof (error as Error&{code?:unknown}).code==='string'&&(error as Error&{code:string}).code.startsWith('ERR_SQLITE_'))throw new WispError('STORAGE006',`SQLite: ${error.message}`);throw error;}});}
export function storageApi(db:StorageBackend,scope:string):Value{return record({
  get:storageHost((key,fallback=null)=>db.get(scope,string(key,'key'),fallback)),
  set:storageHost(async(key,value)=>{await db.set(scope,string(key,'key'),value);return null;}),
  delete:storageHost(async key=>{await db.delete(scope,string(key,'key'));return null;}),
  has:storageHost(key=>db.has(scope,string(key,'key'))),
  increment:storageHost((key,amount=1)=>db.increment(scope,string(key,'key'),number(amount,'amount'))),
  sharedGet:storageHost((key,fallback=null)=>db.get('shared',string(key,'key'),fallback)),
  sharedSet:storageHost(async(key,value)=>{await db.set('shared',string(key,'key'),value);return null;}),
  sharedIncrement:storageHost((key,amount=1)=>db.increment('shared',string(key,'key'),number(amount,'amount')))
}) as Value;}
/** `user.data` / `guild.data`: one storage scope per member or guild. */
export function dataApi(db:StorageBackend,scope:string):Value{return dataBag({
  get:key=>storageHost(()=>db.get(scope,key,null)).call(),
  set:async(key,value)=>{await storageHost(async()=>{await db.set(scope,key,value);return null;}).call();},
  delete:async key=>{await storageHost(async()=>{await db.delete(scope,key);return null;}).call();},
  increment:async(key,amount)=>await storageHost(()=>db.increment(scope,key,amount)).call() as number
});}
/** Scope holding one member's data in one guild. */
export function memberDataScope(guildId:string,userId:string):string{return `data:user:${guildId}:${userId}`;}
/** `guild.data` and `guild.top(field, count)` for one guild. */
export function guildDataApi(db:StorageBackend,guildId:string):{data:Value;top:HostFunction}{return {
  data:dataApi(db,`data:guild:${guildId}`),
  top:storageHost(async(field,count=10)=>{const key=string(field,'field'),limit=number(count,'count');if(!Number.isInteger(limit)||limit<1||limit>100)throw new WispError('RUNTIME002','top count must be 1 to 100');const prefix=memberDataScope(guildId,'');return (await db.top(prefix,key,limit)).map((row,index)=>{const id=row.scope.slice(prefix.length);return record({rank:index+1,id,mention:`<@${id}>`,value:row.value}) as Value;});})
};}
export function mathApi():Value{return record({
  abs:host(v=>Math.abs(number(v,'value'))),floor:host(v=>Math.floor(number(v,'value'))),ceil:host(v=>Math.ceil(number(v,'value'))),round:host(v=>Math.round(number(v,'value'))),
  min:host((...values)=>{if(!values.length)throw new WispError('RUNTIME002','min requires arguments');return Math.min(...values.map(v=>number(v,'argument')));}),
  max:host((...values)=>{if(!values.length)throw new WispError('RUNTIME002','max requires arguments');return Math.max(...values.map(v=>number(v,'argument')));}),
  randomInt:host((min,max)=>{const a=number(min,'min'),b=number(max,'max');if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a>=b)throw new WispError('RUNTIME002','randomInt needs safe integer min < max');return randomInt(a,b);}),
  randomChoice:host(items=>{if(!Array.isArray(items)||!items.length)throw new WispError('RUNTIME002','randomChoice requires a nonempty list');return items[randomInt(items.length)]!;}),
  clamp:host((value,min,max)=>{const v=number(value,'value'),a=number(min,'min'),b=number(max,'max');if(a>b)throw new WispError('RUNTIME002','clamp needs min <= max');return Math.min(b,Math.max(a,v));})
}) as Value;}
function timestamp(value:Value):Date{const date=typeof value==='number'?new Date(number(value,'timestamp')*1000):new Date(string(value,'timestamp'));if(!Number.isFinite(date.valueOf()))throw new WispError('RUNTIME002','Invalid timestamp');return date;}
export function timeApi():Value{return record({
  now:host(()=>new Date().toISOString()),
  iso:host(value=>timestamp(value).toISOString()),
  parse:host(value=>Math.floor(timestamp(value).valueOf()/1000)),
  format:host((value,pattern)=>{const date=timestamp(value),parts:Record<string,string>={YYYY:String(date.getUTCFullYear()).padStart(4,'0'),MM:String(date.getUTCMonth()+1).padStart(2,'0'),DD:String(date.getUTCDate()).padStart(2,'0'),HH:String(date.getUTCHours()).padStart(2,'0'),mm:String(date.getUTCMinutes()).padStart(2,'0'),ss:String(date.getUTCSeconds()).padStart(2,'0')};return string(pattern,'format').replace(/YYYY|MM|DD|HH|mm|ss/g,match=>parts[match]!);}),
  add:host((value,seconds)=>timestamp(timestamp(value).valueOf()/1000+number(seconds,'seconds')).toISOString()),
  diff:host((later,earlier)=>(timestamp(later).valueOf()-timestamp(earlier).valueOf())/1000),
  relative:host((value)=>{const seconds=Math.round((timestamp(value).valueOf()-Date.now())/1000),abs=Math.abs(seconds);const [amount,unit]=abs<60?[abs,'second']:abs<3600?[Math.round(abs/60),'minute']:abs<86400?[Math.round(abs/3600),'hour']:[Math.round(abs/86400),'day'];return seconds<0?`${amount} ${unit}${amount===1?'':'s'} ago`:`in ${amount} ${unit}${amount===1?'':'s'}`;}),
  discord:host((value,style='R')=>{const code=string(style,'style');if(!['t','T','d','D','f','F','R'].includes(code))throw new WispError('RUNTIME002','Invalid Discord timestamp style');return `<t:${Math.floor(timestamp(value).valueOf()/1000)}:${code}>`;}),
  duration:host(value=>{const seconds=number(value,'seconds');if(seconds<0||seconds>1e9)throw new WispError('RUNTIME002','Duration out of range');const total=Math.floor(seconds),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60);return `${hours}h ${minutes}m ${total%60}s`;})
}) as Value;}
export function jsonCompatible(value:unknown,seen=new Set<object>(),depth=0):boolean{
  if(depth>32)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='string')return value.length<=65536;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||seen.has(value))return false;
  seen.add(value);
  const values=Array.isArray(value)?value:Object.values(value);
  const valid=values.length<=10000&&values.every(item=>jsonCompatible(item,seen,depth+1));
  seen.delete(value);
  return valid;
}
export function jsonApi():Value{return record({
  parse:host(value=>{const source=string(value,'JSON text');if(source.length>65536)throw new WispError('RUNTIME007','JSON exceeds 64 KiB');let parsed:Value;try{parsed=JSON.parse(source) as Value;}catch{throw new WispError('RUNTIME002','Invalid JSON');}if(!jsonCompatible(parsed))throw new WispError('RUNTIME007','JSON value exceeds language limits');return parsed;}),
  stringify:host(value=>{if(!jsonCompatible(value))throw new WispError('RUNTIME002','Value is not JSON-compatible');const result=JSON.stringify(value);if(result.length>65536)throw new WispError('RUNTIME007','JSON exceeds 64 KiB');return result;})
}) as Value;}
