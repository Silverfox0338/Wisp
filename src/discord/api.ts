import type {Client} from 'discord.js';
import {WispError} from '../diagnostics.js';
import {explainDiscordError} from './errors.js';
import {host,record,type Value} from '../runtime/interpreter.js';
import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,resolve,basename} from 'node:path';
import {permissionApi} from './permissions.js';
import {referenceApi} from './reference.js';
import {shardForGuild} from './shards.js';
import {buildTranscript,discordImages,transcriptKeys,transcriptSettings,type DiscordCall,type ImageFetcher} from './transcript.js';

export interface GatewayPacket {op:number;d:unknown}
/** Reaches shards that run in other processes. */
export interface GatewayRemote {count():number;send(shard:number,packet:GatewayPacket):Promise<void>;broadcast(packet:GatewayPacket):Promise<void>}

const methods=new Set(['GET','POST','PUT','PATCH','DELETE']);
const routePattern=/^\/[a-z0-9_@%.\-/]+$/i;
const snowflakePattern=/^\d{1,20}$/;

function snowflake(value:Value,label:string):string {
  if(typeof value!=='string'||!snowflakePattern.test(value))throw new WispError('DISCORD005',`${label} must be a Discord ID string`);
  return value;
}

function emoji(value:Value):string {
  if(typeof value!=='string'||!value||value.length>100)throw new WispError('DISCORD005','Emoji must be a nonempty string of at most 100 characters');
  return encodeURIComponent(value).replace(/[!'()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function options(value:Value,label:string):Value {
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new WispError('DISCORD005',`${label} must be a map`);
  return value;
}

function namedOptions(name:Value,settings:Value,label:string):Value {
  if(typeof name!=='string'||!name.trim()||name.length>100)throw new WispError('DISCORD005',`${label} name must be 1 to 100 characters`);
  return {...options(settings,`${label} options`) as Record<string,Value>,name};
}

function messageOptions(value:Value):Value {
  return typeof value==='string'?{content:value}:options(value,'Message options');
}

function textOptions(content:Value,settings:Value):Value {
  const extra=options(settings,'Message options') as Record<string,Value>;
  if(typeof content==='string')return {...extra,content};
  if(content===null||typeof content!=='object'||Array.isArray(content))throw new WispError('DISCORD005','Message content must be a string or V2 message map');
  return {...options(content,'Message payload') as Record<string,Value>,...extra};
}

function permissionOverwrite(value:Value):Value {
  const data=options(value,'Permission overwrite') as Record<string,unknown>;
  if(data.type!==0&&data.type!==1)throw new WispError('DISCORD005','Permission overwrite type must be 0 (role) or 1 (member)');
  for(const key of ['allow','deny'])if(data[key]!==undefined&&(typeof data[key]!=='string'||!/^\d+$/.test(data[key])))throw new WispError('DISCORD005',`Permission overwrite ${key} must be a decimal string`);
  return value;
}

function pollBody(question:Value,answers:Value,settings:Value):Value {
  if(typeof question!=='string'||!question.trim()||question.length>300)throw new WispError('DISCORD005','Poll question must be 1 to 300 characters');
  if(!Array.isArray(answers)||answers.length<2||answers.length>10||answers.some(answer=>typeof answer!=='string'||!answer.trim()||answer.length>55))throw new WispError('DISCORD005','Poll needs 2 to 10 answers of 1 to 55 characters');
  const {duration=24,allow_multiselect=false,layout_type=1,...message}=options(settings,'Poll settings') as Record<string,Value>;
  if(typeof duration!=='number'||!Number.isInteger(duration)||duration<1||duration>768)throw new WispError('DISCORD005','Poll duration must be 1 to 768 hours');
  if(typeof allow_multiselect!=='boolean')throw new WispError('DISCORD005','Poll allow_multiselect must be a boolean');
  if(layout_type!==1)throw new WispError('DISCORD005','Poll layout_type must be 1');
  return {...message,poll:{question:{text:question},answers:answers.map(answer=>({poll_media:{text:answer}})),duration,allow_multiselect,layout_type}};
}

function answerId(value:Value):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>10)throw new WispError('DISCORD005','Poll answer ID must be an integer from 1 to 10');
  return value;
}

