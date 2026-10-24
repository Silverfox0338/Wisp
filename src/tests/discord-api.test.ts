import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'discord.js';
import {discordApi} from '../discord/api.js';
import {parse} from '../compiler/parser.js';
import {execute,host,record,type HostFunction,type Value} from '../runtime/interpreter.js';
import {discordIntents} from '../project/manifest.js';
import {apiMetadata} from '../runtime/api-metadata.js';
import {referenceApi,referenceRoutes} from '../discord/reference.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Discord bridge sends JSON routes through the shared REST client',async()=>{
  let request:unknown;
  const client={rest:{request:async(value:unknown)=>{request=value;return {id:'123',content:'Hi'};}}} as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  const result=await api.request!.call('POST','/channels/42/messages',{content:'Hi'},{wait:true},'test') as Record<string,Value>;
  assert.equal(result.id,'123');
  assert.deepEqual(request,{fullRoute:'/channels/42/messages',method:'POST',body:{content:'Hi'},query:new URLSearchParams('wait=true'),reason:'test'});
});

test('editor metadata covers every published Discord helper',()=>{
  const api=discordApi({} as Client) as Record<string,unknown>;
  assert.deepEqual(Object.keys(api).sort(),Object.keys(apiMetadata.discord!).sort());
});

test('every bundled HTTP route has a named helper and editor signature',async()=>{
  const seen:Record<string,unknown>[]=[];
  const api=discordApi({} as Client) as Record<string,Record<string,HostFunction>>;
  const generated=referenceApi(host((method,path,body,query,reason,files)=>{
    seen.push({method,path,body,query,reason,files});
    return null;
  }));
  let count=0;
  for(const [namespace,routes] of Object.entries(referenceRoutes)){
    const group=api[namespace]!;
    const metadata=apiMetadata[`discord${namespace[0]!.toUpperCase()}${namespace.slice(1)}`]!;
    for(const [name,route] of Object.entries(routes)){
      assert.ok(group[name],`${namespace}.${name}`);
      assert.ok(metadata[name]?.signature,`editor signature for ${namespace}.${name}`);
      const ids=[...route.route.matchAll(/\{[^}]+\}/g)].map(()=> '42');
      await generated[namespace]![name]!.call(...ids);
      const sent=seen.at(-1)!;
      assert.equal(sent.method,route.method,`${namespace}.${name} method`);
      assert.equal(sent.path,route.route.replace(/\{[^}]+\}/g,'42'),`${namespace}.${name} route`);
      count++;
    }
  }
  assert.equal(count,213);
});

test('reference helpers forward body, query, audit reason, and files safely',async()=>{
  const seen:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{seen.push(value);return null;}}} as unknown as Client;
  const api=discordApi(client) as Record<string,Record<string,HostFunction>>;
  await api.emojis!.createGuild!.call('42',{name:'fox',image:'data:image/png;base64,AAAA'},null,'setup');
  await api.webhooks!.execute!.call('42','token_abc',{content:'Hi'},{wait:true});
  await api.templates!.get!.call('abc-123');
  assert.deepEqual(seen[0]?.body,{name:'fox',image:'data:image/png;base64,AAAA'});
  assert.equal(seen[0]?.reason,'setup');
  assert.equal(seen[1]?.auth,false);
  assert.equal((seen[1]?.query as URLSearchParams).get('wait'),'true');
  assert.equal(seen[2]?.fullRoute,'/guilds/templates/abc-123');
  await assert.rejects(async()=>api.templates!.get!.call('../secret'),/path value|Discord path/);
});

test('named channel and role operations use validated Discord routes',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return {id:'123'};}}} as unknown as Client;
  const api=discordApi(client) as Record<string,Record<string,HostFunction>>;
  await api.channels!.create!.call('42',{name:'support',type:0},'ticket setup');
  await api.channels!.edit!.call('123',{topic:'Help'});
  await api.roles!.create!.call('42',{name:'Helper',permissions:'66560'});
  await api.roles!.delete!.call('42','123');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['POST','/guilds/42/channels'],['PATCH','/channels/123'],['POST','/guilds/42/roles'],['DELETE','/guilds/42/roles/123']
  ]);
  assert.equal(requests[0]?.reason,'ticket setup');
  assert.deepEqual(requests[2]?.body,{name:'Helper',permissions:'66560'});
  await assert.rejects(async()=>api.channels!.create!.call('../42',{name:'bad'}),/Guild ID/);
  await assert.rejects(async()=>api.roles!.create!.call('42',[]),/Role options/);
});

