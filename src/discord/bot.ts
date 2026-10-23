import {Client,GatewayIntentBits,GuildMember,type PartialGuildMember,type User,type Message,type ChatInputCommandInteraction,type ButtonInteraction,type StringSelectMenuInteraction,type UserSelectMenuInteraction,type RoleSelectMenuInteraction,type ChannelSelectMenuInteraction,type ModalSubmitInteraction} from 'discord.js';
import {watch,type FSWatcher} from 'node:fs';
import type {CompiledProject} from '../project/discovery.js';
import type {ProjectConfig} from '../project/manifest.js';
import {ReloadableProject} from '../project/reload.js';
import {moduleResolver} from '../project/modules.js';
import {execute,host,record,type Value} from '../runtime/interpreter.js';
import {jsonApi,mathApi,storageApi,timeApi} from '../runtime/stdlib.js';
import {Storage} from '../storage/sqlite.js';
import {Scheduler} from '../runtime/scheduler.js';
import type {Stmt} from '../compiler/ast.js';
import {RankingService,type RankedMember} from './ranking.js';
import {ResponseState} from './responses.js';
import {ComponentRegistry} from './components.js';
import {commandPermissions} from './permissions.js';
import {EventGate} from './events.js';
import {WispError} from '../diagnostics.js';

function userValue(user:User):Value{return record({id:user.id,name:user.displayName,username:user.username,bot:user.bot,createdAt:user.createdAt.toISOString(),mention:`<@${user.id}>`}) as Value;}
function memberValue(member:GuildMember|PartialGuildMember):Value{return record({id:member.id,name:member.displayName,nickname:member.nickname??null,username:member.user.username,bot:member.user.bot,createdAt:member.user.createdAt.toISOString(),joinedAt:member.joinedAt?.toISOString()??null,roles:'roles' in member&&'cache' in member.roles?[...member.roles.cache.values()].map(r=>record({id:r.id,name:r.name})):[],permissions:member.permissions?.bitfield?.toString()??null,mention:`<@${member.id}>`}) as Value;}
function rankedValue(member:RankedMember):Value{return record({...member}) as Value;}
function messageValue(message:Message):Value{return record({id:message.id,content:message.content||null,author:userValue(message.author),channelId:message.channelId,guildId:message.guildId,createdAt:message.createdAt.toISOString()}) as Value;}
function safe(error:unknown):string{return error instanceof WispError?`${error.code} ${error.message}${error.frames.length?` | ${error.frames.map(frame=>`${frame.file??'<source>'}:${frame.line}:${frame.column}`).join(' <- ')}`:error.line?` at ${error.line}:${error.column??1}`:''}`:'Unexpected host error';}

