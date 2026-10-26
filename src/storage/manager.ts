import {WispError} from '../diagnostics.js';
import type {ProjectConfig} from '../project/manifest.js';
import {host,record,type Value} from '../runtime/interpreter.js';
import {SqlDatabase,RedisDatabase} from './external.js';
import {Storage} from './sqlite.js';
import type {StorageBackend} from './types.js';

function key(value:Value):string{if(typeof value!=='string'||!value||value.length>256)throw new WispError('STORAGE006','Database key must be 1 to 256 characters');return value;}
function databaseError(error:unknown):WispError{return error instanceof WispError?error:new WispError('STORAGE006',`Database operation failed: ${error instanceof Error?error.message:String(error)}`);}
function safeHost(call:(...args:Value[])=>Value|Promise<Value>){return host(async(...args)=>{try{return await call(...args);}catch(error){throw databaseError(error);}});}
function safeStorage(backend:StorageBackend):StorageBackend{return new Proxy(backend,{get(target,property){const item=Reflect.get(target,property) as unknown;if(typeof item!=='function')return item;return async(...args:unknown[])=>{try{return await (item as (...values:unknown[])=>unknown).apply(target,args);}catch(error){throw databaseError(error);}};}});}
export class DatabaseManager {
  readonly connections=new Map<string,SqlDatabase|RedisDatabase>();
  readonly storage:StorageBackend;
  private readonly rawStorage:StorageBackend;
  private constructor(storage:StorageBackend,connections:Map<string,SqlDatabase|RedisDatabase>){this.rawStorage=storage;this.storage=safeStorage(storage);this.connections=connections;}
  static async open(project:ProjectConfig):Promise<DatabaseManager>{const connections=new Map<string,SqlDatabase|RedisDatabase>();let storage:StorageBackend|undefined;
    try{for(const [name,config] of Object.entries(project.manifest.databases??{})){
      const database=config.engine==='redis'?new RedisDatabase(config.url,`${project.manifest.name}:${name}`):new SqlDatabase(config.engine,config.url);
      connections.set(name,database);await database.connect();
    }
    if('connection' in project.manifest.storage){storage=connections.get(project.manifest.storage.connection);if(!storage)throw new WispError('STORAGE006','Storage connection is unavailable');if(storage instanceof SqlDatabase)await storage.initialize();}
    else storage=new Storage(project.paths.database);
    return new DatabaseManager(storage,connections);
    }catch(error){for(const db of connections.values())await db.close().catch(()=>{});if(storage instanceof Storage)storage.close();throw databaseError(error);}
  }
  api():Value{return record(Object.fromEntries([...this.connections].map(([name,connection])=>[name,connection instanceof SqlDatabase?
    record({sql:safeHost(async(source,params=[])=>{if(typeof source!=='string'||!Array.isArray(params))throw new WispError('STORAGE006','sql requires a query string and parameter list');return record(await connection.sql(source,params)) as Value;})}):
    record({get:safeHost(value=>connection.userGet(key(value))),set:safeHost(async(value,item,ttl=null)=>{await connection.userSet(key(value),item,ttl);return null;}),has:safeHost(value=>connection.userHas(key(value))),delete:safeHost(async value=>{await connection.userDelete(key(value));return null;}),increment:safeHost((value,amount=1)=>{if(typeof amount!=='number')throw new WispError('STORAGE006','Increment amount must be numeric');return connection.userIncrement(key(value),amount);})})]))) as Value;}
  async close():Promise<void>{const all=new Set<StorageBackend>([this.rawStorage,...this.connections.values()]);await Promise.allSettled([...all].map(db=>db.close()));}
}

