import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {WispError} from '../diagnostics.js';

export interface TraceNode {name:string;file:string|null;line:number|null;durationMs:number;result?:string;error?:string;children:TraceNode[]}

function preview(value:unknown):string {
  const seen=new WeakSet<object>();
  const simplify=(item:unknown,depth:number):unknown=>{
    if(item===null||item===undefined)return null;
    if(typeof item==='string')return item.length>120?item.slice(0,120)+'…':item;
    if(typeof item==='number'||typeof item==='boolean')return item;
    if(typeof item!=='object')return '[function]';
    if(seen.has(item))return '[cycle]';seen.add(item);
    if(depth>=2)return Array.isArray(item)?`list (${item.length} items)`:'map';
    if(Array.isArray(item))return [...item.slice(0,5).map(value=>simplify(value,depth+1)),...(item.length>5?[`… ${item.length-5} more`]:[])];
    return Object.fromEntries(Object.entries(item).slice(0,8).map(([key,value])=>[key,/(?:token|secret|password|authorization|credential)/i.test(key)?'[redacted]':simplify(value,depth+1)]));
  };
  const output=JSON.stringify(simplify(value,0));return output.length>300?output.slice(0,300)+'…':output;
}

export class ExecutionTrace {
  readonly roots:TraceNode[]=[];
  private readonly stack:{node:TraceNode;start:number}[]=[];
  private count=0;
  constructor(readonly label:string,private readonly limit=2000){}
  begin(name:string,file?:string,line?:number):TraceNode|undefined {
    if(this.count++>=this.limit)return undefined;
    const node:TraceNode={name,file:file??null,line:line??null,durationMs:0,children:[]};
    const parent=this.stack.at(-1)?.node;
    (parent?.children??this.roots).push(node);
    this.stack.push({node,start:performance.now()});
    return node;
  }
  end(node:TraceNode|undefined,result?:unknown,error?:unknown):void {
    if(!node)return;
    let index=-1;for(let i=this.stack.length-1;i>=0;i--)if(this.stack[i]!.node===node){index=i;break;}
    if(index<0)return;
    const [frame]=this.stack.splice(index,1);
    node.durationMs=Math.round((performance.now()-frame!.start)*100)/100;
    if(result!==undefined)node.result=preview(result);
    if(error)node.error=error instanceof WispError?`${error.code}: ${error.message}`:error instanceof Error?error.message:String(error);
  }
  toJSON():string{return JSON.stringify({label:this.label,roots:this.roots},null,2);}
}

function escape(value:string):string{return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
function rows(nodes:TraceNode[]):string{return nodes.map(node=>`<details open><summary class="${node.error?'failed':''}"><span>${escape(node.name)}</span><span>${node.durationMs.toFixed(2)} ms</span></summary><div class="meta">${node.file?`${escape(node.file)}:${node.line??1}`:''}${node.result?` → ${escape(node.result)}`:''}${node.error?`<strong> ${escape(node.error)}</strong>`:''}</div>${rows(node.children)}</details>`).join('');}
export function writeTrace(root:string,trace:ExecutionTrace):{html:string;json:string}{
  const dir=join(root,'.wisp','traces');mkdirSync(dir,{recursive:true});
  const name=`${new Date().toISOString().replaceAll(':','-')}-${Math.random().toString(36).slice(2,8)}`;
  const html=join(dir,`${name}.html`),json=join(dir,`${name}.json`);
  writeFileSync(json,trace.toJSON());
  writeFileSync(html,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wisp trace: ${escape(trace.label)}</title><style>body{font:15px system-ui;background:#141521;color:#e9e9f2;max-width:1100px;margin:2rem auto;padding:0 1rem}h1{font-size:1.5rem}details{margin:.4rem 0 .4rem 1rem;border-left:2px solid #555b83;padding-left:.8rem}summary{display:flex;justify-content:space-between;gap:1rem;cursor:pointer;padding:.35rem}.failed{color:#ff8f9e}.meta{color:#aeb4cb;font:13px ui-monospace,monospace;padding:.15rem .4rem;white-space:pre-wrap}strong{color:#ff8f9e}</style><h1>${escape(trace.label)}</h1><p>Click a step to expand its children. Durations include child operations.</p>${rows(trace.roots)}</html>`);
  return {html,json};
}
