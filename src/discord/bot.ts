import {Client,GatewayIntentBits,Partials,GuildMember,type PartialGuildMember,type User,type Message,type ChatInputCommandInteraction,type ContextMenuCommandInteraction,type AutocompleteInteraction,type ButtonInteraction,type StringSelectMenuInteraction,type UserSelectMenuInteraction,type RoleSelectMenuInteraction,type ChannelSelectMenuInteraction,type ModalSubmitInteraction} from 'discord.js';
import {watch,type FSWatcher} from 'node:fs';
import {commandRoute,componentIndex,findCommand,findComponentHandler,type CompiledProject} from '../project/discovery.js';
import type {ProjectConfig} from '../project/manifest.js';
import {ReloadableProject} from '../project/reload.js';
import {moduleResolver} from '../project/modules.js';
import {ROLE_MENU,execute,host,record,type ExecutionContext,type Value} from '../runtime/interpreter.js';
import {standardGlobals} from '../runtime/globals.js';
import {dataApi,guildDataApi,memberDataScope} from '../runtime/stdlib.js';
import {HttpClient,type HttpLimits} from '../runtime/http.js';
import {DatabaseManager} from '../storage/manager.js';
import {RedisDatabase} from '../storage/external.js';
import {Scheduler} from '../runtime/scheduler.js';
import {planRestore} from '../runtime/tasks.js';
import type {OptionDecl,Stmt} from '../compiler/ast.js';
import {suggestionChoices,suggestTimeoutMs} from './suggest.js';
import {checkCooldown} from './cooldowns.js';
import {RankingService,type RankedMember} from './ranking.js';
import {ResponseState,buildEmbed} from './responses.js';
import {PAGE_ID,startPages,turnPage} from './pages.js';
import {roleChanges,roleSummary} from './roles.js';
import {ComponentRegistry,linkSentMessage} from './components.js';
import type {ComponentOwner,StorageBackend,TaskRow} from '../storage/types.js';
import {commandPermissions} from './permissions.js';
import {EventGate} from './events.js';
import {WispError} from '../diagnostics.js';
import {discordApi} from './api.js';
import {ExecutionTrace,writeTrace} from '../runtime/trace.js';
import {uiApi} from './ui.js';

function userValue(user:User):Value{return record({id:user.id,name:user.displayName,avatar:user.displayAvatarURL(),username:user.username,bot:user.bot,createdAt:user.createdAt.toISOString(),mention:`<@${user.id}>`}) as Value;}
function memberValue(member:GuildMember|PartialGuildMember,storage?:StorageBackend):Value{return record({...(storage?{data:dataApi(storage,memberDataScope(member.guild.id,member.id))}:{}),id:member.id,name:member.displayName,avatar:member.displayAvatarURL(),nickname:member.nickname??null,username:member.user.username,bot:member.user.bot,createdAt:member.user.createdAt.toISOString(),joinedAt:member.joinedAt?.toISOString()??null,roles:'roles' in member&&'cache' in member.roles?[...member.roles.cache.values()].map(r=>record({id:r.id,name:r.name,position:r.position})):[],highestRolePosition:'roles' in member&&'highest' in member.roles?member.roles.highest.position:null,permissions:member.permissions?.bitfield?.toString()??null,mention:`<@${member.id}>`}) as Value;}
function rankedValue(member:RankedMember):Value{return record({...member}) as Value;}
function messageValue(message:Message):Value{return record({id:message.id,content:message.content||null,author:userValue(message.author),channelId:message.channelId,guildId:message.guildId,createdAt:message.createdAt.toISOString()}) as Value;}
function safe(error:unknown):string{return error instanceof WispError?`${error.code} ${error.message}${error.frames.length?` | ${error.frames.map(frame=>`${frame.file??'<source>'}:${frame.line}:${frame.column}`).join(' <- ')}`:error.line?` at ${error.line}:${error.column??1}`:''}`:`Unexpected host error${error instanceof Error?` (${error.name}: ${error.message.slice(0,500)})`:''}`;}

