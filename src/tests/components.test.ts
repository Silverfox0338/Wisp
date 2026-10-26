import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {execute,record,type RuntimeComponent,type Value} from '../runtime/interpreter.js';
import {Storage} from '../storage/sqlite.js';
import {ComponentRegistry} from '../discord/components.js';

test('declarative buttons and select choices execute through the interpreter',async()=>{
  const source='command "poll":\n    description "Poll"\n    execute:\n        reply:\n            content: "Choose"\n            ephemeral: true\n            button "yes":\n                label: "Yes"\n                style: "success"\n                owner: "user"\n                state: {"poll": "one"}\n            select "choice":\n                placeholder: "Pick"\n                choice "red":\n                    label: "Red"\n';
  const module=parse(source),bodies:RuntimeComponent[][]=[];
  await execute(module.commands[0]!.execute,{values:{},reply:async body=>{assert.equal(body.content,'Choose');assert.equal(body.ephemeral,true);bodies.push(body.components!);}});
  assert.equal(bodies[0]?.[0]?.kind,'button');assert.equal(bodies[0]?.[1]?.choices?.[0]?.value,'red');
  const event=parse('on button "yes":\n    reply "Confirmed"\n');assert.equal(event.events[0]?.name,'button:yes');
});

test('component ownership, guild scope, expiration and persistence survive reopening SQLite',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-comp-')),path=join(root,'state.db');
  try{
    let storage=new Storage(path),registry=new ComponentRegistry(storage,'guild-1','user-1');
    const rows=await registry.buildRows([{kind:'button',name:'confirm',fields:{label:'Confirm',style:'success',owner:'user',expires:300,state:{poll:'one'}}}]);
    const component=rows[0]!.components[0]!.toJSON();assert.ok('custom_id' in component);const id=component.custom_id;
    assert.equal((await registry.resolve(id,'button','guild-1','user-1')).state.poll,'one');
    await assert.rejects(()=>registry.resolve(id,'button','guild-1','user-2'),/another user/);
    await assert.rejects(()=>registry.resolve(id,'button','guild-2','user-1'),/scope mismatch/);
    await assert.rejects(()=>registry.resolve(id,'select','guild-1','user-1'),/scope mismatch/);
    storage.close();storage=new Storage(path);registry=new ComponentRegistry(storage,'guild-1','user-1');
    assert.equal((await registry.resolve(id,'button','guild-1','user-1')).name,'confirm');
    storage.putComponent({id:'ss:'+'a'.repeat(32),kind:'button',name:'old',guildId:'guild-1',ownerId:null,expiresAt:Date.now()-1,state:{}});
    await assert.rejects(()=>registry.resolve('ss:'+'a'.repeat(32),'button','guild-1','user-1'),/expired/);
    storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('buttons remain active by default across restart and allow an explicit expiry',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-persistent-button-')),path=join(root,'state.db');
  try{
    let storage=new Storage(path),registry=new ComponentRegistry(storage,'guild-1','user-1');
    const permanent=(await registry.buildRows([{kind:'button',name:'open',fields:{label:'Open'}}]))[0]!.components[0]!.toJSON();
    const stateful=(await registry.buildRows([{kind:'button',name:'vote',fields:{label:'Vote',state:{poll:'one'}}}]))[0]!.components[0]!.toJSON();
    const timed=(await registry.buildRows([{kind:'button',name:'close',fields:{label:'Close',expires:60}}]))[0]!.components[0]!.toJSON();
    assert.ok('custom_id' in permanent&&'custom_id' in stateful&&'custom_id' in timed);
    assert.equal(permanent.custom_id,'sl:button:open');
    assert.equal(storage.snapshot().components.length,2,'plain buttons store no row');
    assert.equal((await registry.resolve(permanent.custom_id,'button','guild-1','user-1')).expiresAt,0);
    assert.equal((await registry.resolve(stateful.custom_id,'button','guild-1','user-1')).expiresAt,0);
    assert.ok((await registry.resolve(timed.custom_id,'button','guild-1','user-1')).expiresAt>Date.now());
    await assert.rejects(()=>registry.resolve(permanent.custom_id,'select','guild-1','user-1'),/scope mismatch/);
    assert.equal(storage.cleanupComponents(),0);
    storage.close();storage=new Storage(path);registry=new ComponentRegistry(storage,'guild-1','user-1');
    assert.equal((await registry.resolve(permanent.custom_id,'button','guild-1','user-1')).name,'open');
    assert.equal((await registry.resolve(timed.custom_id,'button','guild-1','user-1')).name,'close');
    const handler=parse('on button "open":\n    reply "Still working"\n').events[0]!;
    const replies:string[]=[];
    await execute(handler.body,{values:{interaction:record({state:record((await registry.resolve(permanent.custom_id,'button','guild-1','user-1')).state)}) as Value},reply:async body=>{replies.push(body.content!);}});
    assert.deepEqual(replies,['Still working']);
    await assert.rejects(()=>registry.buildRows([{kind:'button',name:'bad',fields:{label:'Bad',expires:-1}}]),/expires/);
    storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('modal syntax creates validated inputs and handler metadata',async()=>{
  const source='show modal "feedback":\n    title: "Feedback"\n    owner: "user"\n    input "message":\n        label: "Message"\n        style: "paragraph"\n';
  let modal:RuntimeComponent|undefined;await execute(parse(source).statements,{values:{},showModal:async value=>{modal=value;}});
  assert.equal(modal?.inputs?.[0]?.name,'message');
  assert.equal(parse('on modal "feedback":\n    reply interaction.fields.message\n').events[0]?.name,'modal:feedback');
  const root=mkdtempSync(join(tmpdir(),'wisp-modal-'));try{const storage=new Storage(join(root,'db.sqlite'));const registry=new ComponentRegistry(storage,'guild','user');assert.equal((await registry.buildModal(modal!)).toJSON().components?.length,1);storage.close();}finally{rmSync(root,{recursive:true,force:true});}
});

test('all entity selects produce Discord payloads with matching persistent handlers',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-select-'));
  try{
    const storage=new Storage(join(root,'db.sqlite')),registry=new ComponentRegistry(storage,'guild','user');
    for(const kind of ['user_select','role_select','channel_select'] as const){
      const rows=await registry.buildRows([{kind,name:`choose_${kind}`,fields:{placeholder:'Choose',min:0,max:2,owner:'user'}}]);
      const payload=rows[0]!.components[0]!.toJSON();
      assert.equal(payload.type,kind==='user_select'?5:kind==='role_select'?6:8);
      assert.ok('custom_id' in payload);
      assert.equal((await registry.resolve(payload.custom_id,kind,'guild','user')).name,`choose_${kind}`);
    }
    await assert.rejects(()=>registry.buildRows([{kind:'user_select',name:'bad',fields:{min:3,max:2}}]),/min\/max/);
    storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('expired components are removed by scheduled cleanup',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-expiry-'));
  try{
    const storage=new Storage(join(root,'db.sqlite'));
    storage.putComponent({id:'ss:'+'b'.repeat(32),kind:'button',name:'old',guildId:'guild',ownerId:null,expiresAt:Date.now()-1,state:{}});
    assert.equal(storage.cleanupComponents(),1);
    assert.equal(storage.getComponent('ss:'+'b'.repeat(32)),null);
    storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('stateful component rows are deleted with their message, channel, or guild',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {linkSentMessage,statefulComponentIds}=await import('../discord/components.js');
  const root=mkdtempSync(join(tmpdir(),'wisp-owner-')),path=join(root,'db.sqlite');
  try{
    const legacy=new DatabaseSync(path);legacy.exec('CREATE TABLE component_state(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,guild_id TEXT NOT NULL,owner_id TEXT,expires_at INTEGER NOT NULL,state_json TEXT NOT NULL)');legacy.close();
    const storage=new Storage(path),registry=new ComponentRegistry(storage,'guild-1','user-1');
    const build=async(name:string)=>{const rows=await registry.buildRows([{kind:'button',name,fields:{label:name,state:{n:1}}},{kind:'button',name:`${name}_plain`,fields:{label:'Plain'}}]);return rows.map(row=>row.toJSON());};
    const message=await build('a'),channel=await build('b'),guild=await build('c'),ephemeral=await build('d');
    const ids=statefulComponentIds(message);assert.equal(ids.length,1,'only stateful IDs are linked');
    await linkSentMessage(storage,{id:'m1',channel_id:'c1',components:message});
    await linkSentMessage(storage,{id:'m2',channelId:'c2',components:channel,flags:{bitfield:0}});
    await linkSentMessage(storage,{id:'m4',channel_id:'c4',components:ephemeral,flags:64});
    const ephemeralRow=storage.getComponent(statefulComponentIds(ephemeral)[0]!)!;assert.ok(ephemeralRow.expiresAt>Date.now()&&ephemeralRow.expiresAt<=Date.now()+86400000,'ephemeral rows expire after a day');
    assert.equal(storage.deleteComponentsFor('message',['m1','unknown']),1);assert.equal(storage.getComponent(ids[0]!),null);
    assert.equal(storage.deleteComponentsFor('channel',['c2']),1);
    assert.equal(storage.snapshot().components.filter(item=>item.guildId==='guild-1').length,2);
    assert.equal(storage.deleteComponentsFor('guild',['guild-1']),2);
    assert.equal(storage.snapshot().components.length,0);void guild;
    storage.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
