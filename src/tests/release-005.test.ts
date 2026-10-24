import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {execute,type HostFunction} from '../runtime/interpreter.js';
import {ExecutionTrace,writeTrace} from '../runtime/trace.js';
import {permissionApi} from '../discord/permissions.js';
import {explainDiscordError} from '../discord/errors.js';
import {Storage} from '../storage/sqlite.js';
import {ComponentRegistry} from '../discord/components.js';
import {uiApi} from '../discord/ui.js';
import {analyze,completion} from '../editor/service.js';

test('execution trace records nested function return and failure location',async()=>{
  const trace=new ExecutionTrace('example');
  const source='function add(a):\n    return a + 1\nlet result = add(2)\nraise "failed"\n';
  await assert.rejects(()=>execute(parse(source).statements,{values:{},file:'example.wisp',trace}),/failed/);
  const nodes=JSON.stringify(trace.roots);
  assert.match(nodes,/function add/);
  assert.match(nodes,/"result":"3"/);
  assert.match(nodes,/"line":4/);
  assert.match(nodes,/failed/);
  const root=mkdtempSync(join(tmpdir(),'wisp-trace-'));
  try{const report=writeTrace(root,trace);assert.match(readFileSync(report.html,'utf8'),/function add/);assert.match(readFileSync(report.json,'utf8'),/failed/);}finally{rmSync(root,{recursive:true,force:true});}
});

test('permission and hierarchy helpers are advisory and validate names',async()=>{
  const api=permissionApi() as Record<string,HostFunction>;
  const bits=await api.of!.call('manage_roles') as string;
  const actor={permissions:bits,highestRolePosition:10};
  assert.equal(await api.has!.call(actor,'manage_roles'),true);
  assert.equal(await api.above!.call(actor,{position:9}),true);
  assert.equal(await api.canManageRole!.call(actor,{position:11}),false);
  assert.throws(()=>api.has!.call(actor,'invented_permission'),/Unknown Discord permission/);
});

test('UI builders register persistent controls and reject bad shapes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-ui-')),db=new Storage(join(root,'data','bot.db'));
  try{
    const registry=new ComponentRegistry(db,'guild','user'),api=uiApi(registry) as Record<string,HostFunction>;
    const button=await api.button!.call('approve','Approve',{owner:'user'});
    const rows=await api.rows!.call([button]) as {components:{custom_id:string}[]}[];
    assert.equal(rows.length,1);
    assert.equal(registry.resolve(rows[0]!.components[0]!.custom_id,'button','guild','user').name,'approve');
    assert.throws(()=>api.rows!.call([]),/1 to 25 components/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('Discord explanations and editor completions cover the new helpers',()=>{
  assert.match(explainDiscordError(403,50013),/role/);
  assert.match(explainDiscordError(429,null),/rate limiting/);
  assert.ok(completion(analyze('ui.','editor.wisp'),{line:0,character:3}).some(item=>item.label==='button'));
  assert.ok(completion(analyze('event.message.','editor.wisp'),{line:0,character:14}).some(item=>item.label==='content'));
  assert.ok(completion(analyze('discord.permissions.of("manage_','editor.wisp'),{line:0,character:32}).some(item=>item.label==='manage_roles'));
});
