import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {TextDecoder} from 'node:util';
import assert from 'node:assert/strict';
import type {Client} from 'discord.js';
import {parse} from '../compiler/parser.js';
import {WispError} from '../diagnostics.js';
import {discordApi} from '../discord/api.js';
import type {CompiledProject} from '../project/discovery.js';
import type {ProjectConfig} from '../project/manifest.js';
import {compileModules,moduleResolver} from '../project/modules.js';
import {execute,host,record,type Value} from '../runtime/interpreter.js';
import {jsonApi,mathApi,storageApi,timeApi} from '../runtime/stdlib.js';
import {Storage} from '../storage/sqlite.js';
import {ExecutionTrace,writeTrace} from '../runtime/trace.js';
import {ComponentRegistry} from '../discord/components.js';
import {uiApi} from '../discord/ui.js';

function json(value:unknown):unknown{return JSON.parse(JSON.stringify(value)) as unknown;}
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
      const fake={rest:{request:async(input:{method:string;fullRoute:string;body?:unknown;query?:URLSearchParams;reason?:string})=>{
        calls.push({method:input.method,path:input.fullRoute,body:input.body===undefined?null:json(input.body) as Value,query:input.query?Object.fromEntries(input.query):null,reason:input.reason??null});
        const key=`${input.method} ${input.fullRoute}`,queue=replies.get(key);
        if(!queue?.length)throw new WispError('CLI002',`Unmocked Discord request: ${key}`);
        const response=queue.shift()!;
        if(response&&typeof response==='object'&&!Array.isArray(response)&&'__mockError' in response){
          const data=response as {status:number;code:number};
          throw Object.assign(new Error('Fake Discord request failed'),{status:data.status,code:data.code});
        }
        return response;
      }}} as unknown as Client;
      const mock=record({
        respond:host((method,path,response)=>{const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(path,'Path')}`;const queue=replies.get(key)??[];queue.push(response);replies.set(key,queue);return null;}),
        fail:host((method,path,status,code)=>{if(typeof status!=='number'||typeof code!=='number')throw new WispError('CLI002','Fake error status and code must be numbers');const key=`${requiredString(method,'Method').toUpperCase()} ${requiredString(path,'Path')}`;const queue=replies.get(key)??[];queue.push({__mockError:true,status,code});replies.set(key,queue);return null;}),
        calls:host(()=>calls.map(call=>record(call) as Value)),
        clear:host(()=>{calls.length=0;replies.clear();return null;}),
        run:host(async(name,options={})=>{
          const command=compiled.commands.find(item=>item.name===requiredString(name,'Command name'));
          if(!command)throw new WispError('CLI002',`Unknown command /${String(name)}`);
          if(!options||typeof options!=='object'||Array.isArray(options))throw new WispError('CLI002','Command options must be a map');
          const optionValues=record(options as Record<string,Value>) as Value;
          const responses:Value[]=[];
          const values={...common(command.name),options:optionValues,
            guild:record({id:project.manifest.discord.commands.guild_id??'42',name:'Test guild',memberCount:0}) as Value,
            interaction:record({user:record({id:'1',name:'Test user',username:'test',bot:false}) as Value,guildId:project.manifest.discord.commands.guild_id??'42',channelId:'42',commandName:command.name,options:optionValues,createdAt:new Date().toISOString(),defer:host(()=>null),followUp:host((content,ephemeral=false)=>{responses.push(record({content,ephemeral}) as Value);return null;})}) as Value};
          await execute(command.execute,{values,file:command.file,reply:async body=>{responses.push(record(body) as Value);},resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:command.timeoutMs??15000,maxSteps:10000,maxLoops:10000,trace});
          return responses;
        }),
        runEvent:host(async(name,data={})=>{
          const events=compiled.events.filter(item=>item.name===requiredString(name,'Event name'));
          if(!events.length)throw new WispError('CLI002',`Unknown event ${String(name)}`);
          if(!data||typeof data!=='object'||Array.isArray(data))throw new WispError('CLI002','Event data must be a map');
          const values={...common(`event:${name}`),event:record(data as Record<string,Value>) as Value};
          for(const event of events)await execute(event.body,{values,file:event.file,resolveImport:moduleResolver(project.root,compiled.modules??new Map(),{values}),timeoutMs:10000,maxSteps:10000,maxLoops:10000,trace});
          return null;
        })
      }) as Value;
      const assertions=record({
        equal:host((actual,expected)=>{assert.deepEqual(json(actual),json(expected));return null;}),
        ok:host(value=>{assert.equal(value,true,'Expected true');return null;}),
        called:host((method,path,count=1)=>{const found=calls.filter(call=>call.method===requiredString(method,'Method').toUpperCase()&&call.path===requiredString(path,'Path')).length;assert.equal(found,count);return null;})
      }) as Value;
      const common=(scope:string)=>({discord:discordApi(fake,project.root),storage:storageApi(db,scope),time:timeApi(),math:mathApi(),json:jsonApi(),mock,assert:assertions,ui:uiApi(new ComponentRegistry(db,project.manifest.discord.commands.guild_id??'42','1')),log:record({info:host(()=>null),warn:host(()=>null),error:host(()=>null),debug:host(()=>null)}) as Value});
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