export async function runBot(project:ProjectConfig,compiled:CompiledProject,dev=false,reload?:()=>CompiledProject):Promise<void>{
  const configured=project.manifest.discord.intents;
  const intents=[GatewayIntentBits.Guilds];
  if(configured.includes('guild_members'))intents.push(GatewayIntentBits.GuildMembers);
  if(configured.includes('guild_messages'))intents.push(GatewayIntentBits.GuildMessages);
  if(configured.includes('message_content'))intents.push(GatewayIntentBits.MessageContent);
  const client=new Client({intents}),storage=new Storage(project.paths.database),ranking=new RankingService(storage),registry=new ReloadableProject(compiled,reload??(()=>compiled));
  const watchers:FSWatcher[]=[],inFlight=new Set<Promise<void>>(),eventGate=new EventGate(32);let stopped=false;
  const log=(level:string,message:string)=>{const order=['debug','info','warn','error'];if(order.indexOf(level)<order.indexOf(project.manifest.logging.level))return;console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}`);};
  const scheduler=new Scheduler((name,error)=>log('error',`Task ${name}: ${safe(error)}`));
  storage.cleanupComponents();
  const componentCleanup=setInterval(()=>{try{storage.cleanupComponents();}catch(error){log('error',`Component cleanup: ${safe(error)}`);}},60*60*1000);
  componentCleanup.unref();
  const track=(promise:Promise<void>)=>{inFlight.add(promise);void promise.then(()=>inFlight.delete(promise),()=>inFlight.delete(promise));};
  const logApi=record(Object.fromEntries(['info','warn','error','debug'].map(level=>[level,host(value=>{log(level,String(value));return null;})]))) as Value;
  const common=(scope:string)=>({storage:storageApi(storage,scope),time:timeApi(),math:mathApi(),json:jsonApi(),log:logApi,scheduler:record({cancel:host(name=>{if(typeof name!=='string')throw new WispError('SCHEDULE001','Task name must be a string');return scheduler.cancel(name);})}) as Value});
  const schedule=(file:string)=>(name:string,seconds:number,repeat:boolean,body:Stmt[])=>scheduler.schedule(name,seconds,repeat,async()=>{const work=execute(body,{values:common(`task:${name}`),file,timeoutMs:10000,maxSteps:10000,maxLoops:10000,resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:common(`task:${name}`)})}).then(()=>{});track(work);await work;});
  async function dispatchEvent(name:string,data:Record<string,Value>):Promise<void>{if(stopped)return;const accepted=await eventGate.run(async()=>{for(const handler of registry.value.events.filter(e=>e.name===name)){try{const started=Date.now();await execute(handler.body,{values:{...common(handler.file),event:record(data) as Value},file:handler.file,schedule:schedule(handler.file),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:common(handler.file)}),timeoutMs:10000,maxSteps:10000,maxLoops:10000});log('debug',`Event ${name} completed in ${Date.now()-started} ms`);}catch(error){log('error',`${handler.file}: ${safe(error)}`);}}});if(!accepted)log('warn',`Event ${name} dropped at concurrency limit`);}
  client.once('clientReady',()=>{log('info','Connected to Discord');track(dispatchEvent('ready',{}));});
  client.on('guildMemberAdd',member=>{ranking.invalidate(member.guild.id);track(dispatchEvent('member_join',{member:memberValue(member)}));});
  client.on('guildMemberRemove',member=>{ranking.invalidate(member.guild.id);track(dispatchEvent('member_leave',{member:memberValue(member)}));});
  client.on('messageCreate',message=>{track(dispatchEvent('message_create',{message:messageValue(message)}));});
  client.on('messageUpdate',(_old,message)=>{if(message.partial)return;track(dispatchEvent('message_update',{message:messageValue(message)}));});
  client.on('messageDelete',message=>{if(message.partial)return;track(dispatchEvent('message_delete',{message:messageValue(message)}));});
  client.on('interactionCreate',interaction=>{if(stopped)return;if(interaction.isChatInputCommand())track(handle(interaction));else if(interaction.isButton()||interaction.isStringSelectMenu()||interaction.isUserSelectMenu()||interaction.isRoleSelectMenu()||interaction.isChannelSelectMenu()||interaction.isModalSubmit())track(handleComponent(interaction));});
  async function handle(interaction:ChatInputCommandInteraction):Promise<void>{const response=new ResponseState(interaction);const command=registry.value.commands.find(c=>c.name===interaction.commandName);try{
      if(!command)throw new WispError('COMMAND001','Command is not loaded; run wisp commands sync');
      const guild=interaction.guild;if(!guild)throw new WispError('DISCORD005','Command requires a server');const components=new ComponentRegistry(storage,guild.id,interaction.user.id);
      if(project.manifest.discord.commands.scope==='guild'&&guild.id!==project.manifest.discord.commands.guild_id)throw new WispError('DISCORD005','Command invoked outside configured guild');
      const permission=command.permission?commandPermissions[command.permission]:command.defaultMemberPermissions?BigInt(command.defaultMemberPermissions):undefined;
      if(permission!==undefined&&(!interaction.memberPermissions||!interaction.memberPermissions.has(permission)))throw new WispError('DISCORD005','Insufficient member permissions');
      const optionValues:Record<string,Value>=Object.create(null);
      for(const option of command.options){let value:Value=null;switch(option.type){
        case 'user':{const user=interaction.options.getUser(option.name),member=interaction.options.getMember(option.name);value=user?(member instanceof GuildMember?memberValue(member):userValue(user)):null;break;}
        case 'role':{const role=interaction.options.getRole(option.name);value=role?record({id:role.id,name:role.name,mention:`<@&${role.id}>`}) as Value:null;break;}
        case 'channel':{const channel=interaction.options.getChannel(option.name);value=channel?record({id:channel.id,name:'name' in channel?channel.name:null,mention:`<#${channel.id}>`}) as Value:null;break;}
        case 'string':value=interaction.options.getString(option.name);break;
        case 'integer':value=interaction.options.getInteger(option.name);break;
        case 'number':value=interaction.options.getNumber(option.name);break;
        case 'boolean':value=interaction.options.getBoolean(option.name);break;
      }if(option.required&&value===null)throw new WispError('DISCORD005',`Required option ${option.name} missing`);optionValues[option.name]=value;}
      const author=interaction.member instanceof GuildMember?memberValue(interaction.member):userValue(interaction.user);
      const guildValue=record({id:guild.id,name:guild.name,memberCount:guild.memberCount,
        member:host(async id=>{if(typeof id!=='string')throw new WispError('RUNTIME002','member ID must be a string');try{return memberValue(await guild.members.fetch(id));}catch{return null;}}),
        members:host(async()=>{const list=await ranking.roster(guild,(n,total)=>log('info',`Fetched ${n}/${total} members`));if(list.length>10000)throw new WispError('DISCORD005','Member list exceeds language limit');return list.map(rankedValue);}),
        joinRank:host(async member=>{const id=(member as Record<string,Value>)?.id;if(typeof id!=='string')throw new WispError('RUNTIME002','joinRank requires a member');return ranking.joinRank(guild,id);}),
        firstMembers:host(async(count,includeBots=true)=>(await ranking.firstMembers(guild,Number(count),includeBots!==false)).map(rankedValue)),
        lastMembers:host(async(count,includeBots=true)=>(await ranking.lastMembers(guild,Number(count),includeBots!==false)).map(rankedValue)),
        joinPage:host(async(page,count=10,includeBots=true)=>{const result=await ranking.page(guild,Number(page),Number(count),includeBots!==false);return record({...result,members:result.members.map(rankedValue)}) as Value;})
      }) as Value;
      const interactionValue=record({user:author,guildId:guild.id,channelId:interaction.channelId,commandName:interaction.commandName,createdAt:interaction.createdAt.toISOString(),options:record(optionValues),
        defer:host(async(ephemeral=true)=>{await response.defer(ephemeral!==false);return null;}),
        followUp:host(async(content,ephemeral=false)=>{if(typeof content!=='string')throw new WispError('RUNTIME002','followUp text must be string');await response.followUp({content,ephemeral:ephemeral===true});return null;})
      }) as Value;
      const started=Date.now();await execute(command.execute,{values:{...common(command.name),interaction:interactionValue,options:record(optionValues) as Value,guild:guildValue},file:command.file,reply:body=>response.send({...body,components:body.components?.length?components.buildRows(body.components):undefined}),showModal:modal=>response.showModal(components.buildModal(modal)),schedule:schedule(command.file),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:common(command.name)}),timeoutMs:command.timeoutMs??15000,maxSteps:10000,maxLoops:10000});
      await response.finish();log('debug',`Command /${command.name} completed in ${Date.now()-started} ms`);
    }catch(error){const incident=Math.random().toString(36).slice(2,10);log('error',`${command?.file??'<registry>'}: Incident ${incident}: ${safe(error)}`);try{if(response.responded)await response.followUp({content:`Command failed. Incident ${incident}`,ephemeral:true});else await response.send({content:`Command failed. Incident ${incident}`,ephemeral:true});}catch{log('error',`Could not send incident ${incident}`);}}finally{response.close();}}
  type ComponentInteraction=ButtonInteraction|StringSelectMenuInteraction|UserSelectMenuInteraction|RoleSelectMenuInteraction|ChannelSelectMenuInteraction|ModalSubmitInteraction;
  async function handleComponent(interaction:ComponentInteraction):Promise<void>{
    const response=new ResponseState(interaction as unknown as ConstructorParameters<typeof ResponseState>[0]);
    const kind=interaction.isButton()?'button':interaction.isStringSelectMenu()?'select':interaction.isUserSelectMenu()?'user_select':interaction.isRoleSelectMenu()?'role_select':interaction.isChannelSelectMenu()?'channel_select':'modal';
    try{
      if(interaction.applicationId!==project.manifest.discord.application_id)throw new WispError('COMPONENT002','Application mismatch');
      const components=new ComponentRegistry(storage,interaction.guildId??'',interaction.user.id);
      const state=components.resolve(interaction.customId,kind,interaction.guildId,interaction.user.id);
      const handler=registry.value.events.find(event=>event.name===`${kind}:${state.name}`);
      if(!handler)throw new WispError('COMPONENT002','This component handler is no longer available');
      const values=interaction.isStringSelectMenu()||interaction.isUserSelectMenu()||interaction.isRoleSelectMenu()||interaction.isChannelSelectMenu()?interaction.values:[];
      const inputFields:Record<string,Value>=Object.create(null);
      if(interaction.isModalSubmit())for(const field of interaction.fields.fields.values())if('value' in field&&typeof field.value==='string')inputFields[field.customId]=field.value;
      const interactionValue=record({user:userValue(interaction.user),guildId:interaction.guildId,channelId:interaction.channelId,kind,name:state.name,values,fields:record(inputFields),state:record(state.state)}) as Value;
      await execute(handler.body,{values:{...common(`component:${state.name}`),interaction:interactionValue},file:handler.file,reply:body=>response.send({...body,components:body.components?.length?components.buildRows(body.components):undefined}),showModal:modal=>response.showModal(components.buildModal(modal)),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:common(`component:${state.name}`)}),timeoutMs:15000,maxSteps:10000,maxLoops:10000});
      await response.finish();
    }catch(error){const incident=Math.random().toString(36).slice(2,10);log('error',`Component incident ${incident}: ${safe(error)}`);try{if(response.responded)await response.followUp({content:`Interaction failed. Incident ${incident}`,ephemeral:true});else await response.send({content:`Interaction unavailable or failed. Incident ${incident}`,ephemeral:true});}catch{log('error',`Could not acknowledge component incident ${incident}`);}}finally{response.close();}
  }
  if(dev&&reload){let pending:NodeJS.Timeout|undefined;watchers.push(watch(project.root,{recursive:true},(_event,filename)=>{const changed=String(filename??'').replaceAll('\\','/');if(!changed.endsWith('.wisp')||/^(?:dist|data|node_modules|\.wisp)\//.test(changed))return;clearTimeout(pending);pending=setTimeout(()=>{const result=registry.reload();if(result.ok){scheduler.clear();track(dispatchEvent('ready',{}));log('info','Scripts reloaded; run wisp commands sync if metadata changed');}else log('error',`Reload failed; retaining prior handlers: ${safe(result.error)}`);},200);}));}
  const stop=async()=>{if(stopped)return;stopped=true;clearInterval(componentCleanup);scheduler.close();for(const watcher of watchers)watcher.close();log('info','Shutting down');let timeout:NodeJS.Timeout|undefined;await Promise.race([Promise.allSettled([...inFlight]),new Promise<void>(resolve=>{timeout=setTimeout(resolve,5000);})]);clearTimeout(timeout);client.destroy();storage.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
  try{await client.login(project.manifest.discord.token);}catch{await stop();throw new WispError('DISCORD005','Discord login failed; check token and application configuration');}
}
