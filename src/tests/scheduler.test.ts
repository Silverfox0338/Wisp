import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../compiler/parser.js';
import {execute,host,type Value} from '../runtime/interpreter.js';
import {Scheduler} from '../runtime/scheduler.js';

test('scheduler syntax registers bounded tasks and cancellation prevents execution',async()=>{
  const program=parse('after "once" 1 seconds:\n    log.info("fired")\n');
  assert.equal(program.statements[0]?.kind,'schedule');
  let runs=0;const scheduler=new Scheduler(()=>{},1);
  const values={log:{info:host(()=>{runs++;return null as Value;})} as Value};
  try{
    await execute(program.statements,{values,schedule:(name,seconds,repeat,body)=>scheduler.schedule(name,seconds,repeat,async()=>{await execute(body,{values});})});
    assert.equal(scheduler.size,1);
    assert.throws(()=>scheduler.schedule('second',1,false,async()=>{}),/Task limit reached/);
    assert.equal(scheduler.cancel('once'),true);
    await new Promise(resolve=>setTimeout(resolve,1050));
    assert.equal(runs,0);
  }finally{scheduler.close();}
});

test('recurring task failures are isolated and close stops future runs',async()=>{
  let failures=0,runs=0;const scheduler=new Scheduler(()=>{failures++;});
  scheduler.schedule('tick',1,true,async()=>{runs++;throw new Error('task failure');});
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(runs,1);assert.equal(failures,1);
  scheduler.close();assert.equal(scheduler.size,0);
});
