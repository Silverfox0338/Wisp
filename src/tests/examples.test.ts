import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadProject} from '../project/manifest.js';
import {discover} from '../project/discovery.js';
import {moduleResolver} from '../project/modules.js';
import {execute,record,type RuntimeComponent,type Value} from '../runtime/interpreter.js';
import {jsonApi,mathApi,storageApi,timeApi} from '../runtime/stdlib.js';
import {Storage} from '../storage/sqlite.js';
import {ComponentRegistry} from '../discord/components.js';

const examples=resolve(process.cwd(),'examples');
const hasPoll=existsSync(join(examples,'interactive-poll','wisp.json'));
const hasUtility=existsSync(join(examples,'utility','wisp.json'));
test('poll example validates and records a component vote across database restarts',{skip:!hasPoll},async()=>{
  const project=loadProject(join(examples,'interactive-poll')),compiled=discover(project);
  assert.deepEqual(compiled.commands.map(command=>command.name).sort(),['poll','pollresults']);
  const root=mkdtempSync(join(tmpdir(),'wisp-poll-')),path=join(root,'poll.db');
  try{
    let storage=new Storage(path);const components=new ComponentRegistry(storage,'guild','user');let declared:RuntimeComponent[]=[];
    const poll=compiled.commands.find(command=>command.name==='poll')!;
    await execute(poll.execute,{file:poll.file,values:{},reply:async body=>{declared=body.components??[];}});
    const rows=components.buildRows(declared);const button=rows[0]!.components[0]!.toJSON();assert.ok('custom_id' in button);
    storage.close();storage=new Storage(path);
    const state=new ComponentRegistry(storage,'guild','user').resolve(button.custom_id,'button','guild','other-user');
    assert.equal(state.state.poll,'demo');
    const handler=compiled.events.find(event=>event.name==='button:vote_a')!,replies:string[]=[];
    await execute(handler.body,{file:handler.file,values:{storage:storageApi(storage,'component:vote_a'),interaction:record({state:record(state.state)}) as Value},reply:async body=>{replies.push(body.content!);}});
    assert.match(replies[0]!,/1 votes/);
    const results=compiled.commands.find(command=>command.name==='pollresults')!;
    await execute(results.execute,{file:results.file,values:{storage:storageApi(storage,'pollresults')},reply:async body=>{replies.push(body.content!);}});
    assert.equal(replies[1],'A: 1 votes; B: 0 votes.');storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('utility example imports a module, persists a shared counter, and declares a schedule',{skip:!hasUtility},async()=>{
  const project=loadProject(join(examples,'utility')),compiled=discover(project);
  assert.equal(compiled.modules?.size,1);
  const root=mkdtempSync(join(tmpdir(),'wisp-utility-'));
  try{const storage=new Storage(join(root,'db.sqlite')),command=compiled.commands.find(item=>item.name==='hello')!,replies:string[]=[];
    await execute(command.execute,{file:command.file,values:{storage:storageApi(storage,'hello'),interaction:record({user:record({name:'Fox'})}) as Value},resolveImport:moduleResolver(project.root,compiled.modules!,{values:{}}),reply:async body=>{replies.push(body.content!);}});
    assert.deepEqual(replies,['Hello, Fox! Greeting #1.']);
    const ready=compiled.events.find(event=>event.name==='ready')!;let scheduled='';
    await execute(ready.body,{file:ready.file,values:{},schedule:(name)=>{scheduled=name;}});
    assert.equal(scheduled,'heartbeat');storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('utility summary example exercises Phase 1 collection and string methods',{skip:!hasUtility},async()=>{
  const project=loadProject(join(examples,'utility')),compiled=discover(project);
  const command=compiled.commands.find(item=>item.name==='summary');assert.ok(command);
  const replies:string[]=[];
  await execute(command.execute,{file:command.file,values:{math:mathApi(),options:record({words:' red, blue, green, yellow'}) as Value},reply:async body=>{replies.push(body.content??'');}});
  assert.deepEqual(replies,['4 words. First entries: RED, BLUE, GREEN']);
});

test('utility inspect example exercises JSON, map entries, ranges, and time',{skip:!hasUtility},async()=>{
  const project=loadProject(join(examples,'utility')),compiled=discover(project);
  const command=compiled.commands.find(item=>item.name==='inspect');assert.ok(command);
  const replies:string[]=[];
  await execute(command.execute,{file:command.file,values:{json:jsonApi(),time:timeApi(),options:record({data:'{"a":1,"b":2}'}) as Value},reply:async body=>{replies.push(body.content??'');}});
  assert.match(replies[0]!,/^2 keys\. First: Field a\. Time: <t:\d+:R>$/);
});