test('message, member, and overwrite helpers use the shared REST bridge',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return null;}}} as unknown as Client;
  const api=discordApi(client) as Record<string,Record<string,HostFunction>>;
  await api.messages!.send!.call('10','Hello');
  await api.messages!.edit!.call('10','11',{'content':'Updated'});
  await api.messages!.list!.call('10',{limit:5});
  await api.members!.addRole!.call('20','21','22','promotion');
  await api.members!.removeRole!.call('20','21','22');
  await api.channels!.setPermissions!.call('10','22',{allow:'66560',deny:'0',type:0});
  await api.channels!.deletePermissions!.call('10','22');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['POST','/channels/10/messages'],['PATCH','/channels/10/messages/11'],['GET','/channels/10/messages'],
    ['PUT','/guilds/20/members/21/roles/22'],['DELETE','/guilds/20/members/21/roles/22'],
    ['PUT','/channels/10/permissions/22'],['DELETE','/channels/10/permissions/22']
  ]);
  assert.equal(requests[2]?.query instanceof URLSearchParams?requests[2].query.get('limit'):null,'5');
  assert.deepEqual(requests[0]?.body,{content:'Hello'});
  assert.equal(requests[3]?.reason,'promotion');
  await assert.rejects(async()=>api.messages!.get!.call('bad','11'),/Channel ID/);
  await assert.rejects(async()=>api.channels!.setPermissions!.call('10','22',{allow:66560,type:0}),/decimal string/);
});

test('moderation, reactions, and threads expose named REST operations',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return null;}}} as unknown as Client;
  const api=discordApi(client) as Record<string,Record<string,HostFunction>>;
  await api.members!.kick!.call('20','21','spam');
  await api.bans!.create!.call('20','21',{delete_message_seconds:3600},'spam');
  await api.bans!.delete!.call('20','21');
  await api.reactions!.add!.call('10','11','👍');
  await api.reactions!.removeOwn!.call('10','11','ok:123');
  await api.threads!.create!.call('10',{name:'Discussion',type:11});
  await api.threads!.createFromMessage!.call('10','11',{name:'Reply thread'});
  await api.threads!.addMember!.call('30','21');
  await api.threads!.leave!.call('30');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['DELETE','/guilds/20/members/21'],['PUT','/guilds/20/bans/21'],['DELETE','/guilds/20/bans/21'],
    ['PUT','/channels/10/messages/11/reactions/%F0%9F%91%8D/@me'],
    ['DELETE','/channels/10/messages/11/reactions/ok%3A123/@me'],
    ['POST','/channels/10/threads'],['POST','/channels/10/messages/11/threads'],
    ['PUT','/channels/30/thread-members/21'],['DELETE','/channels/30/thread-members/@me']
  ]);
  assert.equal(requests[0]?.reason,'spam');
  assert.deepEqual(requests[1]?.body,{delete_message_seconds:3600});
  await assert.rejects(async()=>api.reactions!.add!.call('10','11',''),/Emoji/);
  await assert.rejects(async()=>api.threads!.join!.call('../30'),/Thread ID/);
});

test('short Discord calls keep common arguments first and optional settings last',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return {id:'99'};}}} as unknown as Client;
  const script=parse('let role = discord.role("20", "Helper", {"color": 255})\nlet channel = discord.channel("20", "help", {"type": 0})\ndiscord.send(channel.id, "Welcome", {"allowed_mentions": {"parse": []}})\ndiscord.react(channel.id, "99", "👍")\ndiscord.ban("20", "21", "spam", {"delete_message_seconds": 60})\n');
  await execute(script.statements,{values:{discord:discordApi(client)}});
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['POST','/guilds/20/roles'],['POST','/guilds/20/channels'],['POST','/channels/99/messages'],
    ['PUT','/channels/99/messages/99/reactions/%F0%9F%91%8D/@me'],['PUT','/guilds/20/bans/21']
  ]);
  assert.deepEqual(requests[0]?.body,{color:255,name:'Helper'});
  assert.deepEqual(requests[2]?.body,{allowed_mentions:{parse:[]},content:'Welcome'});
  assert.equal(requests[4]?.reason,'spam');
  assert.deepEqual(requests[4]?.body,{delete_message_seconds:60});
  const api=discordApi(client) as Record<string,HostFunction>;
  await assert.rejects(async()=>api.channel!.call('20',''),/Channel name/);
  await assert.rejects(async()=>api.send!.call('99',2),/Message content/);
});

