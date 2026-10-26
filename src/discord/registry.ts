import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ApplicationCommandOptionType,ApplicationCommandType,REST,Routes} from 'discord.js';
import type {CommandDecl,OptionDecl} from '../compiler/ast.js';
import {WispError} from '../diagnostics.js';
import {commandPermissions} from './permissions.js';
import type {ProjectConfig} from '../project/manifest.js';
export interface OptionPayload {name:string;description:string;type:number;required?:boolean;choices?:{name:string;value:string}[];min_value?:number;max_value?:number;autocomplete?:boolean;options?:OptionPayload[]}
export interface CommandPayload {name:string;description:string;type:number;options?:OptionPayload[];default_member_permissions?:string}
export interface RemoteCommand extends CommandPayload {id:string}
export interface DiffItem {kind:'add'|'update'|'same'|'remove'|'remote'|'conflict';name:string;type:number;local?:CommandPayload;remote?:RemoteCommand}
export function commandLabel(type:number,name:string):string{return type===ApplicationCommandType.User?`user command "${name}"`:type===ApplicationCommandType.Message?`message command "${name}"`:`/${name}`;}
const optionTypes:Record<string,number>={user:ApplicationCommandOptionType.User,string:ApplicationCommandOptionType.String,integer:ApplicationCommandOptionType.Integer,number:ApplicationCommandOptionType.Number,boolean:ApplicationCommandOptionType.Boolean,role:ApplicationCommandOptionType.Role,channel:ApplicationCommandOptionType.Channel};
const optionPayload=(o:OptionDecl):OptionPayload=>({name:o.name,description:o.description,type:optionTypes[o.type]!,required:o.required,...(o.choices?{choices:o.choices.map(v=>({name:v,value:v}))}:{}),...(o.min!==undefined?{min_value:o.min}:{}),...(o.max!==undefined?{max_value:o.max}:{}),...(o.suggest?{autocomplete:true}:{})});
function subcommandOptions(command:CommandDecl):OptionPayload[]{const out:OptionPayload[]=[];for(const sub of command.subcommands!){const leaf:OptionPayload={name:sub.name,description:sub.description,type:ApplicationCommandOptionType.Subcommand,options:sub.options.map(optionPayload)};if(!sub.group){out.push(leaf);continue;}let group=out.find(o=>o.type===ApplicationCommandOptionType.SubcommandGroup&&o.name===sub.group);if(!group){group={name:sub.group,description:sub.groupDescription!,type:ApplicationCommandOptionType.SubcommandGroup,options:[]};out.push(group);}group.options!.push(leaf);}return out;}
export function payload(command:CommandDecl):CommandPayload{const permissions=command.defaultMemberPermissions||command.permission?{default_member_permissions:command.defaultMemberPermissions??String(commandPermissions[command.permission!])}:{};if(command.type)return {name:command.name,description:'',type:command.type==='user'?ApplicationCommandType.User:ApplicationCommandType.Message,...permissions};return {name:command.name,description:command.description,type:ApplicationCommandType.ChatInput,options:command.subcommands?subcommandOptions(command):command.options.map(optionPayload),...permissions};}
const normalOption=(o:OptionPayload):unknown=>({name:o.name,description:o.description,type:o.type,required:o.required??false,choices:o.choices?.map(v=>({name:v.name,value:v.value}))??[],min_value:o.min_value??null,max_value:o.max_value??null,autocomplete:o.autocomplete??false,options:(o.options??[]).map(normalOption)});
const normalized=(c:CommandPayload)=>JSON.stringify({name:c.name,description:c.description??'',type:c.type,options:(c.options??[]).map(normalOption),default_member_permissions:c.default_member_permissions??null});
const commandTypes=new Set<number>([ApplicationCommandType.ChatInput,ApplicationCommandType.User,ApplicationCommandType.Message]);
const commandKey=(c:{type?:number;name:string})=>`${c.type??ApplicationCommandType.ChatInput}:${c.name}`;
export function diffCommands(local:CommandPayload[],remote:RemoteCommand[],owned:string[]=[]):DiffItem[]{const byKey=new Map(remote.filter(r=>commandTypes.has(r.type??ApplicationCommandType.ChatInput)).map(r=>[commandKey(r),r]));const result:DiffItem[]=[];for(const command of local){const key=commandKey(command),old=byKey.get(key);result.push({kind:!old?'add':!owned.includes(old.id)?'conflict':normalized(command)===normalized(old)?'same':'update',name:command.name,type:command.type,local:command,remote:old});byKey.delete(key);}for(const old of byKey.values())result.push({kind:owned.includes(old.id)?'remove':'remote',name:old.name,type:old.type??ApplicationCommandType.ChatInput,remote:old});return result.sort((a,b)=>a.type-b.type||a.name.localeCompare(b.name));}
export interface CommandApi {list():Promise<RemoteCommand[]>;create(c:CommandPayload):Promise<RemoteCommand>;update(id:string,c:CommandPayload):Promise<RemoteCommand>;delete(id:string):Promise<void>}
export function discordCommandApi(project:ProjectConfig):CommandApi{const d=project.manifest.discord;const rest=new REST({version:'10'}).setToken(d.token);const base=d.commands.scope==='guild'?Routes.applicationGuildCommands(d.application_id,d.commands.guild_id!):Routes.applicationCommands(d.application_id);const one=(id:string)=>d.commands.scope==='guild'?Routes.applicationGuildCommand(d.application_id,d.commands.guild_id!,id):Routes.applicationCommand(d.application_id,id);return {list:async()=>await rest.get(base) as RemoteCommand[],create:async c=>await rest.post(base,{body:c}) as RemoteCommand,update:async(id,c)=>await rest.patch(one(id),{body:c}) as RemoteCommand,delete:async id=>{await rest.delete(one(id));}};}
interface Ledger {scope:string;application_id:string;guild_id?:string;ids:string[]}
function ledgerPath(p:ProjectConfig){return join(p.root,'.wisp','command-state.json');}
export function readLedger(p:ProjectConfig):string[]{const path=ledgerPath(p);if(!existsSync(path))return [];try{const data=JSON.parse(readFileSync(path,'utf8')) as Ledger;if(data.scope!==p.manifest.discord.commands.scope||data.application_id!==p.manifest.discord.application_id||data.guild_id!==p.manifest.discord.commands.guild_id)throw new Error('scope mismatch');return data.ids;}catch{throw new WispError('REGISTRY004','Command state ledger is invalid or belongs to another scope');}}
function saveLedger(p:ProjectConfig,ids:string[]):void{const path=ledgerPath(p);mkdirSync(join(p.root,'.wisp'),{recursive:true});const d=p.manifest.discord;writeFileSync(path,JSON.stringify({scope:d.commands.scope,application_id:d.application_id,guild_id:d.commands.guild_id,ids:[...new Set(ids)].sort()},null,2));}
export async function preview(p:ProjectConfig,local:CommandPayload[],api:CommandApi):Promise<DiffItem[]>{return diffCommands(local,await api.list(),readLedger(p));}
export async function sync(p:ProjectConfig,local:CommandPayload[],api:CommandApi,prune=false):Promise<{added:number;updated:number;removed:number;registered:number;total:number}>{
  const changes=await preview(p,local,api);
  if(changes.some(item=>item.kind==='conflict'))throw new WispError('REGISTRY004','Remote command name conflicts with a command not owned by this project');
  const ids=new Set(readLedger(p));
  let added=0,updated=0,removed=0,registered=0;
  for(const item of changes){
    try{
      if(item.kind==='add'){const created=await api.create(item.local!);ids.add(created.id);added++;registered++;}
      else if(item.kind==='update'){const changed=await api.update(item.remote!.id,item.local!);ids.add(changed.id);updated++;registered++;}
      else if(item.kind==='same'){ids.add(item.remote!.id);registered++;}
      else if(item.kind==='remove'&&prune){await api.delete(item.remote!.id);ids.delete(item.remote!.id);removed++;}
      saveLedger(p,[...ids]);
    }catch(error){
      const detail=error instanceof Error?error.message:'Discord request failed';
      throw new WispError('REGISTRY004',`Sync stopped at ${commandLabel(item.type,item.name)}; ${registered}/${local.length} local commands confirmed. ${detail}`);
    }
  }
  return {added,updated,removed,registered,total:local.length};
}
