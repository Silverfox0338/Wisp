import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {parse} from '../compiler/parser.js';
import type {Stmt} from '../compiler/ast.js';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {commandRoute,discover,taskIndex} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';
import {execute} from '../runtime/interpreter.js';
import {Scheduler} from '../runtime/scheduler.js';
import {planRestore} from '../runtime/tasks.js';
import {Storage} from '../storage/sqlite.js';
import type {TaskRow} from '../storage/types.js';
import {checkCooldown} from '../discord/cooldowns.js';

function temp(prefix:string,run:(dir:string)=>Promise<void>|void):Promise<void>{const dir=mkdtempSync(join(tmpdir(),prefix));return Promise.resolve().then(()=>run(dir)).finally(()=>{const rel=relative(tmpdir(),dir);if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(dir,{recursive:true,force:true});});}
const command=(cooldown:string)=>`command "daily":\n    description "Daily"\n    ${cooldown}\n    execute:\n        reply "ok"\n`;

test('cooldown reads like a sentence and defaults to per user',()=>{
  assert.deepEqual(parse(command('cooldown: 10 seconds')).commands[0]!.cooldown,{seconds:10,per:'user'});
  assert.deepEqual(parse(command('cooldown: 2 hours per guild')).commands[0]!.cooldown,{seconds:7200,per:'guild'});
  assert.deepEqual(parse(command('cooldown: 1 day per channel')).commands[0]!.cooldown,{seconds:86400,per:'channel'});
  const nested=parse('command "eco":\n    description "Economy"\n    cooldown: 5 seconds\n    subcommand "work":\n        description "Work"\n        cooldown: 1 hour\n        execute:\n            reply "w"\n    subcommand "bal":\n        description "Balance"\n        execute:\n            reply "b"\n').commands[0]!;
  assert.equal(commandRoute(nested,null,'work')!.cooldown!.seconds,3600);
  assert.equal(commandRoute(nested,null,'bal')!.cooldown!.seconds,5);
});

test('cooldown mistakes explain the expected form',()=>{
  for(const [line,pattern] of [['cooldown: 10',/unit must be seconds, minutes, hours, or days/],['cooldown: 5 weeks',/not weeks/],['cooldown: 5 seconds per server',/per user, guild, or channel, not server/],['cooldown: soon',/needs a number/]] as const)
    assert.throws(()=>parse(command(line)),pattern,line);
  assert.throws(()=>parse(command('cooldown: 1 second\n    cooldown: 2 seconds')),/only once/);
});

test('SQLite cooldown claims are exclusive until they expire',()=>temp('wisp-cool-',dir=>{
  const db=new Storage(join(dir,'db.sqlite'));
  try{
    assert.equal(db.claimCooldown('slash:daily:user:1',1000,5000),null);
    assert.equal(db.claimCooldown('slash:daily:user:1',2000,6000),5000);
    assert.equal(db.claimCooldown('slash:daily:user:2',2000,6000),null);
    assert.equal(db.claimCooldown('slash:daily:user:1',5000,9000),null);
    assert.equal(db.cleanupCooldowns(9000),2);
  }finally{db.close();}
}));

test('checkCooldown keys by guild and builds a friendly reply',async()=>{
  const claims:string[]=[];let active:number|null=null;
  const storage={claimCooldown:(key:string)=>{claims.push(key);return active;}};
  assert.equal(await checkCooldown(storage,{seconds:60,per:'guild'},'slash:daily','/daily',{user:'1',guild:'9',channel:'3'},0),null);
  active=90_000;
  assert.equal(await checkCooldown(storage,{seconds:60,per:'guild'},'slash:daily','/daily',{user:'1',guild:'9',channel:'3'},0),'Slow down! You can use /daily again <t:90:R>.');
  assert.deepEqual(claims,['slash:daily:guild:9','slash:daily:guild:9']);
  assert.equal(await checkCooldown(storage,undefined,'x','/x',{user:'1',guild:null,channel:null}),null);
});

test('saved tasks survive reopening SQLite and appear in snapshots',()=>temp('wisp-task-',dir=>{
  const path=join(dir,'db.sqlite'),row:TaskRow={name:'remind-1',file:'commands/remind.wisp',template:'remind-{user.id}',repeat:false,intervalSeconds:60,fireAt:123,data:{channel:'42'}};
  let db=new Storage(path);db.putTask(row);db.putTask({...row,fireAt:456});db.close();
  db=new Storage(path);
  try{
    assert.deepEqual(db.listTasks(),[{...row,fireAt:456}]);
    assert.deepEqual(db.snapshot().tasks,[{...row,fireAt:456}]);
    db.deleteTask('remind-1');assert.deepEqual(db.listTasks(),[]);
  }finally{db.close();}
}));

