import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {TextDecoder} from 'node:util';
import assert from 'node:assert/strict';
import type {Client} from 'discord.js';
import {parse} from '../compiler/parser.js';
import {WispError} from '../diagnostics.js';
import {discordApi} from '../discord/api.js';
import {commandRoute,findCommand,type CommandRoute,type CompiledProject,type CommandType} from '../project/discovery.js';
import type {CommandDecl} from '../compiler/ast.js';
import {suggestionChoices,suggestTimeoutMs} from '../discord/suggest.js';
import {checkCooldown} from '../discord/cooldowns.js';
import type {Stmt} from '../compiler/ast.js';
import type {ProjectConfig} from '../project/manifest.js';
import {compileModules,moduleResolver} from '../project/modules.js';
import {execute,host,record,type Value} from '../runtime/interpreter.js';
import {dataApi,guildDataApi,memberDataScope} from '../runtime/stdlib.js';
import {standardGlobals} from '../runtime/globals.js';
import {HttpClient,type HttpTransport} from '../runtime/http.js';
import {Storage} from '../storage/sqlite.js';
import {ExecutionTrace,writeTrace} from '../runtime/trace.js';
import {ComponentRegistry} from '../discord/components.js';
import {uiApi} from '../discord/ui.js';

function json(value:unknown):unknown{return JSON.parse(JSON.stringify(value)) as unknown;}
/** Exact keys with queued replies win; otherwise the longest trailing-* pattern with queued replies matches. */
function mockKey(replies:Map<string,unknown[]>,key:string):string|undefined{if(replies.get(key)?.length)return key;return [...replies.keys()].filter(pattern=>pattern.endsWith('*')&&key.startsWith(pattern.slice(0,-1))&&replies.get(pattern)!.length).sort((a,b)=>b.length-a.length)[0];}
function requiredString(value:Value,label:string):string{
  if(typeof value!=='string'||!value)throw new WispError('CLI002',`${label} must be a nonempty string`);
  return value;
}

