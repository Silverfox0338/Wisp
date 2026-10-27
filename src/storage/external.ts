import {Pool as PgPool,type PoolClient} from 'pg';
import mysql,{type Pool as MysqlPool,type PoolConnection as MysqlConnection} from 'mysql2/promise';
import {createClient,type RedisClientType} from 'redis';
import {WispError} from '../diagnostics.js';
import type {Value} from '../runtime/interpreter.js';
import type {ComponentOwner,ComponentState,StorageBackend,StorageSnapshot,TaskRow,TopRow} from './types.js';

export type ExternalEngine='postgres'|'mysql'|'redis';
export interface ConnectionConfig {engine:ExternalEngine;url:string}
export type SqlResult={rows:Record<string,Value>[];affected:number};

export function validateValue(value:unknown,depth=0,seen=new Set<object>()):asserts value is Value{
  if(depth>32)throw new WispError('STORAGE006','Database value exceeds nesting limit');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='string'&&value.length<=65536)return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(typeof value!=='object'||seen.has(value))throw new WispError('STORAGE006','Database value must be JSON-compatible');
  seen.add(value);
  const entries=Array.isArray(value)?value:Object.values(value);
  if(entries.length>10000)throw new WispError('STORAGE006','Database value has too many items');
  for(const item of entries)validateValue(item,depth+1,seen);
  seen.delete(value);
}
function encode(value:Value):string{validateValue(value);const result=JSON.stringify(value);if(result.length>65536)throw new WispError('STORAGE006','Database value exceeds 64 KiB');return result;}
function decode(value:string):Value{try{const parsed=JSON.parse(value) as Value;validateValue(parsed);return parsed;}catch{throw new WispError('STORAGE006','Stored database value is invalid JSON');}}
function converted(value:unknown):Value{
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='bigint')return value.toString();
  if(Buffer.isBuffer(value))return value.toString('base64');
  if(Array.isArray(value))return value.map(converted);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,converted(item)]));
  validateValue(value);return value;
}

