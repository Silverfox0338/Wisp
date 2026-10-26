import {WispError} from '../diagnostics.js';
import type {Value} from '../runtime/interpreter.js';
export interface SuggestChoice {name:string;value:string|number}
export const suggestTimeoutMs=2500;
const limit=25;
function choice(item:Value,type:string):SuggestChoice|null{
  let name:Value,value:Value;
  if(item&&typeof item==='object'&&!Array.isArray(item)){const map=item as Record<string,Value>;value=map.value??map.name??null;name=map.name??value;}else{name=item;value=item;}
  if(name===null||value===null||typeof name==='object'||typeof value==='object')return null;
  if(type==='string')value=String(value).slice(0,100);
  else{value=Number(value);if(!Number.isFinite(value)||type==='integer'&&!Number.isSafeInteger(value))return null;}
  const label=String(name).slice(0,100);
  return label.length?{name:label,value}:null;
}
export function suggestionChoices(result:Value,type:string):SuggestChoice[]{
  if(result===null)return [];
  if(!Array.isArray(result))throw new WispError('RUNTIME002','suggest: must return a list, such as ["red", "blue"] or [{"name": "Red", "value": "red"}]');
  const out:SuggestChoice[]=[];
  for(const item of result){const c=choice(item,type);if(c)out.push(c);if(out.length===limit)break;}
  return out;
}
