import {WispError} from '../diagnostics.js';
import {host,isHost,record,type Value} from './interpreter.js';

const fail=(message:string):never=>{throw new WispError('RUNTIME002',message);};
const num=(value:Value,label:string):number=>typeof value==='number'&&Number.isFinite(value)?value:fail(`${label} must be a finite number`);
const integer=(value:Value,label:string):number=>{const n=num(value,label);return Number.isSafeInteger(n)?n:fail(`${label} must be a safe integer`);};
const str=(value:Value,label:string):string=>typeof value==='string'?value:fail(`${label} must be a string`);
const sized=(value:string):string=>value.length<=65536?value:fail('String exceeds 64 KiB limit');
const listed=(value:Value[]):Value[]=>value.length<=10000?value:fail('List exceeds 10000 items');
const equal=(a:Value,b:Value):boolean=>a===b;
const entry=(key:string,value:Value):Value=>record({key,value}) as Value;
const regex=(pattern:Value,flags:Value=''):RegExp=>{
  const source=str(pattern,'regex pattern'),options=str(flags,'regex flags');
  const quantifiers=source.match(/[+*?]|\{\d+(?:,\d*)?\}/g)?.length??0;
  if(source.length>128||quantifiers>2||!/^[imsu]*$/.test(options)||new Set(options).size!==options.length||/\\[1-9]|\(\?/.test(source)||/\([^)]*\)[+*{?]|[+*?}][+*?{]/.test(source))fail('Unsupported or unsafe regex pattern');
  try{return new RegExp(source,options);}catch{return fail('Invalid regex pattern');}
};
const regexInput=(value:string):string=>value.length<=4096?value:fail('Regex input exceeds 4096 characters');
const padLength=(value:Value):number=>{const length=integer(value,'length');return length>=0&&length<=65536?length:fail('Padding exceeds 64 KiB limit');};
const replaced=(value:string,search:Value,replacement:Value):string=>{const needle=str(search,'search'),newText=str(replacement,'replacement');let count=0,position=0;if(needle==='')count=value.length+1;else while((position=value.indexOf(needle,position))>=0){count++;position+=needle.length;}const length=value.length+count*(newText.length-needle.length);if(length>65536)fail('String exceeds 64 KiB limit');return value.replaceAll(needle,newText);};

export function valueMethod(value:Value,name:string,invoke:(fn:Value,args:Value[])=>Promise<Value>):Value|undefined {
  if(typeof value==='string'){
    const methods:Record<string,Value>={
      split:host((separator)=>listed(value.split(str(separator,'separator')))),
      trim:host(()=>value.trim()),upper:host(()=>value.toUpperCase()),lower:host(()=>value.toLowerCase()),
      replace:host((search,replacement)=>replaced(value,search,replacement)),
      starts_with:host(prefix=>value.startsWith(str(prefix,'prefix'))),ends_with:host(suffix=>value.endsWith(str(suffix,'suffix'))),
      contains:host(part=>value.includes(str(part,'part'))),
      substring:host((start,end=null)=>sized(value.slice(integer(start,'start'),end===null?undefined:integer(end,'end')))),
      pad_start:host((length,fill=' ')=>sized(value.padStart(padLength(length),str(fill,'fill')))),
      pad_end:host((length,fill=' ')=>sized(value.padEnd(padLength(length),str(fill,'fill')))),
      format:host((...args)=>{let total=value.length;return sized(value.replace(/%%|%([1-9]\d*)/g,(match,index:string)=>{if(match==='%%')return '%';const item=args[Number(index)-1];if(item===undefined)fail(`Missing format argument ${index}`);const text=item===null?'null':typeof item==='object'?'[object]':String(item);total+=text.length;if(total>65536)fail('Formatted string exceeds 64 KiB');return text;}));}),
      regex_match:host((pattern,flags='')=>regex(pattern,flags).test(regexInput(value))),
      regex_replace:host((pattern,replacement,flags='')=>{const expression=regex(pattern,flags),text=str(replacement,'replacement');if(text.length>1024)fail('Regex replacement exceeds 1024 characters');return sized(regexInput(value).replace(new RegExp(expression.source,expression.flags.includes('g')?expression.flags:expression.flags+'g'),text));})
    };
    if(name==='length')return value.length;
    return methods[name];
  }
  if(Array.isArray(value)){
    const methods:Record<string,Value>={
      keys:host(()=>listed(value.map((_,index)=>index))),
      values:host(()=>listed([...value])),
      entries:host(()=>listed(value.map((item,index)=>entry(String(index),item)))),
      append:host(item=>{if(value.length>=10000)fail('List limit exceeded');value.push(item);return null;}),
      remove:host(item=>{const index=value.findIndex(x=>equal(x,item));if(index<0)return false;value.splice(index,1);return true;}),
      pop:host((position=null)=>{if(!value.length)return null;const index=position===null?value.length-1:integer(position,'index');if(index<0||index>=value.length)return null;return value.splice(index,1)[0]??null;}),
      insert:host((position,item)=>{if(value.length>=10000)fail('List limit exceeded');value.splice(integer(position,'index'),0,item);return null;}),
      index:host(item=>value.findIndex(x=>equal(x,item))),
      slice:host((start=0,end=null)=>listed(value.slice(integer(start,'start'),end===null?undefined:integer(end,'end')))),
      sort:host(async(comparator=null)=>{if(comparator!==null&&value.length>1000)fail('Custom sort is limited to 1000 items');if(comparator===null){if(value.some(x=>typeof x!=='number'&&typeof x!=='string'))fail('Default sort requires only numbers or only strings');if(value.some(x=>typeof x!==typeof value[0]))fail('Default sort requires values of one type');value.sort((a,b)=>typeof a==='number'&&typeof b==='number'?a-b:String(a).localeCompare(String(b)));}else{for(let i=1;i<value.length;i++){const current=value[i]!;let j=i-1;while(j>=0&&num(await invoke(comparator,[value[j]!,current]),'comparator result')>0){value[j+1]=value[j]!;j--;}value[j+1]=current;}}return null;}),
      reverse:host(()=>{value.reverse();return null;}),
      map:host(async callback=>{const result:Value[]=[];for(const item of value)result.push(await invoke(callback,[item]));return listed(result);}),
      filter:host(async callback=>{const result:Value[]=[];for(const item of value){const keep=await invoke(callback,[item]);if(typeof keep!=='boolean')fail('filter callback must return a boolean');if(keep)result.push(item);}return result;}),
      find:host(async callback=>{for(const item of value){const found=await invoke(callback,[item]);if(typeof found!=='boolean')fail('find callback must return a boolean');if(found)return item;}return null;}),
      contains:host(item=>value.some(x=>equal(x,item))),
      join:host(separator=>{const parts=value.map(x=>String(x)),joiner=str(separator,'separator');if(parts.reduce((total,part)=>total+part.length,0)+Math.max(0,parts.length-1)*joiner.length>65536)fail('Joined string exceeds 64 KiB');return parts.join(joiner);})
    };
    if(name==='length')return value.length;
    return methods[name];
  }
  if(value&&typeof value==='object'&&!isHost(value)){
    const map=value as Record<string,Value>,keys=()=>Object.keys(map);
    const methods:Record<string,Value>={
      keys:host(()=>listed(keys())),values:host(()=>listed(keys().map(key=>map[key]!))),entries:host(()=>listed(keys().map(key=>entry(key,map[key]!)))),
      contains:host(key=>Object.hasOwn(map,str(key,'key'))),
      remove:host(key=>{if(Object.isFrozen(map))fail('This map is read-only');const k=str(key,'key'),found=Object.hasOwn(map,k);delete map[k];return found;}),
      pop:host((key,fallback=null)=>{if(Object.isFrozen(map))fail('This map is read-only');const k=str(key,'key');if(!Object.hasOwn(map,k))return fallback;const result=map[k]!;delete map[k];return result;}),
      map:host(async callback=>{const result:Value[]=[];for(const key of keys())result.push(await invoke(callback,[entry(key,map[key]!) ]));return listed(result);}),
      filter:host(async callback=>{const result:Value[]=[];for(const key of keys()){const item=entry(key,map[key]!);const keep=await invoke(callback,[item]);if(typeof keep!=='boolean')fail('filter callback must return a boolean');if(keep)result.push(item);}return listed(result);}),
      find:host(async callback=>{for(const key of keys()){const item=entry(key,map[key]!);const found=await invoke(callback,[item]);if(typeof found!=='boolean')fail('find callback must return a boolean');if(found)return item;}return null;})
    };
    if(name==='length')return keys().length;
    return methods[name];
  }
  return undefined;
}