test('short message, DM, invite, and member calls forward trailing options',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return {id:'99'};}}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  await api.editMessage!.call('10','11','Updated',{allowed_mentions:{parse:[]}});
  await api.deleteMessage!.call('10','11','cleanup');
  await api.dm!.call('21','Hello privately');
  await api.invite!.call('10',{max_age:0,max_uses:1},'one use');
  await api.nick!.call('20','21','Helper');
  await api.timeout!.call('20','21',60,'cooldown');
  await api.untimeout!.call('20','21');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['PATCH','/channels/10/messages/11'],['DELETE','/channels/10/messages/11'],
    ['POST','/users/@me/channels'],['POST','/channels/99/messages'],['POST','/channels/10/invites'],
    ['PATCH','/guilds/20/members/21'],['PATCH','/guilds/20/members/21'],['PATCH','/guilds/20/members/21']
  ]);
  assert.deepEqual(requests[0]?.body,{allowed_mentions:{parse:[]},content:'Updated'});
  assert.deepEqual(requests[2]?.body,{recipient_id:'21'});
  assert.deepEqual(requests[3]?.body,{content:'Hello privately'});
  assert.deepEqual(requests[4]?.body,{max_age:0,max_uses:1});
  assert.deepEqual(requests[5]?.body,{nick:'Helper'});
  assert.match(String((requests[6]?.body as Record<string,unknown>).communication_disabled_until),/^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(requests[7]?.body,{communication_disabled_until:null});
  await assert.rejects(async()=>api.timeout!.call('20','21',28*86400+1),/Timeout/);
  await assert.rejects(async()=>api.dm!.call('bad','Hello'),/User ID/);
});

test('reference-backed poll, event, audit, and Auto Moderation calls use documented routes',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return {id:'99'};}}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction|Record<string,HostFunction>>;
  await (api.poll as HostFunction).call('10','Lunch?',['Pizza','Tacos'],{duration:48,allow_multiselect:true,content:'Vote now'});
  await (api.voters as HostFunction).call('10','11',1,{limit:25});
  await (api.endPoll as HostFunction).call('10','11');
  await (api.audit as HostFunction).call('20',{limit:5});
  const events=api.events as Record<string,HostFunction>;
  await events.create!.call('20',{name:'Launch',privacy_level:2,entity_type:2,channel_id:'10',scheduled_start_time:'2026-11-01T20:00:00Z'});
  await events.users!.call('20','30',{limit:10});
  const automod=api.automod as Record<string,HostFunction>;
  await automod.create!.call('20',{name:'Filter',event_type:1,trigger_type:1,actions:[]});
  await automod.delete!.call('20','31');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['POST','/channels/10/messages'],['GET','/channels/10/polls/11/answers/1'],['POST','/channels/10/polls/11/expire'],
    ['GET','/guilds/20/audit-logs'],['POST','/guilds/20/scheduled-events'],
    ['GET','/guilds/20/scheduled-events/30/users'],['POST','/guilds/20/auto-moderation/rules'],
    ['DELETE','/guilds/20/auto-moderation/rules/31']
  ]);
  assert.deepEqual(requests[0]?.body,{content:'Vote now',poll:{question:{text:'Lunch?'},answers:[{poll_media:{text:'Pizza'}},{poll_media:{text:'Tacos'}}],duration:48,allow_multiselect:true,layout_type:1}});
  await assert.rejects(async()=>(api.poll as HostFunction).call('10','Bad',['only one']),/2 to 10 answers/);
  await assert.rejects(async()=>(api.poll as HostFunction).call('10','Bad',['A','B'],{duration:769}),/duration/);
  await assert.rejects(async()=>(api.voters as HostFunction).call('10','11',0),/answer ID/);
});