/** Count parameter markers and translate PostgreSQL markers outside SQL literals/comments. */
export function sqlParameters(source:string,engine:'postgres'|'mysql'):{text:string;count:number}{
  if(!source.trim()||source.length>65536)throw new WispError('STORAGE006','SQL must be nonempty and at most 64 KiB');
  let text='',count=0,statementEnds=0,state:'normal'|'single'|'double'|'backtick'|'line'|'block'|'dollar'='normal',tag='',backslashQuotes=false;
  for(let i=0;i<source.length;i++){
    const c=source[i]!,next=source[i+1];
    if(state==='normal'){
      if(c==="'"){backslashQuotes=engine==='mysql'||/[eE]/.test(source[i-1]??'')&&!/[a-zA-Z0-9_]/.test(source[i-2]??'');state='single';text+=c;continue;}if(c==='"'){state='double';text+=c;continue;}if(c==='`'){state='backtick';text+=c;continue;}
      if(c==='-'&&next==='-'){state='line';text+='--';i++;continue;}if(c==='#'&&engine==='mysql'){state='line';text+=c;continue;}
      if(c==='/'&&next==='*'){state='block';text+='/*';i++;continue;}
      if(c==='$'&&engine==='postgres'){const match=/^\$[a-zA-Z_0-9]*\$/.exec(source.slice(i));if(match){tag=match[0];state='dollar';text+=tag;i+=tag.length-1;continue;}}
      if(c===';'){statementEnds++;if(source.slice(i+1).replace(/(?:--[^\n]*|\/\*[\s\S]*?\*\/|\s)/g,'').length)throw new WispError('STORAGE006','Only one SQL statement is allowed');text+=c;continue;}
      if(c==='?'){if(next==='?'&&engine==='postgres'){text+='?';i++;continue;}count++;text+=engine==='postgres'?`$${count}`:'?';continue;}
    }else if((state==='single'&&backslashQuotes||engine==='mysql'&&(state==='double'||state==='backtick'))&&c==='\\'&&next!==undefined){text+=c+next;i++;continue;}
    else if(state==='single'&&c==="'"){if(next==="'"){text+="''";i++;continue;}state='normal';}
    else if(state==='double'&&c==='"'){if(next==='"'){text+='""';i++;continue;}state='normal';}
    else if(state==='backtick'&&c==='`'){if(next==='`'){text+='``';i++;continue;}state='normal';}
    else if(state==='line'&&c==='\n')state='normal';
    else if(state==='block'&&c==='*'&&next==='/'){text+='*/';i++;state='normal';continue;}
    else if(state==='dollar'&&source.startsWith(tag,i)){text+=tag;i+=tag.length-1;state='normal';continue;}
    text+=c;
  }
  if(['single','double','backtick','block','dollar'].includes(state))throw new WispError('STORAGE006','Unterminated SQL literal or comment');
  if(statementEnds>1)throw new WispError('STORAGE006','Only one SQL statement is allowed');
  return {text,count};
}
type SqlConnection=PoolClient|MysqlConnection;
export class SqlDatabase implements StorageBackend {
  private readonly pg?:PgPool;private readonly my?:MysqlPool;
  constructor(readonly engine:'postgres'|'mysql',url:string){if(engine==='postgres')this.pg=new PgPool({connectionString:url,max:10,connectionTimeoutMillis:5000,query_timeout:10000});else this.my=mysql.createPool({uri:url,connectionLimit:10,connectTimeout:5000});}
  private async raw(sql:string,params:unknown[]=[],connection?:SqlConnection):Promise<SqlResult>{
    const query=sqlParameters(sql,this.engine);if(query.count!==params.length)throw new WispError('STORAGE006',`SQL expects ${query.count} parameters`);
    const driverParams=params.map(value=>value!==null&&typeof value==='object'?JSON.stringify(value):value);
    try{
      if(this.pg){const result=await (connection as PoolClient|undefined??this.pg).query(query.text,driverParams);return {rows:(result.rows as unknown[]).map(row=>converted(row) as Record<string,Value>),affected:result.rowCount??0};}
      const [rows]=await (connection as MysqlConnection|undefined??this.my!).execute(query.text,driverParams as (string|number|boolean|null)[]);
      if(Array.isArray(rows))return {rows:rows.map(row=>converted(row) as Record<string,Value>),affected:rows.length};
      return {rows:[],affected:'affectedRows' in rows?Number(rows.affectedRows):0};
    }catch(error){if(error instanceof WispError)throw error;throw new WispError('STORAGE006',`${this.engine} database operation failed: ${error instanceof Error?error.message:String(error)}`);}
  }
  async sql(source:string,params:Value[]=[]):Promise<SqlResult>{if(!Array.isArray(params)||params.length>1000)throw new WispError('STORAGE006','SQL parameters must be a list of at most 1000 values');for(const param of params)validateValue(param);const result=await this.raw(source,params);if(result.rows.length>10000||JSON.stringify(result.rows).length>1024*1024)throw new WispError('STORAGE006','SQL result exceeds Wisp limits');for(const row of result.rows)validateValue(row);return result;}
  private async transaction<T>(run:(connection:SqlConnection)=>Promise<T>):Promise<T>{
    const connection=this.pg?await this.pg.connect():await this.my!.getConnection();
    try{await this.raw('BEGIN',[],connection);const value=await run(connection);await this.raw('COMMIT',[],connection);return value;}
    catch(error){await this.raw('ROLLBACK',[],connection).catch(()=>{});throw error;}
    finally{connection.release();}
  }
  async connect():Promise<void>{await this.raw('SELECT 1');}
  async initialize():Promise<void>{
    const json=this.engine==='postgres'?'TEXT':'LONGTEXT',id='VARCHAR(256)';
    await this.raw(`CREATE TABLE IF NOT EXISTS wisp_kv (scope ${id} NOT NULL, key_name ${id} NOT NULL, json_value ${json} NOT NULL, PRIMARY KEY(scope,key_name))`);
    await this.raw(`CREATE TABLE IF NOT EXISTS wisp_components (id ${id} PRIMARY KEY, kind ${id} NOT NULL, name ${id} NOT NULL, guild_id ${id} NOT NULL, owner_id ${id}, expires_at BIGINT NOT NULL, state_json ${json} NOT NULL${this.engine==='mysql'?', INDEX wisp_components_expiry (expires_at)':''})`);
    if(this.engine==='postgres')await this.raw('CREATE INDEX IF NOT EXISTS wisp_components_expiry ON wisp_components(expires_at)');
    if(this.engine==='postgres'){for(const column of ['message_id','channel_id'])await this.raw(`ALTER TABLE wisp_components ADD COLUMN IF NOT EXISTS ${column} ${id}`);for(const column of ['message_id','channel_id','guild_id'])await this.raw(`CREATE INDEX IF NOT EXISTS wisp_components_${column} ON wisp_components(${column})`);}
    else if(!(await this.raw("SELECT 1 AS found FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wisp_components' AND COLUMN_NAME='message_id'")).rows.length)await this.raw(`ALTER TABLE wisp_components ADD COLUMN message_id ${id}, ADD COLUMN channel_id ${id}, ADD INDEX wisp_components_message_id (message_id), ADD INDEX wisp_components_channel_id (channel_id), ADD INDEX wisp_components_guild_id (guild_id)`);
    await this.raw(`CREATE TABLE IF NOT EXISTS wisp_rosters (guild_id ${id} PRIMARY KEY, completed_at ${id} NOT NULL, members_json ${json} NOT NULL)`);
    await this.raw(`CREATE TABLE IF NOT EXISTS wisp_cooldowns (cooldown_key ${id} PRIMARY KEY, expires_at BIGINT NOT NULL)`);
    await this.raw(`CREATE TABLE IF NOT EXISTS wisp_tasks (name ${id} PRIMARY KEY, file ${json} NOT NULL, template ${id} NOT NULL, repeat_task BOOLEAN NOT NULL, interval_s DOUBLE PRECISION NOT NULL, fire_at BIGINT NOT NULL, data_json ${json})`);
  }
  async get(scope:string,key:string,fallback:Value=null):Promise<Value>{const row=(await this.raw('SELECT json_value FROM wisp_kv WHERE scope=? AND key_name=?',[scope,key])).rows[0];return row?decode(String(row.json_value)):fallback;}
  async has(scope:string,key:string):Promise<boolean>{return (await this.raw('SELECT 1 AS found FROM wisp_kv WHERE scope=? AND key_name=?',[scope,key])).rows.length>0;}
  async set(scope:string,key:string,value:Value):Promise<void>{const json=encode(value);if(this.engine==='postgres')await this.raw('INSERT INTO wisp_kv(scope,key_name,json_value) VALUES(?,?,?) ON CONFLICT(scope,key_name) DO UPDATE SET json_value=EXCLUDED.json_value',[scope,key,json]);else await this.raw('INSERT INTO wisp_kv(scope,key_name,json_value) VALUES(?,?,?) ON DUPLICATE KEY UPDATE json_value=VALUES(json_value)',[scope,key,json]);}
  async delete(scope:string,key:string):Promise<void>{await this.raw('DELETE FROM wisp_kv WHERE scope=? AND key_name=?',[scope,key]);}
  async top(scopePrefix:string,key:string,limit:number):Promise<TopRow[]>{
    const count=Math.trunc(limit),numeric=this.engine==='postgres'?"jsonb_typeof(json_value::jsonb)='number'":"JSON_TYPE(json_value) IN ('INTEGER','UNSIGNED INTEGER','DOUBLE','DECIMAL')",order=this.engine==='postgres'?'(json_value::jsonb)::numeric':'CAST(json_value AS DECIMAL(65,10))';
    return (await this.raw(`SELECT scope,json_value FROM wisp_kv WHERE substr(scope,1,length(?))=? AND key_name=? AND ${numeric} ORDER BY ${order} DESC,scope LIMIT ${count}`,[scopePrefix,scopePrefix,key])).rows.map(row=>({scope:String(row.scope),value:Number(decode(String(row.json_value)))}));
  }
  async increment(scope:string,key:string,amount=1):Promise<number>{if(!Number.isFinite(amount))throw new WispError('STORAGE006','Increment amount must be finite');return this.transaction(async connection=>{
    const insert=this.engine==='postgres'?'INSERT INTO wisp_kv(scope,key_name,json_value) VALUES(?,?,?) ON CONFLICT(scope,key_name) DO NOTHING':'INSERT IGNORE INTO wisp_kv(scope,key_name,json_value) VALUES(?,?,?)';
    await this.raw(insert,[scope,key,'0'],connection);const row=(await this.raw('SELECT json_value FROM wisp_kv WHERE scope=? AND key_name=? FOR UPDATE',[scope,key],connection)).rows[0]!;
    const current=decode(String(row.json_value));if(typeof current!=='number')throw new WispError('STORAGE006','Stored counter is not a number');const next=current+amount;if(!Number.isFinite(next))throw new WispError('STORAGE006','Counter overflow');await this.raw('UPDATE wisp_kv SET json_value=? WHERE scope=? AND key_name=?',[String(next),scope,key],connection);return next;
  });}
  async putComponent(item:ComponentState):Promise<void>{const state=encode(item.state);if(state.length>16384)throw new WispError('STORAGE006','Component state exceeds 16 KiB');await this.raw('INSERT INTO wisp_components(id,kind,name,guild_id,owner_id,expires_at,state_json,message_id,channel_id) VALUES(?,?,?,?,?,?,?,?,?)',[item.id,item.kind,item.name,item.guildId,item.ownerId,item.expiresAt,state,item.messageId??null,item.channelId??null]);}
  async getComponent(id:string):Promise<ComponentState|null>{const row=(await this.raw('SELECT * FROM wisp_components WHERE id=?',[id])).rows[0];if(!row)return null;const expiresAt=Number(row.expires_at);if(expiresAt>0&&expiresAt<=Date.now()){await this.raw('DELETE FROM wisp_components WHERE id=?',[id]);return null;}return {id,kind:String(row.kind),name:String(row.name),guildId:String(row.guild_id),ownerId:row.owner_id===null?null:String(row.owner_id),expiresAt,state:decode(String(row.state_json)) as Record<string,Value>};}
  async cleanupComponents():Promise<number>{return (await this.raw('DELETE FROM wisp_components WHERE expires_at>0 AND expires_at<=?',[Date.now()])).affected;}
  async linkComponents(ids:string[],messageId:string,channelId:string,expiresAt=0):Promise<void>{if(!ids.length)return;await this.raw(`UPDATE wisp_components SET message_id=?,channel_id=?,expires_at=CASE WHEN expires_at=0 THEN ? ELSE expires_at END WHERE id IN (${ids.map(()=>'?').join(',')})`,[messageId,channelId,expiresAt,...ids]);}
  async deleteComponentsFor(owner:ComponentOwner,ids:string[]):Promise<number>{const column=owner==='message'?'message_id':owner==='channel'?'channel_id':'guild_id';let removed=0;for(let i=0;i<ids.length;i+=100){const chunk=ids.slice(i,i+100);removed+=(await this.raw(`DELETE FROM wisp_components WHERE ${column} IN (${chunk.map(()=>'?').join(',')})`,chunk)).affected;}return removed;}
  async saveRoster(guildId:string,members:{id:string;joinedAt:string}[]):Promise<void>{const json=JSON.stringify(members),now=new Date().toISOString();if(this.engine==='postgres')await this.raw('INSERT INTO wisp_rosters(guild_id,completed_at,members_json) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET completed_at=EXCLUDED.completed_at,members_json=EXCLUDED.members_json',[guildId,now,json]);else await this.raw('INSERT INTO wisp_rosters(guild_id,completed_at,members_json) VALUES(?,?,?) ON DUPLICATE KEY UPDATE completed_at=VALUES(completed_at),members_json=VALUES(members_json)',[guildId,now,json]);}
  async claimCooldown(key:string,now:number,until:number):Promise<number|null>{return this.transaction(async connection=>{
    const insert=this.engine==='postgres'?'INSERT INTO wisp_cooldowns(cooldown_key,expires_at) VALUES(?,?) ON CONFLICT(cooldown_key) DO NOTHING':'INSERT IGNORE INTO wisp_cooldowns(cooldown_key,expires_at) VALUES(?,?)';
    await this.raw(insert,[key,0],connection);const expires=Number((await this.raw('SELECT expires_at FROM wisp_cooldowns WHERE cooldown_key=? FOR UPDATE',[key],connection)).rows[0]!.expires_at);
    if(expires>now)return expires;await this.raw('UPDATE wisp_cooldowns SET expires_at=? WHERE cooldown_key=?',[until,key],connection);return null;
  });}
  async cleanupCooldowns(now:number):Promise<number>{return (await this.raw('DELETE FROM wisp_cooldowns WHERE expires_at<=?',[now])).affected;}
  async putTask(task:TaskRow):Promise<void>{const data=task.data===null?null:encode(task.data);const params=[task.name,task.file,task.template,task.repeat,task.intervalSeconds,task.fireAt,data];if(this.engine==='postgres')await this.raw('INSERT INTO wisp_tasks(name,file,template,repeat_task,interval_s,fire_at,data_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET file=EXCLUDED.file,template=EXCLUDED.template,repeat_task=EXCLUDED.repeat_task,interval_s=EXCLUDED.interval_s,fire_at=EXCLUDED.fire_at,data_json=EXCLUDED.data_json',params);else await this.raw('INSERT INTO wisp_tasks(name,file,template,repeat_task,interval_s,fire_at,data_json) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE file=VALUES(file),template=VALUES(template),repeat_task=VALUES(repeat_task),interval_s=VALUES(interval_s),fire_at=VALUES(fire_at),data_json=VALUES(data_json)',params);}
  async deleteTask(name:string):Promise<void>{await this.raw('DELETE FROM wisp_tasks WHERE name=?',[name]);}
  async listTasks():Promise<TaskRow[]>{return (await this.raw('SELECT * FROM wisp_tasks ORDER BY fire_at,name')).rows.map(row=>({name:String(row.name),file:String(row.file),template:String(row.template),repeat:row.repeat_task===true||Number(row.repeat_task)===1,intervalSeconds:Number(row.interval_s),fireAt:Number(row.fire_at),data:row.data_json===null?null:decode(String(row.data_json)) as Record<string,Value>}));}
  async restore(snapshot:StorageSnapshot):Promise<void>{await this.transaction(async connection=>{
    for(const table of ['wisp_kv','wisp_components','wisp_rosters','wisp_tasks'])if((await this.raw(`SELECT 1 FROM ${table} LIMIT 1`,[],connection)).rows.length)throw new WispError('STORAGE006','Migration destination must be empty');
    for(const row of snapshot.values)await this.raw('INSERT INTO wisp_kv(scope,key_name,json_value) VALUES(?,?,?)',[row.scope,row.key,encode(row.value)],connection);
    for(const row of snapshot.components)await this.raw('INSERT INTO wisp_components(id,kind,name,guild_id,owner_id,expires_at,state_json,message_id,channel_id) VALUES(?,?,?,?,?,?,?,?,?)',[row.id,row.kind,row.name,row.guildId,row.ownerId,row.expiresAt,encode(row.state),row.messageId??null,row.channelId??null],connection);
    for(const row of snapshot.rosters)await this.raw('INSERT INTO wisp_rosters(guild_id,completed_at,members_json) VALUES(?,?,?)',[row.guildId,row.completedAt,JSON.stringify(row.members)],connection);
    for(const row of snapshot.tasks??[])await this.raw('INSERT INTO wisp_tasks(name,file,template,repeat_task,interval_s,fire_at,data_json) VALUES(?,?,?,?,?,?,?)',[row.name,row.file,row.template,row.repeat,row.intervalSeconds,row.fireAt,row.data===null?null:encode(row.data)],connection);
  });}
  async close():Promise<void>{if(this.pg)await this.pg.end();else await this.my!.end();}
}

