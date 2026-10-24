import {WispError} from '../diagnostics.js';
import {host,record,type RuntimeComponent,type Value} from '../runtime/interpreter.js';
import type {ComponentRegistry} from './components.js';

function map(value:Value,label:string):Record<string,Value>{if(!value||typeof value!=='object'||Array.isArray(value)||'call' in value)throw new WispError('COMPONENT001',`${label} must be a map`);return value as Record<string,Value>;}
function name(value:Value):string{if(typeof value!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value))throw new WispError('COMPONENT001','Component name must use letters, digits, _ or -');return value;}
function component(value:Value):RuntimeComponent{const item=map(value,'Component');if(typeof item.kind!=='string'||typeof item.name!=='string'||!item.fields)throw new WispError('COMPONENT001','Invalid UI component');return item as unknown as RuntimeComponent;}
export function uiApi(registry:ComponentRegistry,showModal?:(modal:RuntimeComponent)=>Promise<void>):Value{
  return record({
    button:host((key,label,settings={})=>({kind:'button',name:name(key),fields:{...map(settings,'Button settings'),label}})),
    select:host((key,choices,settings={})=>{
      if(!Array.isArray(choices))throw new WispError('COMPONENT001','Select choices must be a list');
      return {kind:'select',name:name(key),fields:map(settings,'Select settings'),choices:choices.map(choice=>{const item=map(choice,'Select choice');if(typeof item.value!=='string')throw new WispError('COMPONENT001','Select choice needs a string value');return {value:item.value,fields:{label:item.label,description:item.description}};})};
    }),
    modal:host((key,title,inputs,settings={})=>{
      if(!Array.isArray(inputs))throw new WispError('COMPONENT001','Modal inputs must be a list');
      return {kind:'modal',name:name(key),fields:{...map(settings,'Modal settings'),title},inputs:inputs.map(input=>{const item=map(input,'Modal input');return {name:name(item.name as Value),fields:Object.fromEntries(Object.entries(item).filter(([field])=>field!=='name'))};})};
    }),
    embed:host((title,description,settings={})=>{if(typeof title!=='string'||typeof description!=='string')throw new WispError('COMPONENT001','Embed title and description must be strings');return {title,description,...map(settings,'Embed settings')};}),
    rows:host((items)=>{if(!Array.isArray(items))throw new WispError('COMPONENT001','UI rows require a list of components');return registry.buildRows(items.map(component)).map(row=>row.toJSON()) as unknown as Value;}),
    showModal:host(async(item)=>{if(!showModal)throw new WispError('COMPONENT001','Modal cannot be shown here');await showModal(component(item));return null;})
  }) as Value;
}
