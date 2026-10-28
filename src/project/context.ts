import type {CommandDecl,EventDecl,Stmt} from '../compiler/ast.js';
import {parse} from '../compiler/parser.js';

/** A built-in a handler uses but won't have when it runs. */
export interface ContextWarning {file:string;line:number;column:number;name:string;message:string}

const contextNames=new Set(['guild','user','interaction','options','target','event','task']);
const memberEvents=new Set(['member_join','member_leave','message_create','message_update','message_delete']);

/** The built-ins each kind of handler gets, matching what the bot and wisp test pass in. */
export function handlerNames(handler:{kind:'command'}|{kind:'suggest'}|{kind:'event';name:string}|{kind:'task'}):Set<string>{
  switch(handler.kind){
    case 'command':return new Set(['guild','user','interaction','options','target']);
    case 'suggest':return new Set(['guild','user','interaction','options']);
    case 'task':return new Set(['task']);
    case 'event':
      if(handler.name.includes(':')&&!handler.name.startsWith('gateway:'))return new Set(['guild','user','interaction']);
      return new Set(memberEvents.has(handler.name)?['event','guild','user']:['event']);
  }
}

const describe=(handler:{kind:string;name?:string})=>handler.kind==='task'?'a timer':handler.kind==='suggest'?'a suggest: block':handler.name?.startsWith('gateway:')?`on gateway "${handler.name.slice(8)}"`:handler.name?.includes(':')?`on ${handler.name.split(':')[0]} "${handler.name.split(':').slice(1).join(':')}"`:`on ${handler.name}:`;
function advice(name:string,where:{kind:string;name?:string},has:Set<string>,outer?:Set<string>):string{
  if(where.kind==='task'&&outer&&!outer.has(name))return `${name} isn't available inside a timer, and the code that starts this timer doesn't have it either. Save the ID you need, for example with storage.sharedSet, and read it in the timer`;
  if(where.kind==='task'){
    const hint=({guild:'{"guild_id": guild.id}',user:'{"user_id": user.id}',interaction:'{"channel": interaction.channelId}',options:'{"amount": options.amount}',target:'{"target_id": target.id}',event:'{"message": event.message}'} as Record<string,string>)[name]??'{...}';
    return `${name} isn't available inside a timer, because the timer runs later on its own. Pass what it needs with with ${hint} and read it from task.data`;
  }
  const left=[...has].filter(item=>contextNames.has(item));
  return `${name} isn't available in ${describe(where)}; it has ${left.length?left.join(' and '):'no handler values'}${name==='guild'&&has.has('event')?'. Use event.data.guild_id or a saved ID instead':''}`;
}

/** Names the handler declares itself, so `let user = ...` is not reported. */
function declared(statements:unknown,names=new Set<string>()):Set<string>{
  if(Array.isArray(statements)){for(const item of statements)declared(item,names);return names;}
  if(!statements||typeof statements!=='object')return names;
  const node=statements as Record<string,unknown>;
  if((node.kind==='let'||node.kind==='assign'||node.kind==='global'||node.kind==='for'||node.kind==='function')&&typeof node.name==='string')names.add(node.name);
  if(node.kind==='function'&&Array.isArray(node.params))for(const param of node.params as {name:string}[])names.add(param.name);
  if(node.kind==='try'&&typeof node.errorName==='string')names.add(node.errorName);
  if(node.kind==='import'&&typeof node.alias==='string')names.add(node.alias);
  for(const [key,value] of Object.entries(node))if(key!=='kind'&&value&&typeof value==='object')declared(value,names);
  return names;
}

/** Walks a handler body and reports context names it won't have. Timer bodies are checked as timers. */
function walk(body:Stmt[],file:string,where:{kind:string;name?:string},has:Set<string>,out:ContextWarning[],outer?:Set<string>):void{
  const own=declared(body);
  const visit=(value:unknown,at?:{line:number;column:number}):void=>{
    if(Array.isArray(value)){for(const item of value)visit(item,at);return;}
    if(!value||typeof value!=='object')return;
    const node=value as Record<string,unknown>;
    if(node.kind==='schedule'){visit(node.seconds,at);visit(node.data,at);walk(node.body as Stmt[],file,{kind:'task'},handlerNames({kind:'task'}),out,where.kind==='task'?outer:has);return;}
    if(node.kind==='name'&&typeof node.name==='string'&&contextNames.has(node.name)&&!has.has(node.name)&&!own.has(node.name)){
      out.push({file,line:at?.line??Number(node.line),column:at?.column??Number(node.column),name:node.name,message:advice(node.name,where,has,outer)});
      return;
    }
    // "Hi {user.name}" keeps its expressions as text until it runs, so parse them here, the same way the interpreter does.
    if(node.kind==='literal'&&typeof node.value==='string'&&node.value.includes('{')){
      for(const match of node.value.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)){
        try{const stmt=parse(`let __interpolation = ${match[1]}\n`).statements[0];if(stmt?.kind==='let')visit(stmt.expr,at??{line:Number(node.line),column:Number(node.column)});}catch{/* wisp check reports bad interpolations elsewhere */}
      }
      return;
    }
    for(const [key,child] of Object.entries(node))if(key!=='kind'&&child&&typeof child==='object')visit(child,at);
  };
  visit(body);
}

export function contextWarnings(commands:CommandDecl[],events:EventDecl[]):ContextWarning[]{
  const out:ContextWarning[]=[];
  for(const command of commands){
    const routes=command.subcommands??[command];
    for(const route of routes){
      walk(route.execute,command.file,{kind:'command'},handlerNames({kind:'command'}),out);
      for(const option of route.options)if(option.suggest)walk(option.suggest,command.file,{kind:'suggest'},handlerNames({kind:'suggest'}),out);
    }
  }
  for(const event of events)walk(event.body,event.file,{kind:'event',name:event.name},handlerNames({kind:'event',name:event.name}),out);
  const seen=new Set<string>();
  return out.filter(item=>{const key=`${item.file}:${item.line}:${item.column}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line||a.column-b.column);
}
