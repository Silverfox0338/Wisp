import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {componentIndex,findComponentHandler} from '../project/discovery.js';
import {compileModules,moduleResolver} from '../project/modules.js';
import {execute,record,type Value} from '../runtime/interpreter.js';
import {Storage} from '../storage/sqlite.js';
import {ComponentRegistry} from '../discord/components.js';
import {uiApi} from '../discord/ui.js';

test('multiline scenes, optional fields, and elif evaluate together',async()=>{
  const source=`let scene = {
    "h": "The Old Well",
    "c": [
        {"l": "Climb down", "to": ["treasure", "fall"]},
        {"l": "Step back", "to": ["square"]},
    ],
}
let hp = scene.hp ?? 0
if hp > 0:
    reply "hurt"
elif len(scene.c) == 2:
    reply scene.c[0].l
else:
    reply "empty"
`;
  const replies:string[]=[];
  await execute(parse(source).statements,{values:{},reply:async body=>{replies.push(body.content!);}});
  assert.deepEqual(replies,['Climb down']);
  await assert.rejects(()=>execute(parse('reply scene.hp\n').statements,{values:{scene:record({}) as Value},reply:async()=>{}}),/Property hp is unavailable/);
});

test('reply accepts buttons as data and ui.rows output alongside an embed',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-006-ui-'));
  try{
    const db=new Storage(join(root,'data.db')),registry=new ComponentRegistry(db,'guild','user');
    const values={ui:uiApi(registry)};
    const source=`let buttons = []
let labels = ["Down", "Back", "Wait"]
let i = 0
for label in labels:
    buttons.append(ui.button("pick_{i}", label, {"state": {"scene": "well"}}))
    i = i + 1
reply:
    content: "Choose"
    embed: ui.embed("The Old Well", "A cold rope", {"color": "#4488aa"})
    components: buttons
`;
    let body:Awaited<Parameters<NonNullable<Parameters<typeof execute>[1]['reply']>>[0]>|undefined;
    await execute(parse(source).statements,{values,reply:async value=>{body=value;}});
    assert.equal(body?.components?.length,3);
    assert.deepEqual(body?.components?.map(button=>button.name),['pick_0','pick_1','pick_2']);
    assert.equal(body?.embed?.title,'The Old Well');
    registry.buildRows(body!.components!);
    const rowsSource='reply:\n    content: "Rows"\n    components: ui.rows([ui.button("pick_0", "Down")])\n';
    await execute(parse(rowsSource).statements,{values,reply:async value=>{assert.equal(value.rawComponents?.length,1);}});
    db.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('wildcard button handler shares a file and exposes the selected index',()=>{
  const event=parse('on button "pick_*":\n    reply "{interaction.index}"\n').events[0]!;
  assert.equal(findComponentHandler([event],'button','pick_2'),event);
  assert.equal(componentIndex(event,'pick_2'),2);
  assert.equal(componentIndex(event,'pick_next'),null);
  assert.equal(findComponentHandler([event],'button','other'),undefined);
  const exact=parse('on button "pick_2":\n    reply "exact"\n').events[0]!;
  assert.equal(findComponentHandler([event,exact],'button','pick_2'),exact);
  assert.throws(()=>parse('on select "pick_*":\n    reply "bad"\n'),/Only button handlers/);
});

test('module helpers can reply through the importing interaction',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-006-module-'));
  try{
    const file=join(root,'command.wisp');
    writeFileSync(join(root,'view.wisp'),'export function show(text):\n    reply:\n        content: text\n');
    const statements=parse('import "view.wisp"\nview.show("Shared screen")\n',file).statements;
    const modules=compileModules(root,[{file,statements}]),replies:string[]=[];
    const reply=async(body:{content?:string})=>{replies.push(body.content!);};
    await execute(statements,{file,values:{},reply,resolveImport:moduleResolver(root,modules,{values:{},reply})});
    assert.deepEqual(replies,['Shared screen']);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('scheduled delay accepts a computed expression',async()=>{
  const scheduled:number[]=[];
  await execute(parse('let minutes = 10\nafter "remind" minutes * 60 seconds:\n    reply "Due"\n').statements,{values:{},schedule:(_name,seconds)=>{scheduled.push(seconds);}});
  assert.deepEqual(scheduled,[600]);
});
