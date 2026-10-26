import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {storageApi} from '../runtime/stdlib.js';
import {compileModules,moduleResolver} from '../project/modules.js';
import {DatabaseManager} from '../storage/manager.js';
import type {ProjectConfig} from '../project/manifest.js';

async function replies(source:string,values:Record<string,Value>={}):Promise<string[]>{const out:string[]=[];await execute(parse(source).statements,{values,reply:async body=>{out.push(body.content!);}});return out;}

test('managed storage write failures reach Wisp try/catch instead of rejecting unhandled',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-hardening-'));
  const project={root,manifest:{name:'hardening',storage:{engine:'sqlite',path:'./data/bot.db'}},paths:{database:join(root,'data','bot.db')}} as unknown as ProjectConfig;
  const databases=await DatabaseManager.open(project);
  const unhandled:unknown[]=[];const onRejection=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',onRejection);
  try{
    const out=await replies('try:\n    storage.set("bad", len)\ncatch e:\n    reply e.wispCode\nstorage.set("good", 3)\nreply "{storage.get(\'good\')}"\n',{storage:storageApi(databases.storage,'test')});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(out,['STORAGE006','3']);assert.deepEqual(unhandled,[]);
  }finally{process.off('unhandledRejection',onRejection);await databases.close();rmSync(root,{recursive:true,force:true});}
});

test('maps with a call key are ordinary maps',async()=>{
  assert.deepEqual(await replies('let m = {"call": 1, "x": 2}\nreply "{len(m)}"\nfor item in m:\n    reply item.key\nreply "{m.keys()}"\n'),['2','call','x','[object]']);
});

test('call depth recovers after repeated overflow',async()=>{
  assert.deepEqual(await replies('function deep():\n    return deep()\nfunction ok():\n    return "fine"\nfor i in range(40):\n    try:\n        deep()\n    catch e:\n        let ignored = e\nreply ok()\n'),['fine']);
});

test('string format rejects oversized output before building it',async()=>{
  await assert.rejects(()=>replies('let big = "".pad_end(60000, "x")\nreply "%1%1".format(big)\n'),/64 KiB/);
});

test('imported modules share the importing invocation step budget',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-budget-'));try{
    const file=join(root,'main.wisp'),busy=join(root,'busy.wisp');
    writeFileSync(busy,'export function sum():\n    let total = 0\n    for i in range(200):\n        total = total + i\n    return total\n');
    const statements=parse('import "busy.wisp"\nreply "{busy.sum()}"\n',file).statements;
    const modules=compileModules(root,[{file,statements}]);
    await assert.rejects(()=>execute(statements,{file,values:{},maxSteps:100,resolveImport:moduleResolver(root,modules,{values:{}}),reply:async()=>{}}),/Execution limit exceeded/);
    const out:string[]=[];await execute(statements,{file,values:{},resolveImport:moduleResolver(root,modules,{values:{}}),reply:async body=>{out.push(body.content!);}});
    assert.deepEqual(out,['19900']);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('commands declare their automatic defer visibility',()=>{
  const command=parse('command "slow":\n    description "Slow"\n    defer: ephemeral\n    execute:\n        reply "done"\n').commands[0];
  assert.equal(command?.defer,'ephemeral');
  assert.throws(()=>parse('command "slow":\n    description "Slow"\n    defer: loud\n    execute:\n        reply "done"\n'),/public or ephemeral/);
});