/** Run .test.wisp files without a Discord connection or the project's database. */
export async function runWispTests(project:ProjectConfig,compiled:CompiledProject,traceEnabled=false):Promise<number>{
  const directory=join(project.root,'tests');
  if(!existsSync(directory))return 0;
  const files=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.test.wisp')).map(entry=>join(directory,entry.name)).sort();
  let failures=0;
  for(const file of files){
    const trace=traceEnabled?new ExecutionTrace(relative(project.root,file)):undefined;
    const temp=mkdtempSync(join(tmpdir(),'wisp-test-'));
    const db=new Storage(join(temp,'test.db'));
    try{
      const source=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));
      if(source.length>1024*1024)throw new WispError('CLI002','Test file exceeds 1 MiB',file);
      const script=parse(source,file);
      if(script.commands.length||script.events.length)throw new WispError('CLI002','Test files contain statements, not command or event declarations',file);
      const modules=compileModules(project.root,[{file,statements:script.statements}]);
      const replies=new Map<string,Value[]>(),calls:Record<string,Value>[]=[];
      const databaseReplies=new Map<string,Value[]>(),databaseCalls:Record<string,Value>[]=[];
      const httpReplies=new Map<string,Value[]>(),httpCalls:Record<string,Value>[]=[];
      const httpTransport:HttpTransport=async request=>{
        const target=`${request.method} ${request.url.origin}${request.url.pathname}`;
        httpCalls.push({method:request.method,url:request.url.href,headers:record(Object.fromEntries(Object.entries(request.headers).map(([name,value])=>[name,/auth|key|token|secret|password|cookie/i.test(name)?'[redacted]':value]))) as Value,body:request.body??null});
        const key=mockKey(httpReplies,target),queue=key===undefined?undefined:httpReplies.get(key);
        if(!queue?.length)throw new WispError('CLI002',`Unmocked HTTP request: ${target}`);
        const response=queue.shift() as Record<string,Value>;
        if('__mockError' in response)throw new Error(String(response.message));
        const headers=Object.fromEntries(Object.entries((response.headers??{}) as Record<string,Value>).map(([name,value])=>[name.toLowerCase(),String(value)]));
        if(response.json!==undefined)headers['content-type']??='application/json';
        return {status:typeof response.status==='number'?response.status:200,headers,body:response.json!==undefined?JSON.stringify(response.json):typeof response.text==='string'?response.text:''};
      };
      const httpClient=new HttpClient(project.manifest.http,httpTransport);
      const databaseCall=(connection:string,operation:string,...args:Value[]):Value=>{databaseCalls.push({connection,operation,args});const key=`${connection}.${operation}`,queue=databaseReplies.get(key);if(!queue?.length)throw new WispError('CLI002',`Unmocked database call: ${key}`);return queue.shift()!;};
      const databaseApi=record(Object.fromEntries(Object.entries(project.manifest.databases??{}).map(([name,config])=>[name,config.engine==='redis'?record(Object.fromEntries(['get','set','has','delete','increment'].map(operation=>[operation,host((...params)=>databaseCall(name,operation,...params))]))):record({sql:host((...params)=>databaseCall(name,'sql',...params))})]))) as Value;
      const fake={rest:{request:async(input:{method:string;fullRoute:string;body?:unknown;query?:URLSearchParams;reason?:string})=>{
        calls.push({method:input.method,path:input.fullRoute,body:input.body===undefined?null:json(input.body) as Value,query:input.query?Object.fromEntries(input.query):null,reason:input.reason??null});
        const target=`${input.method} ${input.fullRoute}`,key=mockKey(replies,target),queue=key===undefined?undefined:replies.get(key);
        if(!queue?.length)throw new WispError('CLI002',`Unmocked Discord request: ${target}`);
        const response=queue.shift()!;
        if(response&&typeof response==='object'&&!Array.isArray(response)&&'__mockError' in response){
          const data=response as {status:number;code:number};
          throw Object.assign(new Error('Fake Discord request failed'),{status:data.status,code:data.code});
        }
        return response;
      }}} as unknown as Client;
      let clockOffset=0,actingUser='1';
      const pendingTasks=new Map<string,{body:Stmt[];file:string;seconds:number;repeat:boolean;data:Record<string,Value>|null}>();
      const testSchedule=(file:string)=>(name:string,seconds:number,repeat:boolean,body:Stmt[],meta?:{template:string;data:Record<string,Value>|null})=>{if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(name))throw new WispError('SCHEDULE001',`Task name ${JSON.stringify(name)} must start with a letter and use letters, digits, _ or - (at most 100)`);if(!Number.isFinite(seconds)||seconds<1||seconds>604800)throw new WispError('SCHEDULE001','Delay must be 1 to 604800 seconds');pendingTasks.set(name,{body,file,seconds,repeat,data:meta?.data??null});};
      const resolveRoute=(name:Value):{command:CommandDecl;route:CommandRoute}=>{
        const [base='',...rest]=requiredString(name,'Command name').trim().split(/\s+/);
        const command=findCommand(compiled.commands,'slash',base);
        if(!command)throw new WispError('CLI002',`Unknown command /${base}`);
        const route=rest.length>2?undefined:commandRoute(command,rest.length===2?rest[0]!:null,rest.length?rest[rest.length-1]!:null);
        if(!route){const paths=command.subcommands?.map(sub=>`"${[command.name,sub.group,sub.name].filter(Boolean).join(' ')}"`).join(', ');throw new WispError('CLI002',`Unknown command /${[base,...rest].join(' ')}`,undefined,undefined,undefined,paths?`Try one of: ${paths}`:`/${base} has no subcommands`);}
        return {command,route};
      };
      const contextCommand=(type:CommandType,name:Value):[CommandDecl,CommandRoute]=>{const command=findCommand(compiled.commands,type,requiredString(name,'Command name'));if(!command)throw new WispError('CLI002',`Unknown ${type} command "${String(name)}"`);return [command,commandRoute(command)!];};
      const runCommand=async(command:CommandDecl,route:CommandRoute,options:Record<string,Value>,target:Value):Promise<Value[]>=>{
        if(target!==null&&(typeof target!=='object'||Array.isArray(target)))throw new WispError('CLI002','Context menu target must be a map');
        const guildId=project.manifest.discord.commands.guild_id??'42',type=command.type??'slash',label=type==='slash'?`/${route.path}`:`${type} command "${command.name}"`;
        const withData=(value:Value):Value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,Value>).id==='string'?record({...(value as Record<string,Value>),data:dataApi(db,memberDataScope(guildId,(value as Record<string,Value>).id as string))}) as Value:value;
        const optionValues=record(Object.fromEntries(Object.entries(options).map(([k,v])=>[k,route.options.find(o=>o.name===k)?.type==='user'?withData(v):v]))) as Value,targetValue=target===null?null:record(target as Record<string,Value>) as Value;
        const responses:Value[]=[];
        const blocked=await checkCooldown(db,route.cooldown,`${type}:${route.path}`,label,{user:actingUser,guild:guildId,channel:'42'},Date.now()+clockOffset*1000);
        if(blocked){responses.push(record({content:blocked,ephemeral:true}) as Value);return responses;}
        const values={...common(command.name),options:optionValues,target:targetValue,
          user:record({id:actingUser,name:'Test user',username:'test',bot:false,mention:`<@${actingUser}>`,data:dataApi(db,memberDataScope(guildId,actingUser))}) as Value,
          guild:record({id:guildId,name:'Test guild',memberCount:0,...guildDataApi(db,guildId)}) as Value,
          interaction:record({user:record({id:actingUser,name:'Test user',username:'test',bot:false}) as Value,guildId,channelId:'42',commandName:command.name,subcommand:route.subcommand,group:route.group,target:targetValue,options:optionValues,createdAt:new Date().toISOString(),defer:host(()=>null),followUp:host((content,ephemeral=false)=>{responses.push(record({content,ephemeral}) as Value);return null;})}) as Value};
        await execute(route.execute,{values,file:command.file,schedule:testSchedule(command.file),reply:async body=>{responses.push(record(body) as Value);},resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:command.timeoutMs??15000,maxSteps:10000,maxLoops:10000,trace});
        return responses;
      };
      const mock=record({
        respond:host((method,path,response)=>{const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(path,'Path')}`;const queue=replies.get(key)??[];queue.push(response);replies.set(key,queue);return null;}),
        fail:host((method,path,status,code)=>{if(typeof status!=='number'||typeof code!=='number')throw new WispError('CLI002','Fake error status and code must be numbers');const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(path,'Path')}`;const queue=replies.get(key)??[];queue.push({__mockError:true,status,code});replies.set(key,queue);return null;}),
        calls:host(()=>calls.map(call=>record(call) as Value)),
        clear:host(()=>{calls.length=0;replies.clear();httpCalls.length=0;httpReplies.clear();return null;}),
        httpRespond:host((method,url,response={})=>{if(!response||typeof response!=='object'||Array.isArray(response))throw new WispError('CLI002','HTTP mock response must be a map such as {"status": 200, "json": {...}}');const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(url,'URL')}`,queue=httpReplies.get(key)??[];queue.push(response);httpReplies.set(key,queue);return null;}),
        httpFail:host((method,url,message='Mock network failure')=>{const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(url,'URL')}`,queue=httpReplies.get(key)??[];queue.push({__mockError:true,message:String(message)});httpReplies.set(key,queue);return null;}),
        httpCalls:host(()=>httpCalls.map(call=>record(call) as Value)),
        dbRespond:host((connection,operation,result)=>{const key=`${requiredString(connection,'Connection')}.${requiredString(operation,'Operation')}`,queue=databaseReplies.get(key)??[];queue.push(result);databaseReplies.set(key,queue);return null;}),
        dbCalls:host(()=>databaseCalls.map(call=>record(call) as Value)),
        run:host(async(name,options={})=>{
          const {command,route}=resolveRoute(name);
          if(!options||typeof options!=='object'||Array.isArray(options))throw new WispError('CLI002','Command options must be a map');
          return runCommand(command,route,options as Record<string,Value>,null);
        }),
        advance:host(seconds=>{if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)throw new WispError('CLI002','mock.advance needs a number of seconds');clockOffset+=seconds;return null;}),
        as:host(id=>{actingUser=requiredString(id,'User ID');return null;}),
        tasks:host(()=>[...pendingTasks].map(([name,task])=>record({name,seconds:task.seconds,repeat:task.repeat,data:task.data===null?null:record(task.data)}) as Value)),
        runTask:host(async name=>{const key=requiredString(name,'Task name'),task=pendingTasks.get(key);if(!task)throw new WispError('CLI002',`No pending task ${key}`,undefined,undefined,undefined,pendingTasks.size?`Pending: ${[...pendingTasks.keys()].join(', ')}`:'Nothing has been scheduled yet');if(!task.repeat)pendingTasks.delete(key);const values={...common(`task:${key}`),task:record({name:key,data:task.data===null?null:record(task.data)}) as Value};await execute(task.body,{values,file:task.file,resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:10000,maxSteps:10000,maxLoops:10000,trace});return null;}),
        runUser:host(async(name,target={})=>runCommand(...contextCommand('user',name),{},target)),
        runMessage:host(async(name,target={})=>runCommand(...contextCommand('message',name),{},target)),
        suggest:host(async(name,optionName,typed='',options={})=>{
          const {command,route}=resolveRoute(name);
          const option=route.options.find(o=>o.name===requiredString(optionName,'Option name'));
          if(!option?.suggest)throw new WispError('CLI002',`/${route.path} has no suggest: block on option ${String(optionName)}`);
          if(!options||typeof options!=='object'||Array.isArray(options))throw new WispError('CLI002','Command options must be a map');
          const values={...common(`suggest:${route.path}`),typed:String(typed),options:record(options as Record<string,Value>) as Value,
            interaction:record({user:record({id:'1',name:'Test user',username:'test',bot:false}) as Value,guildId:project.manifest.discord.commands.guild_id??'42',channelId:'42',commandName:command.name,subcommand:route.subcommand,group:route.group,focused:option.name}) as Value};
          let result:Value=null;
          await execute(option.suggest,{values,file:command.file,onReturn:value=>{result=value;},resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:suggestTimeoutMs,maxSteps:10000,maxLoops:10000,trace});
          return suggestionChoices(result,option.type).map(c=>record({...c}) as Value);
        }),
        runEvent:host(async(name,data={})=>{
          const events=compiled.events.filter(item=>item.name===requiredString(name,'Event name'));
          if(!events.length)throw new WispError('CLI002',`Unknown event ${String(name)}`);
          if(!data||typeof data!=='object'||Array.isArray(data))throw new WispError('CLI002','Event data must be a map');
          const values={...common(`event:${name}`),event:record(data as Record<string,Value>) as Value};
          for(const event of events)await execute(event.body,{values,file:event.file,schedule:testSchedule(event.file),resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:10000,maxSteps:10000,maxLoops:10000,trace});
          return null;
        })
      }) as Value;
      const assertions=record({
        equal:host((actual,expected)=>{assert.deepEqual(json(actual),json(expected));return null;}),
        ok:host(value=>{assert.equal(value,true,'Expected true');return null;}),
        called:host((method,path,count=1)=>{const found=calls.filter(call=>call.method===requiredString(method,'Method').toUpperCase()&&call.path===requiredString(path,'Path')).length;assert.equal(found,count);return null;})
      }) as Value;
      const common=(scope:string)=>({...standardGlobals({storage:db,db:databaseApi,discord:discordApi(fake,project.root),log:record({info:host(()=>null),warn:host(()=>null),error:host(()=>null),debug:host(()=>null)}) as Value,http:httpClient},scope),mock,assert:assertions,ui:uiApi(new ComponentRegistry(db,project.manifest.discord.commands.guild_id??'42','1'))});
      const values=common(`test:${relative(project.root,file)}`);
      const resolver=moduleResolver(project.root,new Map([...compiled.modules??[],...modules]),{values});
      await execute(script.statements,{values,file,resolveImport:resolver,timeoutMs:15000,maxSteps:10000,maxLoops:10000,trace});
      console.log(`PASS ${relative(project.root,file)}`);
    }catch(error){
      failures++;
      const detail=error instanceof WispError?error.format():error instanceof Error?error.message:String(error);
      console.error(`FAIL ${relative(project.root,file)}: ${detail}`);
    }finally{
      if(trace)console.log(`Trace: ${writeTrace(project.root,trace).html}`);
      db.close();
      const rel=relative(tmpdir(),temp);
      if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(temp,{recursive:true,force:true});
    }
  }
  if(failures)throw new WispError('CLI002',`${failures} of ${files.length} Wisp tests failed`);
  return files.length;
}
