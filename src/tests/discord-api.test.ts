import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'discord.js';
import {discordApi} from '../discord/api.js';
import {parse} from '../compiler/parser.js';
import {execute,host,record,type HostFunction,type Value} from '../runtime/interpreter.js';
import {discordIntents} from '../project/manifest.js';
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
