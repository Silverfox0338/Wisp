import {randomBytes} from 'node:crypto';
import {WispError} from '../diagnostics.js';
import type {PagedReply,Value} from '../runtime/interpreter.js';
import type {StorageBackend} from '../storage/types.js';

/** Page buttons carry the stored list's ID and the page they open; the list row itself is `ss:<hex>`. */
export const PAGE_ID=/^pg:([a-f0-9]{32}):(\d{1,3})$/;
const STATE_LIMIT=16384;
export interface PageView {embed:Record<string,Value>;components?:Value[]}

function view(id:string|null,list:PagedReply,page:number):PageView{
  const count=list.pages.length;
  const embed:Record<string,Value>={...(list.title!==undefined?{title:list.title}:{}),description:list.pages[page-1]!,...(list.color!==undefined?{color:list.color}:{}),...(count>1?{footer:`Page ${page} of ${count}`}:{})};
  if(!id||count<2)return {embed};
  const button=(label:string,target:number,disabled:boolean)=>({type:2,style:2,label,custom_id:`pg:${id}:${target}`,disabled});
  return {embed,components:[{type:1,components:[button('◀',page-1,page===1),button('▶',page+1,page===count)]}]};
}

/** Saves a multi-page list and returns its first page. A single page needs no buttons and stores nothing. */
export async function startPages(storage:StorageBackend,list:PagedReply,guildId:string,ownerId:string):Promise<PageView>{
  if(list.pages.length<2)return view(null,list,1);
  const state={title:list.title??null,color:list.color??null,pages:list.pages} as Record<string,Value>;
  if(JSON.stringify(state).length>STATE_LIMIT)throw new WispError('COMPONENT001','This paged list is too large to save (16 KiB); show fewer items or shorter lines');
  const id=randomBytes(16).toString('hex');
  await storage.putComponent({id:`ss:${id}`,kind:'pages',name:'pages',guildId,ownerId,expiresAt:0,state});
  return view(id,list,1);
}

/** The page a `pg:` button opens, checked against the list's guild and owner. */
export async function turnPage(storage:StorageBackend,customId:string,guildId:string|null,userId:string):Promise<PageView>{
  const match=PAGE_ID.exec(customId);if(!match)throw new WispError('COMPONENT002','This control does not belong to Wisp');
  const item=await storage.getComponent(`ss:${match[1]}`);
  if(!item||item.kind!=='pages')throw new WispError('COMPONENT002','This list has expired');
  if(item.guildId!==(guildId??''))throw new WispError('COMPONENT002','Component scope mismatch');
  if(item.ownerId&&item.ownerId!==userId)throw new WispError('COMPONENT002','This list belongs to someone else; run the command yourself');
  const pages=item.state.pages as string[],list:PagedReply={pages,...(item.state.title!==null?{title:item.state.title as string}:{}),...(item.state.color!==null?{color:item.state.color}:{})};
  return view(match[1]!,list,Math.min(Math.max(1,Number(match[2])),pages.length));
}