export async function runBot(project:ProjectConfig,compiled:CompiledProject,dev=false,reload?:()=>CompiledProject):Promise<void>{
  const configured=project.manifest.discord.intents;
  const intentBits:Record<string,number>={guilds:GatewayIntentBits.Guilds,guild_members:GatewayIntentBits.GuildMembers,guild_moderation:GatewayIntentBits.GuildModeration,guild_expressions:GatewayIntentBits.GuildExpressions,guild_integrations:GatewayIntentBits.GuildIntegrations,guild_webhooks:GatewayIntentBits.GuildWebhooks,guild_invites:GatewayIntentBits.GuildInvites,guild_voice_states:GatewayIntentBits.GuildVoiceStates,guild_presences:GatewayIntentBits.GuildPresences,guild_messages:GatewayIntentBits.GuildMessages,guild_message_reactions:GatewayIntentBits.GuildMessageReactions,guild_message_typing:GatewayIntentBits.GuildMessageTyping,direct_messages:GatewayIntentBits.DirectMessages,direct_message_reactions:GatewayIntentBits.DirectMessageReactions,direct_message_typing:GatewayIntentBits.DirectMessageTyping,message_content:GatewayIntentBits.MessageContent,guild_scheduled_events:GatewayIntentBits.GuildScheduledEvents,auto_moderation_configuration:GatewayIntentBits.AutoModerationConfiguration,auto_moderation_execution:GatewayIntentBits.AutoModerationExecution,guild_message_polls:GatewayIntentBits.GuildMessagePolls,direct_message_polls:GatewayIntentBits.DirectMessagePolls};
  const intents=[...new Set([GatewayIntentBits.Guilds,...configured.map(name=>intentBits[name]!)])];
  const client=new Client({intents,partials:[Partials.Message]}),databases=await DatabaseManager.open(project),storage=databases.storage,ranking=new RankingService(storage),registry=new ReloadableProject(compiled,reload??(()=>compiled));
  const watchers:FSWatcher[]=[],inFlight=new Set<Promise<void>>(),eventGate=new EventGate(32);let stopped=false;
  const log=(level:string,message:string)=>{const order=['debug','info','warn','error'];if(order.indexOf(level)<order.indexOf(project.manifest.logging.level))return;console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}`);};
  const scheduler=new Scheduler((name,error)=>log('error',`Task ${name}: ${safe(error)}`),project.manifest.scheduler?.max_tasks??32);
  const onRejection=(reason:unknown)=>log('error',`Unhandled rejection: ${safe(reason)}`);
  client.on('error',error=>log('error',`Discord client: ${safe(error)}`));client.on('shardError',(error,shard)=>log('error',`Shard ${shard}: ${safe(error)}`));process.on('unhandledRejection',onRejection);
  for(const connection of databases.connections.values())if(connection instanceof RedisDatabase)connection.onError=message=>log('warn',message);
  await storage.cleanupComponents();await storage.cleanupCooldowns(Date.now());
  const componentCleanup=setInterval(()=>{void Promise.resolve(storage.cleanupComponents()).catch(error=>{log('error',`Component cleanup: ${safe(error)}`);});void Promise.resolve(storage.cleanupCooldowns(Date.now())).catch(error=>{log('error',`Cooldown cleanup: ${safe(error)}`);});},60*60*1000);
  componentCleanup.unref();
  const track=(promise:Promise<void>)=>{inFlight.add(promise);void promise.then(()=>inFlight.delete(promise),()=>inFlight.delete(promise));};
  const logApi=record(Object.fromEntries(['info','warn','error','debug'].map(level=>[level,host(value=>{log(level,String(value));return null;})]))) as Value;
  const httpClient=new HttpClient(project.manifest.http);
  const linkMessage=async(message:unknown)=>{try{await linkSentMessage(storage,message);}catch(error){log('warn',`Could not link components to message: ${safe(error)}`);}};
  const forget=(owner:ComponentOwner,ids:string[])=>track(Promise.resolve(storage.deleteComponentsFor(owner,ids)).then(count=>{if(count)log('debug',`Removed ${count} component rows for deleted ${owner}`);},error=>{log('warn',`Component cleanup for deleted ${owner}: ${safe(error)}`);}));
  const common=(scope:string,limits:HttpLimits={})=>({...standardGlobals({storage,db:databases.api(),discord:discordApi(client,project.root,linkMessage),log:logApi,http:httpClient},scope,limits),scheduler:record({cancel:host(async name=>{if(typeof name!=='string')throw new WispError('SCHEDULE001','Task name must be a string');const cancelled=scheduler.cancel(name);await storage.deleteTask(name);return cancelled;})}) as Value});
  const saveTask=(work:void|Promise<void>,name:string)=>track(Promise.resolve(work).catch(error=>{log('warn',`Could not save task ${name}: ${safe(error)}`);}));
  const runTask=(row:TaskRow,body:Stmt[])=>async(signal:AbortSignal):Promise<void>=>{const limits={deadline:Date.now()+10000,signal};const values={...common(`task:${row.name}`,limits),task:record({name:row.name,data:row.data===null?null:record(row.data)}) as Value};const work=execute(body,{values,file:row.file,timeoutMs:10000,maxSteps:10000,maxLoops:10000,signal,resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values})}).then(()=>{});track(work);await work;};
  const arm=(row:TaskRow,body:Stmt[],firstDelaySeconds:number)=>scheduler.schedule(row.name,row.intervalSeconds,row.repeat,runTask(row,body),{firstDelaySeconds,onFire:next=>saveTask(next===null?storage.deleteTask(row.name):storage.putTask({...row,fireAt:next}),row.name)});
  const schedule=(file:string)=>(name:string,seconds:number,repeat:boolean,body:Stmt[],meta?:{template:string;data:Record<string,Value>|null})=>{const row:TaskRow={name,file,template:meta?.template??name,repeat,intervalSeconds:seconds,fireAt:Date.now()+seconds*1000,data:meta?.data??null};arm(row,body,seconds);saveTask(storage.putTask(row),name);};
  /** Re-arm saved tasks. Runs missed while offline are skipped: one-shots are dropped and repeating tasks resume at their next interval. */
  async function restoreTasks():Promise<void>{let restored=0;for(const step of planRestore(await storage.listTasks(),registry.value.tasks,Date.now())){
    if(step.action==='drop'){log(step.reason==='missing'?'warn':'info',step.reason==='missing'?`Dropping saved task ${step.row.name}: no after/every named "${step.row.template}" exists anymore`:`Skipping task ${step.row.name}; it was due while the bot was offline`);await storage.deleteTask(step.row.name);continue;}
    if(step.moved)await storage.putTask(step.row);
    try{arm(step.row,step.body,step.delaySeconds);restored++;}catch(error){log('warn',`Could not restore task ${step.row.name}: ${safe(error)}`);}
  }if(restored)log('info',`Restored ${restored} saved task${restored===1?'':'s'}`);}
  async function dispatchEvent(name:string,data:Record<string,Value>):Promise<void>{if(stopped)return;const accepted=await eventGate.run(async()=>{for(const handler of registry.value.events.filter(e=>e.name===name)){try{const started=Date.now(),limits={deadline:started+10000};await execute(handler.body,{values:{...common(handler.file,limits),event:record(data) as Value},file:handler.file,schedule:schedule(handler.file),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:common(handler.file,limits)}),timeoutMs:10000,maxSteps:10000,maxLoops:10000});log('debug',`Event ${name} completed in ${Date.now()-started} ms`);}catch(error){log('error',`${handler.file}: ${safe(error)}`);}}});if(!accepted&&!stopped)log('warn',`Event ${name} dropped because the queue is full`);}
  client.once('clientReady',()=>{log('info','Connected to Discord');track(restoreTasks().catch(error=>{log('error',`Could not restore saved tasks: ${safe(error)}`);}).then(()=>dispatchEvent('ready',{})));});
  client.on('raw',packet=>{if(typeof packet.t!=='string'||!registry.value.events.some(event=>event.name===`gateway:${packet.t}`))return;try{const json=JSON.stringify(packet.d??null);if(json.length>1024*1024)throw new Error('Gateway payload exceeds limit');const data=JSON.parse(json) as Value;track(dispatchEvent(`gateway:${packet.t}`,{type:packet.t,data,sequence:typeof packet.s==='number'?packet.s:null}));}catch{log('warn',`Gateway event ${packet.t} could not be converted to Wisp data`);}});
  client.on('guildMemberAdd',member=>{ranking.invalidate(member.guild.id);track(dispatchEvent('member_join',{member:memberValue(member,storage)}));});
  client.on('guildMemberRemove',member=>{ranking.invalidate(member.guild.id);track(dispatchEvent('member_leave',{member:memberValue(member,storage)}));});
  client.on('messageCreate',message=>{if(message.author.id===client.user?.id)return;track(dispatchEvent('message_create',{message:messageValue(message)}));});
  client.on('messageUpdate',(_old,message)=>{if(message.partial||message.author.id===client.user?.id)return;track(dispatchEvent('message_update',{message:messageValue(message)}));});
  client.on('messageDelete',message=>{forget('message',[message.id]);if(message.partial)return;track(dispatchEvent('message_delete',{message:messageValue(message)}));});
  client.on('messageDeleteBulk',messages=>forget('message',[...messages.keys()]));
  client.on('channelDelete',channel=>forget('channel',[channel.id]));client.on('threadDelete',thread=>forget('channel',[thread.id]));client.on('guildDelete',guild=>forget('guild',[guild.id]));
  client.on('interactionCreate',interaction=>{if(stopped)return;if(interaction.isChatInputCommand()||interaction.isContextMenuCommand())track(handle(interaction));else if(interaction.isAutocomplete())track(handleSuggest(interaction));else if(interaction.isButton()||interaction.isStringSelectMenu()||interaction.isUserSelectMenu()||interaction.isRoleSelectMenu()||interaction.isChannelSelectMenu()||interaction.isModalSubmit())track(handleComponent(interaction));});
  function bindOptions(interaction:ChatInputCommandInteraction,options:OptionDecl[],storage:StorageBackend):Record<string,Value>{
    const optionValues:Record<string,Value>=Object.create(null);
    for(const option of options){let value:Value=null;switch(option.type){
      case 'user':{const user=interaction.options.getUser(option.name),member=interaction.options.getMember(option.name);value=user?(member instanceof GuildMember?memberValue(member,storage):userValue(user)):null;break;}
      case 'role':{const role=interaction.options.getRole(option.name);value=role?record({id:role.id,name:role.name,position:'position' in role?role.position:null,mention:`<@&${role.id}>`}) as Value:null;break;}
      case 'channel':{const channel=interaction.options.getChannel(option.name);value=channel?record({id:channel.id,name:'name' in channel?channel.name:null,mention:`<#${channel.id}>`}) as Value:null;break;}
      case 'string':value=interaction.options.getString(option.name);break;
      case 'integer':value=interaction.options.getInteger(option.name);break;
      case 'number':value=interaction.options.getNumber(option.name);break;
      case 'boolean':value=interaction.options.getBoolean(option.name);break;
    }if(option.required&&value===null)throw new WispError('DISCORD005',`Required option ${option.name} missing`);optionValues[option.name]=value;}
    return optionValues;}
  async function handle(interaction:ChatInputCommandInteraction|ContextMenuCommandInteraction):Promise<void>{const type=interaction.isChatInputCommand()?'slash':interaction.isUserContextMenuCommand()?'user':'message';const command=findCommand(registry.value.commands,type,interaction.commandName);const route=command&&(interaction.isChatInputCommand()?commandRoute(command,interaction.options.getSubcommandGroup(false),interaction.options.getSubcommand(false)):commandRoute(command));const label=type==='slash'?`/${route?.path??interaction.commandName}`:`${type} command "${interaction.commandName}"`;const response=new ResponseState(interaction as unknown as ConstructorParameters<typeof ResponseState>[0],undefined,command?.defer==='ephemeral',linkMessage);try{
      if(!command||!route)throw new WispError('COMMAND001','Command is not loaded; run wisp commands sync');
      const guild=interaction.guild;if(!guild)throw new WispError('DISCORD005','Command requires a server');const components=new ComponentRegistry(storage,guild.id,interaction.user.id);
      if(project.manifest.discord.commands.scope==='guild'&&guild.id!==project.manifest.discord.commands.guild_id)throw new WispError('DISCORD005','Command invoked outside configured guild');
      const permission=command.permission?commandPermissions[command.permission]:command.defaultMemberPermissions?BigInt(command.defaultMemberPermissions):undefined;
      if(permission!==undefined&&(!interaction.memberPermissions||!interaction.memberPermissions.has(permission)))throw new WispError('DISCORD005','Insufficient member permissions');
      const blocked=await checkCooldown(storage,route.cooldown,`${type}:${route.path}`,label,{user:interaction.user.id,guild:guild.id,channel:interaction.channelId});
      if(blocked){await response.send({content:blocked,ephemeral:true});await response.finish();return;}
      const optionValues=interaction.isChatInputCommand()?bindOptions(interaction,route.options,storage):Object.create(null) as Record<string,Value>;
      const target:Value=interaction.isUserContextMenuCommand()?(interaction.targetMember instanceof GuildMember?memberValue(interaction.targetMember,storage):userValue(interaction.targetUser)):interaction.isMessageContextMenuCommand()?messageValue(interaction.targetMessage):null;
      const author=interaction.member instanceof GuildMember?memberValue(interaction.member,storage):userValue(interaction.user);
      const guildValue=record({id:guild.id,name:guild.name,memberCount:guild.memberCount,...guildDataApi(storage,guild.id),
        member:host(async id=>{if(typeof id!=='string')throw new WispError('RUNTIME002','member ID must be a string');try{return memberValue(await guild.members.fetch(id),storage);}catch{return null;}}),
        members:host(async()=>{const list=await ranking.roster(guild,(n,total)=>log('info',`Fetched ${n}/${total} members`));if(list.length>10000)throw new WispError('DISCORD005','Member list exceeds language limit');return list.map(rankedValue);}),
        joinRank:host(async member=>{const id=(member as Record<string,Value>)?.id;if(typeof id!=='string')throw new WispError('RUNTIME002','joinRank requires a member');return ranking.joinRank(guild,id);}),
        firstMembers:host(async(count,includeBots=true)=>(await ranking.firstMembers(guild,Number(count),includeBots!==false)).map(rankedValue)),
        lastMembers:host(async(count,includeBots=true)=>(await ranking.lastMembers(guild,Number(count),includeBots!==false)).map(rankedValue)),
        joinPage:host(async(page,count=10,includeBots=true)=>{const result=await ranking.page(guild,Number(page),Number(count),includeBots!==false);return record({...result,members:result.members.map(rankedValue)}) as Value;})
      }) as Value;
      const interactionValue=record({user:author,guildId:guild.id,channelId:interaction.channelId,commandName:interaction.commandName,subcommand:route.subcommand,group:route.group,target,createdAt:interaction.createdAt.toISOString(),options:record(optionValues),
        defer:host(async(ephemeral=true)=>{await response.defer(ephemeral!==false);return null;}),
        followUp:host(async(content,ephemeral=false)=>{if(typeof content==='string')await response.followUp({content,ephemeral:ephemeral===true});else if(content&&typeof content==='object'&&!Array.isArray(content))await response.followUp({v2:content as Record<string,Value>,ephemeral:ephemeral===true});else throw new WispError('RUNTIME002','followUp requires text or a V2 message');return null;})
      }) as Value;
      const started=Date.now(),trace=dev?new ExecutionTrace(label):undefined;const values={...common(command.name,{deadline:Date.now()+(command.timeoutMs??15000)}),interaction:interactionValue,user:author,options:record(optionValues) as Value,target,guild:guildValue,ui:uiApi(components,async modal=>response.showModal(await components.buildModal(modal)))};const reply:NonNullable<ExecutionContext['reply']>=async body=>respond(response,components,body,guild.id,interaction.user.id);try{await execute(route.execute,{values,file:command.file,reply,showModal:async modal=>response.showModal(await components.buildModal(modal)),schedule:schedule(command.file),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values,reply}),timeoutMs:command.timeoutMs??15000,maxSteps:10000,maxLoops:10000,trace});}finally{if(trace)log('info',`Trace for ${label}: ${writeTrace(project.root,trace).html}`);}
      await response.finish();log('debug',`Command ${label} completed in ${Date.now()-started} ms`);
    }catch(error){const incident=Math.random().toString(36).slice(2,10);log('error',`${command?.file??'<registry>'}: Incident ${incident}: ${safe(error)}`);try{if(response.responded)await response.followUp({content:`Command failed. Incident ${incident}`,ephemeral:true});else await response.send({content:`Command failed. Incident ${incident}`,ephemeral:true});}catch{log('error',`Could not send incident ${incident}`);}}finally{response.close();}}
  async function handleSuggest(interaction:AutocompleteInteraction):Promise<void>{
    let choices:ReturnType<typeof suggestionChoices>=[];
    try{
      const command=findCommand(registry.value.commands,'slash',interaction.commandName);
      const route=command&&commandRoute(command,interaction.options.getSubcommandGroup(false),interaction.options.getSubcommand(false));
      const focused=interaction.options.getFocused(true);
      const option=route?.options.find(o=>o.name===focused.name);
      if(!command||!route||!option?.suggest)throw new WispError('COMMAND001',`No suggest: block for option ${focused.name}; run wisp commands sync`);
      const typed:Record<string,Value>=Object.create(null);for(const o of route.options){const raw=interaction.options.get(o.name)?.value;typed[o.name]=typeof raw==='string'||typeof raw==='number'||typeof raw==='boolean'?raw:null;}
      const interactionValue=record({user:userValue(interaction.user),guildId:interaction.guildId,channelId:interaction.channelId,commandName:interaction.commandName,subcommand:route.subcommand,group:route.group,focused:focused.name}) as Value;
      const values={...common(`suggest:${route.path}`,{deadline:Date.now()+suggestTimeoutMs}),interaction:interactionValue,typed:String(focused.value),options:record(typed) as Value};
      let result:Value=null;
      await execute(option.suggest,{values,file:command.file,onReturn:value=>{result=value;},resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values}),timeoutMs:suggestTimeoutMs,maxSteps:10000,maxLoops:10000});
      choices=suggestionChoices(result,option.type);
    }catch(error){log('error',`Suggestions for /${interaction.commandName} failed: ${safe(error)}`);}
    try{await interaction.respond(choices);}catch(error){log('warn',`Could not send suggestions: ${safe(error)}`);}
  }
  type Rows=Awaited<ReturnType<ComponentRegistry['buildRows']>>;
  /** Sends a script's reply; a `reply pages:` list is saved and opens on its first page. */
  async function respond(response:ResponseState,components:ComponentRegistry,body:Parameters<NonNullable<ExecutionContext['reply']>>[0],guildId:string,userId:string):Promise<void>{
    if(body.pages){const page=await startPages(storage,body.pages,guildId,userId);return response.send({embed:page.embed,ephemeral:body.ephemeral,components:page.components as unknown as Rows});}
    return response.send({...body,components:body.rawComponents?body.rawComponents as unknown as Rows:body.components?.length?await components.buildRows(body.components):undefined});
  }
  /** The built-in handler behind `roles:` menus. */
  async function pickRoles(interaction:StringSelectMenuInteraction,response:ResponseState):Promise<void>{
    const member=interaction.member;if(!(member instanceof GuildMember))throw new WispError('COMPONENT002','Role menus work only in servers');
    const changes=roleChanges(interaction.component.options.map(option=>option.value),interaction.values,[...member.roles.cache.keys()]);
    try{if(changes.add.length)await member.roles.add(changes.add,'Wisp role menu');if(changes.remove.length)await member.roles.remove(changes.remove,'Wisp role menu');}
    catch{throw new WispError('COMPONENT002','I cannot change those roles. Give me Manage Roles and move my role above the menu roles.');}
    await response.send({content:roleSummary(changes,id=>interaction.guild?.roles.cache.get(id)?.name??id),ephemeral:true});
  }
  type ComponentInteraction=ButtonInteraction|StringSelectMenuInteraction|UserSelectMenuInteraction|RoleSelectMenuInteraction|ChannelSelectMenuInteraction|ModalSubmitInteraction;
  async function handleComponent(interaction:ComponentInteraction):Promise<void>{
    const response=new ResponseState(interaction as unknown as ConstructorParameters<typeof ResponseState>[0],undefined,undefined,linkMessage);
    const kind=interaction.isButton()?'button':interaction.isStringSelectMenu()?'select':interaction.isUserSelectMenu()?'user_select':interaction.isRoleSelectMenu()?'role_select':interaction.isChannelSelectMenu()?'channel_select':'modal';
    try{
      if(interaction.applicationId!==project.manifest.discord.application_id)throw new WispError('COMPONENT002','Application mismatch');
      if(interaction.isButton()&&PAGE_ID.test(interaction.customId)){const page=await turnPage(storage,interaction.customId,interaction.guildId,interaction.user.id);await interaction.update({embeds:[buildEmbed(page.embed)],components:page.components as never});return;}
      if(interaction.isStringSelectMenu()&&interaction.customId===`sl:select:${ROLE_MENU}`){await pickRoles(interaction,response);await response.finish();return;}
      const components=new ComponentRegistry(storage,interaction.guildId??'',interaction.user.id);
      const state=await components.resolve(interaction.customId,kind,interaction.guildId,interaction.user.id);
      const handler=findComponentHandler(registry.value.events,kind,state.name);
      if(!handler)throw new WispError('COMPONENT002','This component handler is no longer available');
      const values=interaction.isStringSelectMenu()||interaction.isUserSelectMenu()||interaction.isRoleSelectMenu()||interaction.isChannelSelectMenu()?interaction.values:[];
      const inputFields:Record<string,Value>=Object.create(null);
      if(interaction.isModalSubmit())for(const field of interaction.fields.fields.values())if('value' in field&&typeof field.value==='string')inputFields[field.customId]=field.value;
      const interactionValue=record({user:userValue(interaction.user),guildId:interaction.guildId,channelId:interaction.channelId,kind,name:state.name,index:componentIndex(handler,state.name),values,fields:record(inputFields),state:record(state.state)}) as Value;
      const handlerValues={...common(`component:${state.name}`,{deadline:Date.now()+15000}),interaction:interactionValue,ui:uiApi(components,async modal=>response.showModal(await components.buildModal(modal)))};
      const reply:NonNullable<ExecutionContext['reply']>=async body=>respond(response,components,body,interaction.guildId??'',interaction.user.id);await execute(handler.body,{values:handlerValues,file:handler.file,reply,showModal:async modal=>response.showModal(await components.buildModal(modal)),resolveImport:moduleResolver(project.root,registry.value.modules??new Map(),{values:handlerValues,reply}),timeoutMs:15000,maxSteps:10000,maxLoops:10000});
      await response.finish();
    }catch(error){if(error instanceof WispError&&error.code==='COMPONENT002'&&!response.responded){try{await response.send({content:error.message,ephemeral:true});}catch{log('warn',`Could not explain component error: ${error.message}`);}return;}const incident=Math.random().toString(36).slice(2,10);log('error',`Component incident ${incident}: ${safe(error)}`);try{if(response.responded)await response.followUp({content:`Interaction failed. Incident ${incident}`,ephemeral:true});else await response.send({content:`Interaction unavailable or failed. Incident ${incident}`,ephemeral:true});}catch{log('error',`Could not acknowledge component incident ${incident}`);}}finally{response.close();}
  }
  if(dev&&reload){let pending:NodeJS.Timeout|undefined;watchers.push(watch(project.root,{recursive:true},(_event,filename)=>{const changed=String(filename??'').replaceAll('\\','/');if(!changed.endsWith('.wisp')||/^(?:dist|data|node_modules|\.wisp)\//.test(changed))return;clearTimeout(pending);pending=setTimeout(()=>{const result=registry.reload();if(result.ok){scheduler.clear();track(restoreTasks().catch(error=>{log('error',`Could not restore saved tasks: ${safe(error)}`);}).then(()=>dispatchEvent('ready',{})));log('info','Scripts reloaded; run wisp commands sync if metadata changed');}else log('error',`Reload failed; retaining prior handlers: ${safe(result.error)}`);},200);}));}
  const stop=async()=>{if(stopped)return;stopped=true;const queued=eventGate.queued;eventGate.close();clearInterval(componentCleanup);process.off('unhandledRejection',onRejection);scheduler.close();for(const watcher of watchers)watcher.close();log('info','Shutting down');if(queued)log('warn',`${queued} queued event handlers were discarded during shutdown`);let timeout:NodeJS.Timeout|undefined;await Promise.race([Promise.allSettled([...inFlight]),new Promise<void>(resolve=>{timeout=setTimeout(resolve,5000);})]);clearTimeout(timeout);if(inFlight.size)log('warn',`${inFlight.size} handlers remain active after the shutdown timeout`);client.destroy();await databases.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
  try{await client.login(project.manifest.discord.token);}catch(error){await stop();const reason=error instanceof Error&&/disallowed intents/i.test(error.message)?'; enable the privileged intents in the Developer Portal':error instanceof Error&&/token/i.test(error.message)?'; the token was rejected':'';throw new WispError('DISCORD005',`Discord login failed${reason}; check token and application configuration`);}
}