test('restore skips missed runs and drops tasks whose code is gone',()=>{
  const body:Stmt[]=[],bodies=new Map([['heartbeat',body],['remind-{user.id}',body]]);
  const base:TaskRow={name:'heartbeat',file:'events/ready.wisp',template:'heartbeat',repeat:true,intervalSeconds:60,fireAt:0,data:null};
  const [future,missedEvery,missedAfter,gone]=planRestore([{...base,fireAt:130_000},{...base,fireAt:10_000},{...base,name:'remind-1',template:'remind-{user.id}',repeat:false,fireAt:50_000},{...base,name:'old',template:'old'}],bodies,100_000);
  assert.deepEqual([future!.action,future!.action==='arm'&&future!.delaySeconds],['arm',30]);
  assert.ok(missedEvery!.action==='arm'&&missedEvery!.moved&&missedEvery!.row.fireAt===130_000&&missedEvery!.delaySeconds===30);
  assert.deepEqual(missedAfter,{action:'drop',row:{...base,name:'remind-1',template:'remind-{user.id}',repeat:false,fireAt:50_000},reason:'missed'});
  assert.equal(gone!.action==='drop'&&gone!.reason,'missing');
});

test('two different timers with the same name are a compile error',()=>{
  const twice=parse('after "x" 5 seconds:\n    log.info("a")\nafter "x" 5 seconds:\n    log.info("b")\n').statements;
  assert.throws(()=>taskIndex([{file:'a.wisp',statements:twice}]),/Two timers are named "x"/);
  const shared=parse('function setup():\n    every "beat" 60 seconds:\n        log.info("b")\n').statements;
  assert.equal(taskIndex([{file:'a.wisp',statements:shared},{file:'b.wisp',statements:shared}]).size,1);
});

test('timer names fill in values and with passes plain data',async()=>{
  const calls:{name:string;data:unknown;template?:string}[]=[];
  const source='after "remind-{user}" 60 seconds with {"channel": "42"}:\n    log.info("hi")\n';
  await execute(parse(source).statements,{values:{user:'7'},schedule:(name,_s,_r,_b,meta)=>{calls.push({name,data:meta?.data,template:meta?.template});}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:'remind-7',data:{channel:'42'},template:'remind-{user}'}]);
  await assert.rejects(()=>execute(parse('after "x" 60 seconds with "nope":\n    log.info("hi")\n').statements,{values:{},schedule:()=>{}}),/with needs a map/);
});

test('scheduler honours a first delay and reports each run',async()=>{
  const scheduler=new Scheduler(()=>{});const fired:(number|null)[]=[];let runs=0;
  try{
    scheduler.schedule('soon',60,false,async()=>{runs++;},{firstDelaySeconds:0.05,onFire:next=>fired.push(next)});
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(runs,1);assert.deepEqual(fired,[null]);assert.equal(scheduler.size,0);
    assert.throws(()=>scheduler.schedule('bad name',60,false,async()=>{}),/must start with a letter/);
  }finally{scheduler.close();}
});

test('Wisp tests can check cooldowns and run scheduled tasks',async()=>temp('wisp-ct-',async dir=>{
  const root=initProject('timers',dir);
  writeFileSync(join(root,'commands','daily.wisp'),'command "daily":\n    description "Claim coins"\n    cooldown: 24 hours per user\n    execute:\n        reply "Claimed!"\n');
  writeFileSync(join(root,'commands','remind.wisp'),'command "remind":\n    description "Remind me"\n    execute:\n        after "remind-{interaction.user.id}" 600 seconds with {"user": interaction.user.id}:\n            storage.sharedSet("reminded", task.data.user)\n        reply "Okay"\n');
  writeFileSync(join(root,'commands','eight.wisp'),'command "eight":\n    description "Too long"\n    cooldown: 8 days\n    execute:\n        reply "x"\n');
  const project=loadProject(root);
  assert.throws(()=>discover(project),/between 1 second and 7 days/);
  rmSync(join(root,'commands','eight.wisp'));
  writeFileSync(join(root,'tests','timers.test.wisp'),`assert.equal(mock.run("daily")[0].content, "Claimed!")
let blocked = mock.run("daily")[0]
assert.ok(blocked.content.contains("Slow down! You can use /daily again"))
assert.equal(blocked.ephemeral, true)
mock.as("2")
assert.equal(mock.run("daily")[0].content, "Claimed!")
mock.as("1")
mock.advance(86400)
assert.equal(mock.run("daily")[0].content, "Claimed!")
mock.run("remind")
let pending = mock.tasks()
assert.equal(pending[0].name, "remind-1")
assert.equal(pending[0].data.user, "1")
mock.runTask("remind-1")
assert.equal(storage.sharedGet("reminded"), "1")
assert.equal(len(mock.tasks()), 0)
`);
  const compiled=discover(project);
  assert.equal(compiled.tasks!.has('remind-{interaction.user.id}'),true);
  assert.equal(await runWispTests(project,compiled),2);
}));
