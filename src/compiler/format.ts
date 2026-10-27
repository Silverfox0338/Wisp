import {WispError} from '../diagnostics.js';
import {parse} from './parser.js';

/* Words that read as statements, not calls, so `if (x)` keeps its space while `len(x)` does not. */
const spaced=new Set(['if','elif','while','for','in','return','not','and','or','raise','match','when','reply','let','global','with','else','export','import','as','every','after','per']);
const operators=['==','!=','<=','>=','??','+=','-=','*=','/=','+','-','*','/','%','<','>','='];
type Kind='start'|'word'|'keyword'|'value'|'open'|'close'|'op'|'unary'|'comma'|'colon'|'dot';
const tight:Kind[]=['start','open','dot','unary'];

/** Normalizes spacing inside one line of code; strings and the trailing comment are kept as written. */
function formatLine(code:string):string{
  let out='',prev='start' as Kind,i=0;
  const emit=(text:string,kind:Kind,space:boolean)=>{out+=(space&&out?' ':'')+text;prev=kind;};
  while(i<code.length){
    const c=code[i]!,rest=code.slice(i);
    if(c===' '){i++;continue;}
    if(c==='#'){out+=(out?' ':'')+rest.trimEnd();break;}
    if(c==='"'||c==="'"){let j=i+1;while(j<code.length&&code[j]!==c)j+=code[j]==='\\'?2:1;emit(code.slice(i,j+1),'value',!tight.includes(prev));i=j+1;continue;}
    const number=/^\d+(?:\.\d+)?/.exec(rest);if(number){emit(number[0],'value',!tight.includes(prev));i+=number[0].length;continue;}
    const word=/^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);if(word){emit(word[0],prev!=='dot'&&spaced.has(word[0])?'keyword':'word',!tight.includes(prev));i+=word[0].length;continue;}
    const op=operators.find(candidate=>code.startsWith(candidate,i));
    if(op==='-'&&['start','open','op','unary','comma','colon','keyword'].includes(prev)){emit('-','unary',!tight.includes(prev));i++;continue;}
    if(op){emit(op,'op',true);i+=op.length;continue;}
    if('([{'.includes(c)){emit(c,'open',['keyword','op','comma','colon'].includes(prev));i++;continue;}
    if(')]}'.includes(c)){emit(c,'close',false);i++;continue;}
    if(c===','){emit(',','comma',false);i++;continue;}
    if(c===':'){emit(':','colon',false);i++;continue;}
    if(c==='.'){emit('.','dot',false);i++;continue;}
    return code.trimEnd();
  }
  return out;
}

/** Bracket depth change across one line, ignoring strings and comments. */
function nesting(code:string):number{
  let depth=0,quote='';
  for(let i=0;i<code.length;i++){const c=code[i]!;if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}if(c==='"'||c==="'")quote=c;else if(c==='#')break;else if('([{'.includes(c))depth++;else if(')]}'.includes(c))depth--;}
  return depth;
}

/** Strips positions so two parses can be compared for meaning only. */
function shape(source:string,file:string):string{return JSON.stringify(parse(source,file),(key,value:unknown)=>['line','column','catchLine','file'].includes(key)?undefined:value);}

/**
 * Formats Wisp source: one space around operators and after commas and colons, none inside brackets,
 * at most one blank line in a row, a blank line between top-level blocks, and no trailing whitespace.
 * `markdown:` blocks are left exactly as written. Throws instead of returning a result that parses differently.
 */
export function formatSource(source:string,file='<source>'):string{
  const out:string[]=[];
  let markdown=-1,depth=0,lastIndent=0;
  for(const raw of source.replace(/\r\n?/g,'\n').split('\n')){
    const indent=raw.match(/^ */)![0].length,code=raw.slice(indent).trimEnd();
    if(markdown>=0){if(!code){out.push('');continue;}if(indent>markdown){out.push(raw);continue;}markdown=-1;while(out.at(-1)===''&&out.at(-2)==='')out.pop();}
    if(!code){if(out.length&&out.at(-1)!=='')out.push('');continue;}
    if(depth===0&&indent===0&&lastIndent>0&&out.length&&out.at(-1)!==''&&!/^(?:else|elif|catch)\b/.test(code))out.push('');
    out.push(' '.repeat(indent)+formatLine(code));
    if(depth===0)lastIndent=indent;
    depth=Math.max(0,depth+nesting(code));
    if(/^markdown:$/.test(code))markdown=indent;
  }
  while(out.length&&out.at(-1)==='')out.pop();
  const result=out.join('\n')+'\n';
  if(shape(result,file)!==shape(source,file))throw new WispError('FORMAT001','Formatting would change what this file means, so it was left unchanged',file);
  return result;
}
