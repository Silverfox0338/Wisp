import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {analyze} from '../editor/service.js';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';
import {contextWarnings} from '../project/context.js';
import {execute,record,type Value} from '../runtime/interpreter.js';

function withProject(run:(root:string)=>Promise<void>|void):Promise<void>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-context-'));
  return Promise.resolve().then(()=>run(initProject('context',dir))).finally(()=>rmSync(dir,{recursive:true,force:true}));
}
const warningsFor=(source:string,file='x.wisp')=>{const module=parse(source,file);return contextWarnings(module.commands.map(command=>({...command,file})),module.events.map(event=>({...event,file})));};

test('wisp check warns when a handler uses guild, user, or interaction it will not have',()=>{
  const ready=warningsFor('on ready:\n    log.info(guild.name)\n');
  assert.equal(ready.length,1);
  assert.equal(ready[0]!.line,2);
  assert.match(ready[0]!.message,/guild isn't available in on ready:; it has event/);

  const timer=warningsFor('command "remind":\n    description "Remind me"\n    execute:\n        after "remind-{user.id}" 5 seconds with {"user_id": user.id}:\n            discord.send(interaction.channelId, "Hi {user.name}")\n            log.info(task.data.user_id)\n        reply "Set"\n');
  assert.deepEqual(timer.map(item=>item.name),['interaction','user']);
  assert.match(timer[0]!.message,/inside a timer.*with \{"channel": interaction\.channelId\}/);

  assert.deepEqual(warningsFor('on button "buy":\n    user.data.coins += 1\n    reply "Thanks {user.name} from {guild.name}"\n'),[]);
  assert.deepEqual(warningsFor('on member_join:\n    log.info("{user.name} joined {guild.name}")\n'),[]);
  assert.deepEqual(warningsFor('on ready:\n    let user = "nobody"\n    log.info(user)\n'),[]);
  assert.match(warningsFor('on gateway "TYPING_START":\n    log.info(user.id)\n')[0]!.message,/on gateway "TYPING_START"; it has event/);
  assert.match(warningsFor('on shard_ready:\n    log.info(options.x)\n')[0]!.message,/options isn't available in on shard_ready:/);

  const editor=analyze('on ready:\n    log.info(guild.name)\n').diagnostics.find(item=>item.code==='CONTEXT001');
  assert.equal(editor?.severity,2);
});

test('discover reports context warnings without failing the check',()=>withProject(root=>{
  writeFileSync(join(root,'events','tick.wisp'),'on ready:\n    every "tick" 60 seconds:\n        log.info(guild.name)\n');
  const compiled=discover(loadProject(root),false);
  assert.equal(compiled.warnings?.length,1);
  assert.match(compiled.warnings![0]!.message,/inside a timer, and the code that starts this timer doesn't have it either/);
}));

test('mock.press runs button and select handlers with guild and user, and guild.members() is faked',()=>withProject(async root=>{
  writeFileSync(join(root,'events','buy.wisp'),'on button "buy":\n    user.data.coins += 5\n    reply "{user.name} has {user.data.coins} coins in {guild.name}"\n');
  writeFileSync(join(root,'events','page.wisp'),'on button "page_*":\n    reply "page {interaction.index} for {interaction.state.list}"\n');
  writeFileSync(join(root,'events','color.wisp'),'on select "color":\n    reply "picked {interaction.values[0]}"\n');
  writeFileSync(join(root,'events','join.wisp'),'on member_join:\n    guild.data.joins += 1\n    user.data.greeted = true\n');
  writeFileSync(join(root,'commands','roster.wisp'),'command "roster":\n    description "List members"\n    execute:\n        let names = []\n        for member in guild.members():\n            names.append("{member.rank}. {member.name}")\n        let text = names.join(", ")\n        let found = guild.member("2")\n        reply "{text} | {found.name} | {guild.data.joins ?? 0} joins | {found.data.greeted ?? false}"\n');
  writeFileSync(join(root,'tests','press.test.wisp'),[
    'assert.equal(mock.press("buy")[0].content, "Test user has 5 coins in Test guild")',
    'mock.members([{"id": "1", "name": "Kuro"}, {"id": "2", "name": "Helper"}])',
    'assert.equal(mock.press("buy", {"user": "2"})[0].content, "Helper has 5 coins in Test guild")',
    'assert.equal(mock.press("buy")[0].content, "Kuro has 10 coins in Test guild")',
    'assert.equal(mock.press("page_3", {"state": {"list": "shop"}})[0].content, "page 3 for shop")',
    'assert.equal(mock.press("color", {"values": ["red"]})[0].content, "picked red")',
    'mock.runEvent("member_join", {"member": {"id": "2"}})',
    'assert.equal(mock.run("roster")[0].content, "1. Kuro, 2. Helper | Helper | 1 joins | true")',
    'let missing = ""',
    'try:',
    '    mock.press("nope")',
    'catch error:',
    '    missing = error.message',
    'assert.ok(missing.contains("No component handler"))',
    ''
  ].join('\n'));
  const project=loadProject(root);
  assert.equal(await runWispTests(project,discover(project,false)),2);
}));

test('in, contains, index, and remove compare lists and maps by value',async()=>{
  const source=[
    'let pairs = [[1, 2], [3]]',
    'let people = [{"id": 1, "tags": ["a"]}]',
    'checks.append([1, 2] in pairs)',
    'checks.append({"tags": ["a"], "id": 1} in people)',
    'checks.append({"id": 2} not in people)',
    'checks.append(people.contains({"id": 1, "tags": ["a"]}))',
    'checks.append(people.index({"id": 1, "tags": ["a"]}) == 0)',
    'checks.append(pairs.remove([3]))',
    'checks.append(pairs.length == 1)',
    'checks.append([1, 2] not in [[2, 1]])',
    'checks.append("id" in people[0])',
    ''
  ].join('\n');
  const checks:Value[]=[];
  await execute(parse(source).statements,{values:{checks}});
  assert.deepEqual(checks,[true,true,true,true,true,true,true,true,true]);
  const picked:Value[]=[];
  await execute(parse('picked.append(interaction.values[0])\npicked.append(interaction.keys)\n').statements,{values:{picked,interaction:record({values:['red'],keys:'own field'})}});
  assert.deepEqual(picked,['red','own field'],'built-in fields win over map methods of the same name');
});
