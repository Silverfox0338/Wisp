import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {ResponseState} from '../discord/responses.js';
import {ComponentRegistry} from '../discord/components.js';
import {uiApi} from '../discord/ui.js';
import {embed2,v2Payload} from '../discord/v2.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {Storage} from '../storage/sqlite.js';
import {discordApi} from '../discord/api.js';
import type {Client} from 'discord.js';
import type {HostFunction} from '../runtime/interpreter.js';
import {analyze} from '../editor/service.js';

test('embed 2.0 builds a Discord Components V2 card with media and persistent buttons',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-007-'));
  const db=new Storage(join(root,'data.db'));
  try{
    const ui=uiApi(new ComponentRegistry(db,'guild','user'));
    let body:Record<string,Value>|undefined;
    const source=`reply:\n    v2: ui.embed2("News", "A new release", {"color":"#8B5CF6","thumbnail":"https://example.com/icon.png","fields":[{"name":"Status","value":"Ready"}],"image":"https://example.com/photo.png","footer":"Wisp","rows":ui.rows([ui.button("more","More")])})\n`;
    await execute(parse(source).statements,{values:{ui},reply:async result=>{body=result.v2;}});
    assert.equal(body?.flags,32768);
    const card=(body?.components as Record<string,Value>[])[0]!;
    assert.equal(card.type,17);
    assert.equal(card.accent_color,0x8b5cf6);
    const children=card.components as Record<string,Value>[];
    assert.deepEqual(children.map(item=>item.type),[9,10,12,10,1]);
    assert.equal((children[4]!.components as Record<string,Value>[])[0]!.type,2);
    assert.equal((children[4]!.components as Record<string,Value>[])[0]!.custom_id,'sl:button:more');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('custom V2 layouts and validation enforce component budget and exclusive content',async()=>{
  const layout=v2Payload([{type:10,content:'Hello'},{type:14,spacing:1,divider:true}]);
  assert.equal(layout.flags,32768);
  assert.throws(()=>v2Payload(Array.from({length:41},()=>({type:10,content:'x'}))),/40/);
  assert.throws(()=>embed2('Title','Body',{image:'file:///secret'}),/HTTP/);
  await assert.rejects(()=>execute(parse('reply:\n    content: "Old"\n    v2: ui.embed2("New", "Body")\n').statements,{values:{ui:uiApi({} as ComponentRegistry)},reply:async()=>{}}),/cannot mix/);
});

test('V2 interaction replies set the flag and retain private visibility',async()=>{
  const captured:Record<string,unknown>[]=[];
  const port={reply:async(value:Record<string,unknown>)=>{captured.push(value);},editReply:async()=>{},deleteReply:async()=>{},followUp:async()=>{},deferReply:async()=>{},showModal:async()=>{}} as unknown as ConstructorParameters<typeof ResponseState>[0];
  const response=new ResponseState(port,60000);
  try{await response.send({v2:embed2('Title','Body'),ephemeral:true});}finally{response.close();}
  assert.equal(captured[0]?.flags,32768|64);
  assert.equal(captured[0]?.content,undefined);
  assert.equal(captured[0]?.embeds,undefined);
  assert.equal((captured[0]?.components as Value[]).length,1);
});

test('declarative reply v2 syntax builds the requested profile layout',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-007-profile-'));
  const db=new Storage(join(root,'data.db'));
  try{
    const source=`command "profile":
    description "View your profile"
    execute:
        reply v2:
            container:
                accent: "#9B59FF"

                markdown:
                    ## Your Profile
                    Welcome back, {user.name}!

                separator

                section:
                    text: "Level 24 | XP: 1,250"
                    thumbnail: user.avatar

                row:
                    button "stats":
                        label: "Statistics"
                        style: primary

                    button "inventory":
                        label: "Inventory"
                        style: secondary
`;
    const command=parse(source).commands[0]!;
    assert.deepEqual(analyze(source).diagnostics,[]);
    let payload:Record<string,Value>|undefined;
    await execute(command.execute,{values:{user:{name:'Fox',avatar:'https://example.com/avatar.png'},ui:uiApi(new ComponentRegistry(db,'guild','user'))},reply:async body=>{payload=body.v2;}});
    assert.equal(payload?.flags,32768);
    const card=(payload?.components as Record<string,Value>[])[0]!;
    assert.equal(card.accent_color,0x9b59ff);
    const items=card.components as Record<string,Value>[];
    assert.deepEqual(items.map(item=>item.type),[10,14,9,1]);
    assert.equal(items[0]?.content,'## Your Profile\nWelcome back, Fox!');
    assert.equal((items[3]?.components as Value[]).length,2);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('short channel send accepts a V2 payload map',async()=>{
  let sent:Record<string,unknown>|undefined;
  const client={rest:{request:async(value:Record<string,unknown>)=>{sent=value;return {id:'99'};}}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  await api.send!.call('42',embed2('Hello','World'));
  const body=sent?.body as Record<string,Value>;
  assert.equal(body.flags,32768);
  assert.equal((body.components as Value[]).length,1);
  assert.equal(body.content,undefined);
});

test('declarative V2 replies allow private visibility',async()=>{
  let privateReply=false;
  await execute(parse('reply v2:\n    ephemeral: true\n    text: "Private"\n').statements,{values:{},reply:async body=>{privateReply=body.ephemeral===true;}});
  assert.equal(privateReply,true);
});

test('Markdown must be declared and hash comments retain their meaning elsewhere',()=>{
  assert.throws(()=>parse('reply v2:\n    text:\n        # Heading\n'),/markdown:/);
  assert.equal(parse('# A comment\nreply "Hello" # Another comment\n').statements.length,1);
});

test('reply defaults to a declarative classic embed and also accepts explicit v1',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-007-v1-'));
  const db=new Storage(join(root,'data.db'));
  try{
    const source=`reply:
    embed:
        title: "Profile"
        color: "#9B59FF"
        markdown:
            ## Hello, {user.name}
            Your level is 24.
    row:
        button "stats":
            label: "Statistics"
            style: primary
`;
    const values={user:{name:'Fox'},ui:uiApi(new ComponentRegistry(db,'guild','user'))};
    const replies:Record<string,Value>[]=[];
    await execute(parse(source).statements,{values,reply:async body=>{replies.push(body as Record<string,Value>);}});
    await execute(parse(source.replace('reply:', 'reply v1:')).statements,{values,reply:async body=>{replies.push(body as Record<string,Value>);}});
    for(const body of replies){assert.equal(body.v2,undefined);assert.equal((body.embed as Record<string,Value>).description,'## Hello, Fox\nYour level is 24.');assert.equal((body.components as Value[]).length,1);}
    let content='';
    await execute(parse('reply:\n    markdown:\n        # A classic heading\n').statements,{values,reply:async body=>{content=body.content!;}});
    assert.equal(content,'# A classic heading');
    assert.throws(()=>parse('reply:\n    container:\n        text: "V2 only"\n'),/reply v2/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