function plain(value:Value,label:string):unknown {
  let json:string|undefined;
  if(value===undefined)return null;
  try{json=JSON.stringify(value);}catch{throw new WispError('DISCORD005',`${label} must be JSON-compatible`);}
  if(json===undefined||json.length>1024*1024)throw new WispError('DISCORD005',`${label} exceeds the 1 MiB JSON limit or is not JSON-compatible`);
  return JSON.parse(json) as unknown;
}

/** Where paths that start with the files folder name are read from; wisp test points it at a temporary folder. */
export interface FilesFolder {prefix:string;root:string}

/** onMessage receives messages created or edited through REST, for example to link component rows. */
/** files maps the files folder for uploads; fetchImage downloads images for transcripts, or null to keep links. */
export interface DiscordApiOptions {files?:FilesFolder;fetchImage?:ImageFetcher|null}

export function discordApi(client:Client,projectRoot?:string,onMessage?:(message:unknown)=>Promise<void>,remote?:GatewayRemote,settings:DiscordApiOptions={}):Value {
  const filesFolder=settings.files,fetchImage=settings.fetchImage===undefined?discordImages:settings.fetchImage;
  const request=host(async(method,path,body=null,query=null,reason=null,files=null)=>{
    if(typeof method!=='string'||!methods.has(method.toUpperCase()))throw new WispError('DISCORD005','Discord method must be GET, POST, PUT, PATCH, or DELETE');
    if(typeof path!=='string'||path.length>2048||!routePattern.test(path)||path.includes('//')||path.split('/').includes('..')||path.split('/').includes('.'))throw new WispError('DISCORD005','Discord path must be a relative /api/v10 route without query or fragment');
    if(path.startsWith('/api/'))throw new WispError('DISCORD005','Pass the versioned API path beginning after /api/v10');
    if(reason!==null&&(typeof reason!=='string'||reason.length>512))throw new WispError('DISCORD005','Audit log reason must be a string of at most 512 characters');
    const uploads:{name:string;data:Buffer;key?:string}[]=[];
    if(files!==null){
      if(!Array.isArray(files)||files.length>10)throw new WispError('DISCORD005','Files must be a list of at most 10 project-relative paths or {"name", "text"} maps');
      for(const file of files){
        const descriptor=file&&typeof file==='object'&&!Array.isArray(file)?file as Record<string,unknown>:null;
        const key=descriptor?.key;
        if(key!==undefined&&(typeof key!=='string'||!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)))throw new WispError('DISCORD005','Multipart file key must be a simple name');
        if(descriptor&&descriptor.text!==undefined){
          const name=descriptor.name,text=descriptor.text;
          if(typeof name!=='string'||!/^[\w][\w .-]{0,99}$/.test(name))throw new WispError('DISCORD005','File name must be 1 to 100 letters, digits, spaces, dots, dashes, or underscores, such as "transcript.html"');
          if(typeof text!=='string'||Buffer.byteLength(text)>25*1024*1024)throw new WispError('DISCORD005','File text must be text no larger than 25 MiB');
          uploads.push({name,data:Buffer.from(text,'utf8'),...(key?{key}:{})});
          continue;
        }
        const path=typeof file==='string'?file:descriptor?.path;
        if(!projectRoot)throw new WispError('DISCORD005','Files must be {"name", "text"} maps here');
        if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\0'))throw new WispError('DISCORD005','File path must be project-relative');
        const normal=path.replaceAll('\\','/').replace(/^\.\//,'');
        const inFiles=filesFolder&&normal.startsWith(`${filesFolder.prefix}/`);
        const root=await realpath(inFiles?filesFolder.root:projectRoot).catch(()=>{throw new WispError('DISCORD005','Upload file is unavailable');});
        const target=resolve(root,inFiles?normal.slice(filesFolder.prefix.length+1):path),actual=await realpath(target).catch(()=>{throw new WispError('DISCORD005','Upload file is unavailable');});
        const rel=relative(root,actual);
        if(rel.startsWith('..')||isAbsolute(rel))throw new WispError('DISCORD005','Upload file escapes project root');
        const info=await stat(actual);
        if(!info.isFile()||info.size>25*1024*1024)throw new WispError('DISCORD005','Upload must be a file no larger than 25 MiB');
        uploads.push({name:basename(actual),data:await readFile(actual),...(key?{key}:{})});
      }
    }
    const params=new URLSearchParams();
    if(query!==null){const input=plain(query,'Query');if(!input||typeof input!=='object'||Array.isArray(input))throw new WispError('DISCORD005','Query must be a map');for(const [key,value] of Object.entries(input)){if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key))throw new WispError('DISCORD005','Invalid query key');for(const item of Array.isArray(value)?value:[value]){if(item===null||typeof item==='object')throw new WispError('DISCORD005','Query values must be strings, numbers, booleans, or lists of those');params.append(key,String(item));}}}
    const tokenRoute=/^\/(?:interactions|webhooks)\/\d+\/[^/]+(?:\/|$)/.test(path);
    const requestOptions={fullRoute:path as `/${string}`,method:method.toUpperCase() as Parameters<Client['rest']['request']>[0]['method'],...(body!==null?{body:plain(body,'Body')}:{ }),...(query!==null?{query:params}:{}),...(reason!==null?{reason}: {}),...(tokenRoute?{auth:false}:{}),...(uploads.length?{files:uploads}:{}),...(uploads.some(file=>file.key==='file')?{appendToFormData:true}:{})};
    try{
      const result=await client.rest.request(requestOptions);
      if(result instanceof ArrayBuffer||ArrayBuffer.isView(result)){
        const binary=Buffer.from(result instanceof ArrayBuffer?result:result.buffer,result instanceof ArrayBuffer?0:result.byteOffset,result instanceof ArrayBuffer?undefined:result.byteLength);
        if(!binary.length)return null;
        if(binary.length>768*1024)throw new WispError('DISCORD005','Binary Discord response exceeds 768 KiB');
        return {base64:binary.toString('base64'),encoding:'base64'};
      }
      const value=plain(result as Value,'Discord response') as Value;
      if(onMessage&&requestOptions.method!=='GET'&&value&&typeof value==='object'&&!Array.isArray(value)&&'channel_id' in value&&'components' in value)await onMessage(value);
      return value;
    }catch(error){
      if(error instanceof WispError)throw error;
      const details=error&&typeof error==='object'?error as {status?:unknown;code?:unknown}:{};
      const status=typeof details.status==='number'?details.status:null;
      const discordCode=typeof details.code==='number'||typeof details.code==='string'?details.code:null;
      const failure=new WispError('DISCORD005',`${explainDiscordError(status,discordCode)} (HTTP ${status??'unknown'}${discordCode!==null?`, Discord ${discordCode}`:''})`);
      failure.status=status;
      failure.discordCode=discordCode;
      throw failure;
    }
  });
  const call:DiscordCall=async(method,path,body=null,query=null)=>request.call(method,path,body,query);
  const resources=referenceApi(request);
  const shardCount=()=>remote?.count()??client.options?.shardCount??client.ws.shards.size??1;
  const sendTo=async(shardId:number,packet:GatewayPacket):Promise<void>=>{const shard=client.ws.shards.get(shardId);if(shard){shard.send(packet);return;}if(remote&&shardId<remote.count()){await remote.send(shardId,packet);return;}throw new WispError('DISCORD005',`Gateway shard ${shardId} is unavailable`);};
  // With no shard ID, a presence update goes to every shard and a guild request goes to that guild's shard.
  return record({...resources,gateway:host(async(opcode,data,shardId=null)=>{
    if(typeof opcode!=='number'||![3,4,8,31,43].includes(opcode))throw new WispError('DISCORD005','Gateway opcode must be 3, 4, 8, 31, or 43');
    const packet={op:opcode,d:plain(data,'Gateway payload')};
    if(shardId!==null){if(typeof shardId!=='number'||!Number.isSafeInteger(shardId)||shardId<0)throw new WispError('DISCORD005','Shard ID must be a nonnegative integer');await sendTo(shardId,packet);return null;}
    if(opcode===3){for(const shard of client.ws.shards.values())shard.send(packet);await remote?.broadcast(packet);return null;}
    const payload=(packet.d&&typeof packet.d==='object'?packet.d:{}) as Record<string,unknown>;
    if(opcode===31&&Array.isArray(payload.guild_ids)){const byShard=new Map<number,string[]>();for(const id of payload.guild_ids){if(typeof id!=='string')throw new WispError('DISCORD005','guild_ids must be a list of guild ID strings');const shard=shardForGuild(id,shardCount());byShard.set(shard,[...byShard.get(shard)??[],id]);}for(const [shard,ids] of byShard)await sendTo(shard,{op:opcode,d:{...payload,guild_ids:ids}});return null;}
    if(typeof payload.guild_id!=='string')throw new WispError('DISCORD005',`Gateway opcode ${opcode} needs data.guild_id to pick a shard, or pass a shard ID`);
    await sendTo(shardForGuild(payload.guild_id,shardCount()),packet);return null;
  }),request,
  channel:host((guildId,name,settings={},reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/channels`,namedOptions(name,settings,'Channel'),null,reason)),
  role:host((guildId,name,settings={},reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/roles`,namedOptions(name,settings,'Role'),null,reason)),
  thread:host((channelId,name,settings={},reason=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/threads`,namedOptions(name,settings,'Thread'),null,reason)),
  send:host((channelId,content,settings={},files=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/messages`,textOptions(content,settings),null,null,files)),
  transcript:host(async(channelId,settings={})=>{
    const channel=snowflake(channelId,'Channel ID'),input=options(settings,'Transcript settings') as Record<string,Value>;
    for(const key of Object.keys(input))if(!transcriptKeys.includes(key))throw new WispError('DISCORD005',`Unknown transcript setting ${key}; use ${transcriptKeys.join(', ')}`);
    return {...await buildTranscript(call,channel,transcriptSettings(input),fetchImage)};
  }),
  closeTicket:host(async(channelId,settings={})=>{
    const channel=snowflake(channelId,'Channel ID'),input=options(settings,'Ticket settings') as Record<string,Value>;
    const ticketKeys=['log','dm','delete','message','reason'];
    for(const key of Object.keys(input))if(!ticketKeys.includes(key)&&!transcriptKeys.includes(key))throw new WispError('DISCORD005',`Unknown closeTicket setting ${key}; use ${[...ticketKeys,...transcriptKeys].join(', ')}`);
    const log=input.log===undefined||input.log===null?null:snowflake(input.log,'Log channel ID');
    const dm=input.dm===undefined||input.dm===null?null:snowflake(input.dm,'DM user ID');
    const remove=input.delete??false,reason=input.reason??null;
    if(typeof remove!=='boolean')throw new WispError('DISCORD005','closeTicket delete must be true or false');
    if(reason!==null&&(typeof reason!=='string'||reason.length>512))throw new WispError('DISCORD005','closeTicket reason must be text of at most 512 characters');
    if(input.message!==undefined&&(typeof input.message!=='string'||input.message.length>2000))throw new WispError('DISCORD005','closeTicket message must be text of at most 2000 characters');
    const transcript=await buildTranscript(call,channel,transcriptSettings(Object.fromEntries(Object.entries(input).filter(([key])=>transcriptKeys.includes(key)))),fetchImage);
    const content=typeof input.message==='string'?input.message:`Transcript of ${transcript.channel?`#${transcript.channel}`:'the ticket'} (${transcript.messages} messages)`;
    const body={content,allowed_mentions:{parse:[]}},file=[{name:transcript.name,text:transcript.text}];
    let logged=false,dmed=false,dmError:string|null=null;
    if(log){
      try{await request.call('POST',`/channels/${log}/messages`,body,null,null,file);logged=true;}
      catch(error){throw new WispError('DISCORD005',`Couldn't post the transcript to the log channel, so the ticket was kept: ${error instanceof Error?error.message:String(error)}`);}
    }
    if(dm){
      try{
        const opened=await request.call('POST','/users/@me/channels',{recipient_id:dm});
        const dmChannel=opened&&typeof opened==='object'&&!Array.isArray(opened)?(opened as Record<string,unknown>).id:null;
        if(typeof dmChannel!=='string'||!snowflakePattern.test(dmChannel))throw new Error('Discord did not return a DM channel');
        await request.call('POST',`/channels/${dmChannel}/messages`,body,null,null,file);dmed=true;
      }catch(error){dmError=error instanceof Error?error.message:String(error);}
    }
    let deleted=false;
    if(remove){
      if(!logged&&!dmed)throw new WispError('DISCORD005',`Couldn't post the transcript anywhere, so the ticket was kept${dmError?` (DM failed: ${dmError})`:'; set "log" or "dm"'}`);
      await request.call('DELETE',`/channels/${channel}`,null,null,reason);deleted=true;
    }
    return {name:transcript.name,messages:transcript.messages,channel:transcript.channel,logged,dmed,deleted,dm_error:dmError};
  }),
  editMessage:host((channelId,messageId,content,settings={},files=null)=>request.call('PATCH',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}`,textOptions(content,settings),null,null,files)),
  deleteMessage:host((channelId,messageId,reason=null)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}`,null,null,reason)),
  dm:host(async(userId,content,settings={})=>{
    const user=snowflake(userId,'User ID'),body=textOptions(content,settings);
    const channel=await request.call('POST','/users/@me/channels',{recipient_id:user});
    const channelId=channel&&typeof channel==='object'&&!Array.isArray(channel)?(channel as Record<string,unknown>).id:null;
    if(typeof channelId!=='string'||!snowflakePattern.test(channelId))throw new WispError('DISCORD005','Discord did not return a DM channel ID');
    return request.call('POST',`/channels/${channelId}/messages`,body);
  }),
  invite:host((channelId,settings={},reason=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/invites`,options(settings,'Invite options'),null,reason)),
  nick:host((guildId,userId,nickname,reason=null)=>{
    if(nickname!==null&&typeof nickname!=='string')throw new WispError('DISCORD005','Nickname must be a string or null');
    return request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,{nick:nickname},null,reason);
  }),
  timeout:host((guildId,userId,seconds,reason=null)=>{
    if(typeof seconds!=='number'||!Number.isInteger(seconds)||seconds<1||seconds>28*86400)throw new WispError('DISCORD005','Timeout must be 1 to 2419200 seconds');
    return request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,{communication_disabled_until:new Date(Date.now()+seconds*1000).toISOString()},null,reason);
  }),
  untimeout:host((guildId,userId,reason=null)=>request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,{communication_disabled_until:null},null,reason)),
  poll:host((channelId,question,answers,settings={})=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/messages`,pollBody(question,answers,settings))),
  sticker:host((guildId,name,file,settings={},reason=null)=>{
    if(typeof name!=='string'||name.length<2||name.length>30)throw new WispError('DISCORD005','Sticker name must be 2 to 30 characters');
    if(typeof file!=='string'||!file)throw new WispError('DISCORD005','Sticker file must be a project-relative path');
    return request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/stickers`,{...options(settings,'Sticker options') as Record<string,Value>,name},null,reason,[{path:file,key:'file'}]);
  }),
  endPoll:host((channelId,messageId)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/polls/${snowflake(messageId,'Message ID')}/expire`)),
  voters:host((channelId,messageId,answer,query=null)=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}/polls/${snowflake(messageId,'Message ID')}/answers/${answerId(answer)}`,null,query)),
  audit:host((guildId,query=null)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/audit-logs`,null,query)),
  guild:host(guildId=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}`)),
  user:host(userId=>request.call('GET',`/users/${snowflake(userId,'User ID')}`)),
  pins:host((channelId,query=null)=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}/messages/pins`,null,query)),
  pin:host((channelId,messageId,reason=null)=>request.call('PUT',`/channels/${snowflake(channelId,'Channel ID')}/messages/pins/${snowflake(messageId,'Message ID')}`,null,null,reason)),
  unpin:host((channelId,messageId,reason=null)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/pins/${snowflake(messageId,'Message ID')}`,null,null,reason)),
  react:host((channelId,messageId,name)=>request.call('PUT',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions/${emoji(name)}/@me`)),
  unreact:host((channelId,messageId,name)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions/${emoji(name)}/@me`)),
  addRole:host((guildId,userId,roleId,reason=null)=>request.call('PUT',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}/roles/${snowflake(roleId,'Role ID')}`,null,null,reason)),
  removeRole:host((guildId,userId,roleId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}/roles/${snowflake(roleId,'Role ID')}`,null,null,reason)),
  kick:host((guildId,userId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,null,null,reason)),
  ban:host((guildId,userId,reason=null,settings={})=>request.call('PUT',`/guilds/${snowflake(guildId,'Guild ID')}/bans/${snowflake(userId,'User ID')}`,options(settings,'Ban options'),null,reason)),
  unban:host((guildId,userId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/bans/${snowflake(userId,'User ID')}`,null,null,reason)),
  permissions:permissionApi(),
  channels:record({...resources.channels,
    list:host(guildId=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/channels`)),
    get:host(channelId=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}`)),
    create:host((guildId,data,reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/channels`,options(data,'Channel options'),null,reason)),
    edit:host((channelId,data,reason=null)=>request.call('PATCH',`/channels/${snowflake(channelId,'Channel ID')}`,options(data,'Channel options'),null,reason)),
    delete:host((channelId,reason=null)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}`,null,null,reason)),
    setPermissions:host((channelId,targetId,data,reason=null)=>request.call('PUT',`/channels/${snowflake(channelId,'Channel ID')}/permissions/${snowflake(targetId,'Role or member ID')}`,permissionOverwrite(data),null,reason)),
    deletePermissions:host((channelId,targetId,reason=null)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/permissions/${snowflake(targetId,'Role or member ID')}`,null,null,reason))
  }),
  roles:record({...resources.roles,
    list:host(guildId=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/roles`)),
    get:host((guildId,roleId)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/roles/${snowflake(roleId,'Role ID')}`)),
    create:host((guildId,data,reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/roles`,options(data,'Role options'),null,reason)),
    edit:host((guildId,roleId,data,reason=null)=>request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/roles/${snowflake(roleId,'Role ID')}`,options(data,'Role options'),null,reason)),
    delete:host((guildId,roleId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/roles/${snowflake(roleId,'Role ID')}`,null,null,reason))
  }),
  members:record({...resources.members,
    get:host((guildId,userId)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`)),
    edit:host((guildId,userId,data,reason=null)=>request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,options(data,'Member options'),null,reason)),
    addRole:host((guildId,userId,roleId,reason=null)=>request.call('PUT',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}/roles/${snowflake(roleId,'Role ID')}`,null,null,reason)),
    removeRole:host((guildId,userId,roleId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}/roles/${snowflake(roleId,'Role ID')}`,null,null,reason)),
    kick:host((guildId,userId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/members/${snowflake(userId,'User ID')}`,null,null,reason))
  }),
  bans:record({...resources.bans,
    list:host((guildId,query=null)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/bans`,null,query)),
    get:host((guildId,userId)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/bans/${snowflake(userId,'User ID')}`)),
    create:host((guildId,userId,data={},reason=null)=>request.call('PUT',`/guilds/${snowflake(guildId,'Guild ID')}/bans/${snowflake(userId,'User ID')}`,options(data,'Ban options'),null,reason)),
    delete:host((guildId,userId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/bans/${snowflake(userId,'User ID')}`,null,null,reason))
  }),
  messages:record({...resources.messages,
    list:host((channelId,query=null)=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}/messages`,null,query)),
    get:host((channelId,messageId)=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}`)),
    send:host((channelId,data,files=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/messages`,messageOptions(data),null,null,files)),
    edit:host((channelId,messageId,data,files=null)=>request.call('PATCH',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}`,messageOptions(data),null,null,files)),
    delete:host((channelId,messageId,reason=null)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}`,null,null,reason))
  }),
  reactions:record({...resources.reactions,
    add:host((channelId,messageId,name)=>request.call('PUT',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions/${emoji(name)}/@me`)),
    removeOwn:host((channelId,messageId,name)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions/${emoji(name)}/@me`)),
    list:host((channelId,messageId,name,query=null)=>request.call('GET',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions/${emoji(name)}`,null,query)),
    clear:host((channelId,messageId)=>request.call('DELETE',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/reactions`))
  }),
  threads:record({...resources.threads,
    create:host((channelId,data,reason=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/threads`,options(data,'Thread options'),null,reason)),
    createFromMessage:host((channelId,messageId,data,reason=null)=>request.call('POST',`/channels/${snowflake(channelId,'Channel ID')}/messages/${snowflake(messageId,'Message ID')}/threads`,options(data,'Thread options'),null,reason)),
    join:host(threadId=>request.call('PUT',`/channels/${snowflake(threadId,'Thread ID')}/thread-members/@me`)),
    leave:host(threadId=>request.call('DELETE',`/channels/${snowflake(threadId,'Thread ID')}/thread-members/@me`)),
    addMember:host((threadId,userId)=>request.call('PUT',`/channels/${snowflake(threadId,'Thread ID')}/thread-members/${snowflake(userId,'User ID')}`)),
    removeMember:host((threadId,userId)=>request.call('DELETE',`/channels/${snowflake(threadId,'Thread ID')}/thread-members/${snowflake(userId,'User ID')}`))
  }),
  events:record({...resources.events,
    list:host((guildId,query=null)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events`,null,query)),
    get:host((guildId,eventId,query=null)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events/${snowflake(eventId,'Event ID')}`,null,query)),
    create:host((guildId,data,reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events`,options(data,'Event options'),null,reason)),
    edit:host((guildId,eventId,data,reason=null)=>request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events/${snowflake(eventId,'Event ID')}`,options(data,'Event options'),null,reason)),
    delete:host((guildId,eventId)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events/${snowflake(eventId,'Event ID')}`)),
    users:host((guildId,eventId,query=null)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/scheduled-events/${snowflake(eventId,'Event ID')}/users`,null,query))
  }),
  automod:record({...resources.automod,
    list:host(guildId=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/auto-moderation/rules`)),
    get:host((guildId,ruleId)=>request.call('GET',`/guilds/${snowflake(guildId,'Guild ID')}/auto-moderation/rules/${snowflake(ruleId,'Rule ID')}`)),
    create:host((guildId,data,reason=null)=>request.call('POST',`/guilds/${snowflake(guildId,'Guild ID')}/auto-moderation/rules`,options(data,'Auto Moderation options'),null,reason)),
    edit:host((guildId,ruleId,data,reason=null)=>request.call('PATCH',`/guilds/${snowflake(guildId,'Guild ID')}/auto-moderation/rules/${snowflake(ruleId,'Rule ID')}`,options(data,'Auto Moderation options'),null,reason)),
    delete:host((guildId,ruleId,reason=null)=>request.call('DELETE',`/guilds/${snowflake(guildId,'Guild ID')}/auto-moderation/rules/${snowflake(ruleId,'Rule ID')}`,null,null,reason))
  })}) as Value;
}