export class RedisDatabase implements StorageBackend {
  readonly client:RedisClientType;private prefix:string;private readonly base:string;private connected=false;private lastError='';
  /** Receives connection errors after startup; repeated messages are reported once. */
  onError:(message:string)=>void=()=>{};
  constructor(url:string,projectName:string){this.client=createClient({url,disableOfflineQueue:true,socket:{connectTimeout:5000,reconnectStrategy:retries=>this.connected?Math.min(100*2**Math.min(retries,6),5000):false}});this.client.on('error',(error:unknown)=>{const message=error instanceof Error?error.message:String(error);if(this.connected&&message!==this.lastError)this.onError(`Redis connection error: ${message}`);this.lastError=message;});this.client.on('ready',()=>{if(this.lastError&&this.connected)this.onError('Redis connection restored');this.lastError='';});this.base=`wisp:${projectName}:`;this.prefix=this.base;}
  async connect():Promise<void>{await this.client.connect();this.connected=true;await this.client.ping();const active=await this.client.get(`${this.base}active`);if(active)this.prefix=`${this.base}generation:${active}:`;}
  private userKey(key:string):string{if(!key||key.length>256)throw new WispError('STORAGE006','Redis key must be 1 to 256 characters');return `${this.prefix}user:${key}`;}
  async userGet(key:string):Promise<Value>{const raw=await this.client.get(this.userKey(key));return raw===null?null:decode(raw);}
  async userSet(key:string,value:Value,ttlSeconds:Value=null):Promise<void>{const json=encode(value);if(ttlSeconds===null)await this.client.set(this.userKey(key),json);else{if(typeof ttlSeconds!=='number'||!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>2147483)throw new WispError('STORAGE006','Redis TTL must be a positive number of seconds');await this.client.set(this.userKey(key),json,{EX:ttlSeconds});}}
  async userHas(key:string):Promise<boolean>{return (await this.client.exists(this.userKey(key)))>0;}
  async userDelete(key:string):Promise<void>{await this.client.del(this.userKey(key));}
  async userIncrement(key:string,amount=1):Promise<number>{return this.incrementKey(this.userKey(key),amount);}
  private key(scope:string,key:string):string{return `${this.prefix}kv:${Buffer.from(scope).toString('base64url')}:${Buffer.from(key).toString('base64url')}`;}
  /** Numeric values in per-user data scopes are mirrored into a sorted set so top() needs no scan. */
  private board(scope:string,key:string):string|null{if(!scope.startsWith('data:user:'))return null;const prefix=scope.slice(0,scope.lastIndexOf(':')+1);return `${this.prefix}top:${Buffer.from(prefix).toString('base64url')}:${Buffer.from(key).toString('base64url')}`;}
  private async score(scope:string,key:string,value:Value):Promise<void>{const board=this.board(scope,key);if(!board)return;if(typeof value==='number')await this.client.zAdd(board,{score:value,value:scope});else await this.client.zRem(board,scope);}
  async top(scopePrefix:string,key:string,limit:number):Promise<TopRow[]>{const board=`${this.prefix}top:${Buffer.from(scopePrefix).toString('base64url')}:${Buffer.from(key).toString('base64url')}`;return (await this.client.zRangeWithScores(board,0,Math.trunc(limit)-1,{REV:true})).map(row=>({scope:String(row.value),value:row.score}));}
  async get(scope:string,key:string,fallback:Value=null):Promise<Value>{const found=await this.client.get(this.key(scope,key));return found===null?fallback:decode(found);}
  async has(scope:string,key:string):Promise<boolean>{return (await this.client.exists(this.key(scope,key)))>0;}
  async set(scope:string,key:string,value:Value):Promise<void>{await this.client.set(this.key(scope,key),encode(value));await this.score(scope,key,value);}
  async delete(scope:string,key:string):Promise<void>{await this.client.del(this.key(scope,key));await this.score(scope,key,null);}
  async increment(scope:string,key:string,amount=1):Promise<number>{const value=await this.incrementKey(this.key(scope,key),amount);await this.score(scope,key,value);return value;}
  private async incrementKey(key:string,amount:number):Promise<number>{if(!Number.isFinite(amount))throw new WispError('STORAGE006','Increment amount must be finite');
    const script="local raw=redis.call('GET',KEYS[1]); local current=0; if raw then local ok,value=pcall(cjson.decode,raw); if not ok or type(value)~='number' then return redis.error_reply('Stored counter is not a number') end; current=value end; local next=current+tonumber(ARGV[1]); if next~=next or next==math.huge or next==-math.huge then return redis.error_reply('Counter overflow') end; local ttl=redis.call('PTTL',KEYS[1]); if ttl>0 then redis.call('PSETEX',KEYS[1],ttl,cjson.encode(next)) else redis.call('SET',KEYS[1],cjson.encode(next)) end; return cjson.encode(next)";
    try{const result=await this.client.eval(script,{keys:[key],arguments:[String(amount)]});const value=Number(result);if(!Number.isFinite(value))throw new WispError('STORAGE006','Counter overflow');return value;}
    catch(error){if(error instanceof WispError)throw error;throw new WispError('STORAGE006',error instanceof Error?error.message:'Redis counter update failed');}
  }
  async putComponent(item:ComponentState):Promise<void>{const state=encode(item.state);if(state.length>16384)throw new WispError('STORAGE006','Component state exceeds 16 KiB');const key=`${this.prefix}component:${item.id}`,json=JSON.stringify(item);if(item.expiresAt>0)await this.client.set(key,json,{PX:Math.max(1,item.expiresAt-Date.now())});else await this.client.set(key,json);}
  async getComponent(id:string):Promise<ComponentState|null>{const raw=await this.client.get(`${this.prefix}component:${id}`);if(!raw)return null;const item=JSON.parse(raw) as ComponentState;if(item.expiresAt>0&&item.expiresAt<=Date.now()){await this.client.del(`${this.prefix}component:${id}`);return null;}return item;}
  async cleanupComponents():Promise<number>{return 0;}
  async linkComponents(ids:string[],messageId:string,channelId:string,expiresAt=0):Promise<void>{
    let latest=0,forever=false;
    for(const id of ids){const key=`${this.prefix}component:${id}`,raw=await this.client.get(key);if(!raw)continue;const item=JSON.parse(raw) as ComponentState;item.messageId=messageId;item.channelId=channelId;if(item.expiresAt===0&&expiresAt>0)item.expiresAt=expiresAt;if(item.expiresAt>0){latest=Math.max(latest,item.expiresAt);await this.client.set(key,JSON.stringify(item),{PXAT:item.expiresAt});}else{forever=true;await this.client.set(key,JSON.stringify(item));}}
    const index=`${this.prefix}component-message:${messageId}`;await this.client.sAdd(index,ids);if(forever)await this.client.persist(index);else if(latest)await this.client.pExpireAt(index,latest);
  }
  async deleteComponentsFor(owner:ComponentOwner,ids:string[]):Promise<number>{
    let removed=0;
    if(owner==='message'){for(const messageId of ids){const index=`${this.prefix}component-message:${messageId}`,members=await this.client.sMembers(index);if(members.length)removed+=await this.client.del(members.map(id=>`${this.prefix}component:${id}`));await this.client.del(index);}return removed;}
    const wanted=new Set(ids);let cursor='0';
    do{const scan=await this.client.scan(cursor,{MATCH:`${this.prefix}component:*`,COUNT:200});cursor=scan.cursor;for(const key of scan.keys){const raw=await this.client.get(key);if(!raw)continue;const item=JSON.parse(raw) as ComponentState;if(wanted.has(String(owner==='channel'?item.channelId:item.guildId))){removed+=await this.client.del(key);if(item.messageId)await this.client.sRem(`${this.prefix}component-message:${item.messageId}`,item.id);}}}while(cursor!=='0');
    return removed;
  }
  async claimCooldown(key:string,now:number,until:number):Promise<number|null>{const name=`${this.prefix}cooldown:${key}`;if(await this.client.set(name,String(until),{PXAT:until,NX:true}))return null;const ttl=await this.client.pTTL(name);return ttl>0?now+ttl:this.claimCooldown(key,now,until);}
  async cleanupCooldowns():Promise<number>{return 0;}
  async putTask(task:TaskRow):Promise<void>{await this.client.hSet(`${this.prefix}tasks`,task.name,JSON.stringify(task));}
  async deleteTask(name:string):Promise<void>{await this.client.hDel(`${this.prefix}tasks`,name);}
  async listTasks():Promise<TaskRow[]>{return (await this.client.hVals(`${this.prefix}tasks`)).map(raw=>JSON.parse(raw) as TaskRow).sort((a,b)=>a.fireAt-b.fireAt||a.name.localeCompare(b.name));}
  async saveRoster(guildId:string,members:{id:string;joinedAt:string}[]):Promise<void>{await this.client.set(`${this.prefix}roster:${guildId}`,JSON.stringify({guildId,members,completedAt:new Date().toISOString()}));}
  async restore(snapshot:StorageSnapshot):Promise<void>{let cursor='0';do{const scan=await this.client.scan(cursor,{MATCH:`${this.base}*`,COUNT:100});cursor=scan.cursor;if(scan.keys.length)throw new WispError('STORAGE006','Migration destination must be empty');}while(cursor!=='0');
    const generation=`${Date.now()}-${Math.random().toString(36).slice(2)}`,staging=`${this.base}generation:${generation}:`;
    try{for(const row of snapshot.values){await this.client.set(`${staging}${this.key(row.scope,row.key).slice(this.prefix.length)}`,encode(row.value));const board=this.board(row.scope,row.key);if(board&&typeof row.value==='number')await this.client.zAdd(`${staging}${board.slice(this.prefix.length)}`,{score:row.value,value:row.scope});}
      for(const item of snapshot.components){if(item.expiresAt>0&&item.expiresAt<=Date.now())continue;const key=`${staging}component:${item.id}`;if(item.expiresAt>0)await this.client.set(key,JSON.stringify(item),{PX:item.expiresAt-Date.now()});else await this.client.set(key,JSON.stringify(item));if(item.messageId)await this.client.sAdd(`${staging}component-message:${item.messageId}`,item.id);}
      for(const row of snapshot.rosters)await this.client.set(`${staging}roster:${row.guildId}`,JSON.stringify(row));
      for(const row of snapshot.tasks??[])await this.client.hSet(`${staging}tasks`,row.name,JSON.stringify(row));
      await this.client.set(`${this.base}active`,generation);this.prefix=staging;
    }catch(error){let scanCursor='0';do{const scan=await this.client.scan(scanCursor,{MATCH:`${staging}*`,COUNT:100});scanCursor=scan.cursor;if(scan.keys.length)await this.client.del(scan.keys);}while(scanCursor!=='0');throw error;}
  }
  async close():Promise<void>{this.connected=false;if(this.client.isOpen)await this.client.quit();}
}