test('reference-backed user, guild, and current pin routes stay concise',async()=>{
  const requests:Record<string,unknown>[]=[];
  const client={rest:{request:async(value:Record<string,unknown>)=>{requests.push(value);return null;}}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  await api.guild!.call('20');
  await api.user!.call('21');
  await api.pins!.call('10',{limit:5});
  await api.pin!.call('10','11','important');
  await api.unpin!.call('10','11');
  assert.deepEqual(requests.map(({method,fullRoute})=>[method,fullRoute]),[
    ['GET','/guilds/20'],['GET','/users/21'],['GET','/channels/10/messages/pins'],
    ['PUT','/channels/10/messages/pins/11'],['DELETE','/channels/10/messages/pins/11']
  ]);
  assert.equal(requests[2]?.query instanceof URLSearchParams?requests[2].query.get('limit'):null,'5');
  assert.equal(requests[3]?.reason,'important');
  await assert.rejects(async()=>api.pin!.call('10','oops'),/Message ID/);
});

test('permission names combine into Discord decimal strings',async()=>{
  const api=discordApi({} as Client) as Record<string,Record<string,HostFunction>>;
  assert.equal(await api.permissions!.of!.call('view_channel','read_message_history'),'66560');
  assert.equal(await api.permissions!.of!.call('view_channel','view_channel'),'1024');
  await assert.rejects(async()=>api.permissions!.of!.call('not_a_permission'),/Unknown Discord permission/);
});

test('Discord failures expose status and API code to Wisp catch blocks',async()=>{
  const client={rest:{request:async()=>{throw {status:403,code:50013};}}} as unknown as Client;
  const script=parse('try:\n    discord.channels.create("42", {"name": "private"})\ncatch error:\n    reply "{error.status}:{error.code}:{error.wispCode}:{error.message}"\n');
  const replies:string[]=[];
  await execute(script.statements,{values:{discord:discordApi(client)},reply:async body=>{replies.push(body.content!);}});
  assert.deepEqual(replies,['403:50013:DISCORD005:Discord API request failed (HTTP 403)']);
});

test('Discord bridge rejects URLs, invalid routes, and invalid query values',async()=>{
  const client={rest:{request:async()=>null}} as unknown as Client;
  const call=(...args:Value[])=>((discordApi(client) as Record<string,HostFunction>).request!.call(...args));
  await assert.rejects(async()=>call('GET','https://example.com'),/path/);
  await assert.rejects(async()=>call('GET','/api/v10/users/@me'),/versioned API path/);
  await assert.rejects(async()=>call('GET','/users/@me',null,{limit:[{}]}),/Query values/);
  assert.equal(await call('GET','/users/@me'),null);
});

test('interaction and webhook token routes omit bot authorization',async()=>{
  let request:Record<string,unknown>|undefined;
  const client={rest:{request:async(value:Record<string,unknown>)=>{request=value;return null;}}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  await api.request!.call('POST','/interactions/123/abc/callback',{type:4,data:{content:'Hi'}});
  assert.equal(request?.auth,false);
  await api.request!.call('GET','/gateway/bot');
  assert.equal(request?.auth,undefined);
});

test('multipart uploads read project files and reject traversal',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-upload-'));
  try{
    writeFileSync(join(root,'sample.txt'),'hello');
    let request:Record<string,unknown>|undefined;
    const client={rest:{request:async(value:Record<string,unknown>)=>{request=value;return {id:'1'};}}} as unknown as Client;
    const api=discordApi(client,root) as Record<string,HostFunction>;
    await api.request!.call('POST','/channels/42/messages',{content:'Hi'},null,null,['sample.txt']);
    const files=request?.files as {name:string;data:Buffer}[];
    assert.equal(files[0]?.name,'sample.txt');
    assert.equal(files[0]?.data.toString(),'hello');
    await api.sticker!.call('42','Fox','sample.txt',{description:'A fox',tags:'fox'});
    const stickerFiles=request?.files as {name:string;data:Buffer;key:string}[];
    assert.equal(request?.fullRoute,'/guilds/42/stickers');
    assert.equal(request?.appendToFormData,true);
    assert.equal(stickerFiles[0]?.key,'file');
    assert.deepEqual(request?.body,{name:'Fox',description:'A fox',tags:'fox'});
    await assert.rejects(async()=>api.request!.call('POST','/channels/42/messages',null,null,null,['../outside.txt']),/unavailable|escapes/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Gateway bridge sends bot event opcodes to a selected shard',async()=>{
  let packet:unknown;
  const client={ws:{shards:new Map([[2,{send:(value:unknown)=>{packet=value;}}]])}} as unknown as Client;
  const api=discordApi(client) as Record<string,HostFunction>;
  assert.equal(await api.gateway!.call(3,{status:'online'},2),null);
  assert.deepEqual(packet,{op:3,d:{status:'online'}});
  await assert.rejects(async()=>api.gateway!.call(2,{},2),/opcode/);
  await assert.rejects(async()=>api.gateway!.call(3,{},0),/unavailable/);
});

test('raw Gateway handlers parse and receive an event payload',async()=>{
  const script=parse('on gateway "MESSAGE_REACTION_ADD":\n    log.info(event.data.message_id)\n');
  assert.equal(script.events[0]?.name,'gateway:MESSAGE_REACTION_ADD');
  const seen:string[]=[];
  await execute(script.events[0]!.body,{values:{event:record({data:record({message_id:'42'})}) as Value,log:record({info:host(value=>{seen.push(String(value));return null;})}) as Value}});
  assert.deepEqual(seen,['42']);
});

test('all named Discord Gateway intents are distinct',()=>{
  assert.equal(discordIntents.length,21);
  assert.equal(new Set(discordIntents).size,discordIntents.length);
});
