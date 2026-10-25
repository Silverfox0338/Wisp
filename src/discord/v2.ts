import {WispError} from '../diagnostics.js';
import type {Value} from '../runtime/interpreter.js';

export const V2_FLAG=32768;
type Data=Record<string,Value>;
function fail(message:string):never{throw new WispError('DISCORD005',message);}
function object(value:Value|undefined,label:string):Data{if(!value||typeof value!=='object'||Array.isArray(value)||'call' in value)fail(`${label} must be a map`);return value as Data;}
function only(data:Data,allowed:string[],label:string):void{for(const key of Object.keys(data))if(!allowed.includes(key))fail(`Unknown ${label} field ${key}`);}
function string(value:Value|undefined,label:string,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label} must be a nonempty string of at most ${max} characters`);return value;}
function media(value:Value|undefined,label:string,attachmentOnly=false):string{const raw=string(value,label,2048);if(raw.startsWith('attachment://')&&raw.length>13&&!/[\\?#]/.test(raw.slice(13)))return raw;if(attachmentOnly)fail(`${label} must be an attachment:// filename`);try{const url=new URL(raw);if(url.protocol==='https:'||url.protocol==='http:')return raw;}catch{}return fail(`${label} must be an HTTP(S) URL or attachment:// filename`);}
function color(value:Value|undefined):number{if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=0xffffff)return value;if(typeof value==='string'&&/^#[0-9a-fA-F]{6}$/.test(value))return Number.parseInt(value.slice(1),16);return fail('V2 color must be #RRGGBB or an RGB integer');}
function boolean(value:Value|undefined,label:string):boolean{if(typeof value!=='boolean')fail(`${label} must be a boolean`);return value;}
function list(value:Value|undefined,label:string,min:number,max:number):Value[]{if(!Array.isArray(value)||value.length<min||value.length>max)fail(`${label} must have ${min} to ${max} items`);return value;}
export function textDisplay(content:Value):Data{return {type:10,content:string(content,'V2 text',4000)};}
export function thumbnail(url:Value,description?:Value):Data{return {type:11,media:{url:media(url,'Thumbnail URL')},...(description===undefined?{}:{description:string(description,'Thumbnail description',1024)})};}
export function section(lines:Value,accessory:Value):Data{const children=(Array.isArray(lines)?list(lines,'Section text',1,3):[lines]).map(textDisplay);const item=object(accessory,'Section accessory');if(item.type!==11&&item.type!==2)fail('Section accessory must be a thumbnail or button');return {type:9,components:children,accessory:item};}
export function gallery(items:Value):Data{const entries=list(items,'Gallery',1,10).map(item=>{if(typeof item==='string')return {media:{url:media(item,'Gallery URL')}};const data=object(item,'Gallery item');only(data,['url','description','spoiler'],'gallery item');const result:Data={media:{url:media(data.url,'Gallery URL')}};if(data.description!==undefined)result.description=string(data.description,'Gallery description',1024);if(data.spoiler!==undefined)result.spoiler=boolean(data.spoiler,'Gallery spoiler');return result;});return {type:12,items:entries};}
export function fileDisplay(path:Value,spoiler:Value=false):Data{return {type:13,file:{url:media(path,'File URL',true)},spoiler:boolean(spoiler,'File spoiler')};}
export function separator(spacing:Value='small',divider:Value=true):Data{if(spacing!=='small'&&spacing!=='large')fail('Separator spacing must be small or large');return {type:14,spacing:spacing==='large'?2:1,divider:boolean(divider,'Separator divider')};}
export function container(items:Value,settings:Value={}):Data{const data=object(settings,'Container settings');only(data,['color','spoiler'],'container');const components=list(items,'Container components',1,40).map(item=>object(item,'Container child'));for(const child of components)if(![1,9,10,12,13,14].includes(child.type as number))fail('Unsupported container child component');return {type:17,components,...(data.color===undefined?{}:{accent_color:color(data.color)}),...(data.spoiler===undefined?{}:{spoiler:boolean(data.spoiler,'Container spoiler')})};}
function count(items:Data[],depth=0):number{if(depth>4)fail('V2 component nesting is too deep');let total=0;for(const item of items){total++;if(item.type===17||item.type===9||item.type===1){const children=list(item.components, 'Nested components',1,40).map(child=>object(child,'Nested component'));total+=count(children,depth+1);if(item.type===9){object(item.accessory,'Section accessory');total++;}}}return total;}
export function v2Payload(items:Value|undefined):Data{const components=list(items,'V2 components',1,40).map(item=>object(item,'V2 component'));for(const item of components)if(![1,9,10,12,13,14,17].includes(item.type as number))fail('Unsupported top-level V2 component');if(count(components)>40)fail('V2 message exceeds 40 total components');return {flags:V2_FLAG,components};}
export function embed2(title:Value,description:Value,settings:Value={}):Data{
  const data=object(settings,'Embed 2.0 settings');only(data,['color','thumbnail','image','fields','footer','rows','spoiler'],'embed 2.0');
  const children:Data[]=[];const heading=string(title,'Embed 2.0 title',256),body=string(description,'Embed 2.0 description',4000);
  if(data.thumbnail!==undefined)children.push(section([`## ${heading}`,body],thumbnail(data.thumbnail)));else children.push(textDisplay(`## ${heading}`),textDisplay(body));
  if(data.fields!==undefined)for(const value of list(data.fields,'Embed 2.0 fields',0,25)){const field=object(value,'Embed 2.0 field');only(field,['name','value','inline'],'embed 2.0 field');children.push(textDisplay(`**${string(field.name,'Field name',256)}**\n${string(field.value,'Field value',1024)}`));}
  if(data.image!==undefined)children.push(gallery([data.image]));
  if(data.footer!==undefined)children.push(textDisplay(`-# ${string(data.footer,'Embed 2.0 footer',2048)}`));
  if(data.rows!==undefined)for(const row of list(data.rows,'Embed 2.0 rows',1,5)){const item=object(row,'Action row');if(item.type!==1)fail('Embed 2.0 rows must be action rows from ui.rows');children.push(item);}
  return v2Payload([container(children,{...(data.color===undefined?{}:{color:data.color}),...(data.spoiler===undefined?{}:{spoiler:data.spoiler})})]);
}
export function validateV2Message(value:Value):Data{const data=object(value,'V2 message');only(data,['flags','components'],'V2 message');if(data.flags!==V2_FLAG)fail('V2 message must use the IS_COMPONENTS_V2 flag');return v2Payload(data.components);}
