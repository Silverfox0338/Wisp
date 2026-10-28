import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Client} from 'discord.js';
import {parse} from '../compiler/parser.js';
import {analyze} from '../editor/service.js';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {shardReport} from '../cli/doctor.js';
import {discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';
import {discordApi,type GatewayPacket} from '../discord/api.js';
import {FATAL_EXIT,ShardLink,ShardManager,shardForGuild,shardGroups,workerInfo,type LinkMessage} from '../discord/shards.js';
import type {HostFunction} from '../runtime/interpreter.js';

function withProject(run:(root:string)=>Promise<void>|void):Promise<void>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-010-'));
  return Promise.resolve().then(()=>run(initProject('sharded',dir))).finally(()=>rmSync(dir,{recursive:true,force:true}));
}
const editManifest=(root:string,change:(manifest:Record<string,any>)=>void)=>{const path=join(root,'wisp.json'),manifest=JSON.parse(readFileSync(path,'utf8')) as Record<string,any>;change(manifest);writeFileSync(path,JSON.stringify(manifest));};

test('wisp.json accepts shards and processes and explains bad values',()=>withProject(root=>{
  const project=loadProject(root);
  assert.equal(project.manifest.discord.shards,'auto');
  assert.equal(project.manifest.discord.processes,1);
  assert.equal(project.manifest.runtime,'>=0.1.0 <0.2.0');
  editManifest(root,m=>{m.runtime='>=0.0.10 <0.0.11';});
  assert.equal(loadProject(root).manifest.runtime,'>=0.0.10 <0.0.11');
  editManifest(root,m=>{m.discord.shards=4;});
  assert.equal(loadProject(root).manifest.discord.shards,4);
  for(const [shards,pattern] of [[0,/"auto" or a whole number/],[2.5,/"auto" or a whole number/],['many',/"auto" or a whole number/]] as const){
    editManifest(root,m=>{m.discord.shards=shards;});assert.throws(()=>loadProject(root),pattern);
  }
  editManifest(root,m=>{m.discord.shards=2;m.discord.processes=3;});
  assert.throws(()=>loadProject(root),/processes \(3\) can't be more than discord.shards \(2\)/);
  editManifest(root,m=>{m.discord.shards=4;m.discord.processes=2;});
  assert.throws(()=>loadProject(root),/needs PostgreSQL, MySQL, or Redis storage; SQLite allows one process/);
  editManifest(root,m=>{m.runtime='>=0.0.9 <0.0.10';m.discord.processes=1;});
  assert.equal(loadProject(root).manifest.runtime,'>=0.0.9 <0.0.10');
}));

test('shards split into contiguous groups, one per process',()=>{
  assert.deepEqual(shardGroups(4,2),[[0,1],[2,3]]);
  assert.deepEqual(shardGroups(5,2),[[0,1,2],[3,4]]);
  assert.deepEqual(shardGroups(3,3),[[0],[1],[2]]);
  assert.throws(()=>shardGroups(2,3),/can't be more than shards/);
  assert.deepEqual(workerInfo({WISP_PROCESS:'1',WISP_SHARD_GROUPS:'[[0,1],[2]]'}),{index:1,groups:[[0,1],[2]],shards:[2],count:3});
  assert.equal(workerInfo({}),null);
  assert.throws(()=>workerInfo({WISP_PROCESS:'3',WISP_SHARD_GROUPS:'[[0]]'}),/wisp run/);
});

test('guilds map to shards with Discord\'s formula',()=>{
  const id='81384788765712384';
  for(const count of [1,2,7])assert.equal(shardForGuild(id,count),Number((BigInt(id)>>22n)%BigInt(count)));
  assert.equal(shardForGuild(id,1),0);
  assert.throws(()=>shardForGuild('abc',2),/snowflake/);
});

function fakeClient(ids:number[],count:number){
  const sent:{shard:number;packet:unknown}[]=[];
  const shards=new Map(ids.map(id=>[id,{send:(packet:unknown)=>{sent.push({shard:id,packet});}}]));
  return {client:{ws:{shards},options:{shardCount:count}} as unknown as Client,sent};
}

test('discord.gateway picks the guild\'s shard and sends presence to every shard',async()=>{
  const {client,sent}=fakeClient([0,1],2);
  const gateway=(discordApi(client) as Record<string,HostFunction>).gateway!;
  const guild='81384788765712384',target=shardForGuild(guild,2);
  await gateway.call(8,{guild_id:guild,query:'',limit:0});
  assert.deepEqual(sent.pop(),{shard:target,packet:{op:8,d:{guild_id:guild,query:'',limit:0}}});
  await gateway.call(3,{status:'online',since:null,activities:[],afk:false});
  assert.deepEqual(sent.splice(0).map(item=>item.shard).sort(),[0,1]);
  await gateway.call(31,{guild_ids:['0','4194304']});
  assert.deepEqual(sent.splice(0).map(item=>[item.shard,(item.packet as {d:{guild_ids:string[]}}).d.guild_ids]),[[0,['0']],[1,['4194304']]]);
  await assert.rejects(async()=>gateway.call(8,{query:''}),/needs data.guild_id to pick a shard, or pass a shard ID/);
  await gateway.call(4,{guild_id:'0',channel_id:null},1);
  assert.equal(sent.pop()!.shard,1);
});

test('discord.gateway reaches shards in other processes',async()=>{
  const {client,sent}=fakeClient([0],2);const remote:{shard?:number;packet:GatewayPacket}[]=[];
  const gateway=(discordApi(client,undefined,undefined,{count:()=>2,send:async(shard,packet)=>{remote.push({shard,packet});},broadcast:async packet=>{remote.push({packet});}}) as Record<string,HostFunction>).gateway!;
  await gateway.call(8,{guild_id:'4194304'});
  assert.deepEqual(remote.pop(),{shard:1,packet:{op:8,d:{guild_id:'4194304'}}});
  await gateway.call(3,{status:'idle'});
  assert.equal(sent.length,1);assert.deepEqual(remote.pop(),{packet:{op:3,d:{status:'idle'}}});
  await assert.rejects(async()=>gateway.call(8,{guild_id:'1'},5),/shard 5 is unavailable/);
});

/** Links for several fake workers, wired together the way the manager routes messages. */
function linkedWorkers(groups:number[][],silent:number[]=[]):ShardLink[]{
  const links:ShardLink[]=[];
  const route=(message:LinkMessage)=>{queueMicrotask(()=>{if(message.wisp==='call'&&!silent.includes(message.to))void links[message.to]!.receive(message);else if(message.wisp==='reply')void links[message.to]!.receive(message);});};
  groups.forEach((shards,index)=>links.push(new ShardLink({index,groups,shards,count:groups.flat().length},route)));
  return links;
}

test('workers call each other through the link, with errors and timeouts',async()=>{
  const [first,second,third]=linkedWorkers([[0],[1],[2]],[2]);
  second!.handle('double',value=>Number(value)*2);
  second!.handle('fail',()=>{throw new Error('secret detail');});
  assert.equal(await first!.call(1,'double',21),42);
  await assert.rejects(first!.call(1,'fail',null),/Shard operation failed/);
  await assert.rejects(first!.call(1,'missing',null),/Unknown shard operation missing/);
  await assert.rejects(first!.call(2,'double',1,50),/Process 2 did not answer/);
  first!.handle('double',value=>Number(value)*2);third!.handle('double',value=>Number(value)*2);
  const results=await first!.callAll('double',5,50);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled','rejected']);
  assert.equal(first!.workerFor(2),2);assert.equal(first!.primary,true);assert.equal(second!.primary,false);
  let ready=0;first!.onAllReady(()=>{ready++;});await first!.receive({wisp:'all-ready'});assert.equal(ready,1);
});

const stub=`import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const dir=process.env.STUB_DIR,index=process.env.WISP_PROCESS;
appendFileSync(dir+'/starts.log',index+'\\n');
if(process.env.STUB_FATAL)process.exit(${FATAL_EXIT});
process.on('message',message=>{
  if(message.wisp==='all-ready'){appendFileSync(dir+'/ready.log',index+'\\n');process.send({wisp:'call',id:1,from:0,to:1,op:'ping',payload:null});}
  if(message.wisp==='reply')appendFileSync(dir+'/reply.log',JSON.stringify(message.result)+'\\n');
  if(message.wisp==='call'){process.send({wisp:'reply',id:message.id,to:message.from,ok:true,result:'pong from '+index});if(!existsSync(dir+'/crashed')){writeFileSync(dir+'/crashed','');setTimeout(()=>process.exit(1),20);}}
  if(message.wisp==='stop')process.disconnect();
});
process.send({wisp:'ready'});
`;
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('Timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
const lines=(path:string)=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n'):[];

test('the manager starts workers in order, routes calls, and restarts a crashed worker',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-manager-')),entry=join(dir,'worker.mjs');writeFileSync(entry,stub);
  process.env.STUB_DIR=dir;const logs:string[]=[];
  const manager=new ShardManager({groups:[[0,1],[2,3]],entry,log:(_level,message)=>logs.push(message),restartDelayMs:20});
  try{
    await manager.start();
    await until(()=>lines(join(dir,'reply.log')).length>0&&lines(join(dir,'starts.log')).length>=3);
    assert.deepEqual(lines(join(dir,'starts.log')),['0','1','1']);
    assert.deepEqual(lines(join(dir,'ready.log')),['0']);
    assert.deepEqual(lines(join(dir,'reply.log')),['"pong from 1"']);
    assert.ok(logs.some(line=>/process 1 \(shards 2-3\) exited with code 1; restarting/.test(line)));
  }finally{await manager.stop();delete process.env.STUB_DIR;rmSync(dir,{recursive:true,force:true});}
});

test('the manager stops when a worker can\'t start',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-manager-')),entry=join(dir,'worker.mjs');writeFileSync(entry,stub);
  process.env.STUB_DIR=dir;process.env.STUB_FATAL='1';
  const manager=new ShardManager({groups:[[0],[1]],entry,log:()=>{}});
  try{
    await assert.rejects(manager.start(),/process 0 \(shard 0\) could not start/);
    await manager.done;
    assert.deepEqual(lines(join(dir,'starts.log')),['0']);
  }finally{delete process.env.STUB_DIR;delete process.env.STUB_FATAL;rmSync(dir,{recursive:true,force:true});}
});

test('shard events parse, and a typo suggests the right name',()=>{
  for(const name of ['shard_ready','shard_disconnect','shard_reconnecting','shard_resume'])
    assert.equal(parse(`on ${name}:\n    log.info("shard {event.shard}")\n`).events[0]!.name,name);
  assert.throws(()=>parse('on shard_redy:\n    log.info("x")\n'),/did you mean shard_ready\?/);
  assert.deepEqual(analyze('on shard_disconnect:\n    log.warn("shard {event.shard} closed with {event.code}")\n\ncommand "status":\n    description "Status"\n    execute:\n        let shards = bot.shards()\n        reply "{len(shards)} shards, this server is on {guild.shard}"\n','status.wisp').diagnostics,[]);
});

test('wisp test has bot.shards, mock.shards, guild.shard, and shard events',()=>withProject(async root=>{
  writeFileSync(join(root,'commands','status.wisp'),'command "status":\n    description "Shard status"\n    execute:\n        let lines = []\n        for shard in bot.shards():\n            lines.append("{shard.id}: {shard.status}")\n        let text = lines.join(", ")\n        reply "{text} (here: {guild.shard})"\n');
  writeFileSync(join(root,'events','shards.wisp'),'on shard_disconnect:\n    storage.sharedSet("last_drop", event.shard)\n');
  writeFileSync(join(root,'tests','shards.test.wisp'),'assert.equal(mock.run("status")[0].content, "0: ready (here: 0)")\nmock.shards([{"id": 0, "status": "ready"}, {"id": 1, "status": "resuming"}])\nassert.ok(mock.run("status")[0].content.starts_with("0: ready, 1: resuming"))\nmock.runEvent("shard_disconnect", {"shard": 1, "code": 4000})\nassert.equal(storage.sharedGet("last_drop"), 1)\n');
  editManifest(root,m=>{m.discord.commands.guild_id='81384788765712384';});
  const project=loadProject(root);
  assert.equal(await runWispTests(project,discover(project)),2);
}));

test('wisp doctor compares sharding with Discord\'s recommendation',()=>withProject(root=>{
  const gateway=(shards:number,remaining=1000)=>({shards,session_start_limit:{total:1000,remaining,reset_after:3600000,max_concurrency:1}});
  const project=loadProject(root);
  const fine=shardReport(project,gateway(1));
  assert.equal(fine.line,'Sharding: Discord recommends 1 shard; using auto (1) in 1 process; 1000 of 1000 sessions left today');
  assert.deepEqual(fine.warnings,[]);
  project.manifest.discord.shards=2;
  assert.match(shardReport(project,gateway(4)).warnings[0]!,/raise it/);
  assert.match(shardReport(project,gateway(6)).warnings[0]!,/Discord will refuse to connect/);
  project.manifest.discord.shards='auto';project.manifest.discord.processes=3;
  assert.match(shardReport(project,gateway(2)).warnings[0]!,/wisp run will refuse to start/);
  project.manifest.discord.processes=1;
  assert.match(shardReport(project,gateway(1,3)).warnings[0]!,/Only 3 of 1000 Discord sessions are left today/);
}));

test('commands and events load from subfolders', ()=>withProject(root=>{
  mkdirSync(join(root,'commands','economy','shop'),{recursive:true});mkdirSync(join(root,'events','members'));mkdirSync(join(root,'commands','.drafts'));
  writeFileSync(join(root,'commands','economy','daily.wisp'),'command "daily":\n    description "Collect coins"\n    execute:\n        reply "ok"\n');
  writeFileSync(join(root,'commands','economy','shop','buy.wisp'),'command "buy":\n    description "Buy an item"\n    execute:\n        reply "ok"\n');
  writeFileSync(join(root,'commands','.drafts','broken.wisp'),'not wisp at all');
  writeFileSync(join(root,'events','members','welcome.wisp'),'on member_join:\n    log.info("hi")\n');
  const compiled=discover(loadProject(root),false);
  assert.deepEqual(compiled.commands.map(x=>x.name).sort(),['buy','daily','ping']);
  assert.ok(compiled.events.some(x=>x.name==='member_join'));
  writeFileSync(join(root,'commands','economy','twice.wisp'),'command "daily":\n    description "Again"\n    execute:\n        reply "ok"\n');
  assert.throws(()=>discover(loadProject(root),false),/[Dd]uplicate/);
}));

test('discord.transcript pages through history and builds HTML or text',async()=>{
  const history=Array.from({length:150},(_,i)=>({id:String(1000+i),content:i===149?'hi <@42> <b>':`message ${i}`,timestamp:new Date(Date.UTC(2026,9,27,14,0,i)).toISOString(),author:{username:i%2?'kuro':'helper',global_name:i%2?'Kuro':null,bot:i%2===0},mentions:i===149?[{id:'42',username:'mod',global_name:'Mod'}]:[],attachments:i===0?[{filename:'log.txt',url:'https://cdn.discordapp.com/x/log.txt'}]:[],embeds:i===1?[{title:'Rules',description:'Be kind'}]:[]}));
  const requests:Record<string,string>[]=[];
  const client={rest:{request:async(input:{fullRoute:string;query?:URLSearchParams})=>{
    if(!input.fullRoute.endsWith('/messages'))throw Object.assign(new Error('Missing Access'),{status:403,code:50001});
    const query=Object.fromEntries(input.query??[]);requests.push(query);
    const newest=[...history].reverse(),start=query.before?newest.findIndex(message=>message.id===query.before)+1:0;
    return newest.slice(start,start+Number(query.limit));
  }}} as unknown as Client;
  const transcript=(discordApi(client,undefined,undefined,undefined,{fetchImage:null}) as Record<string,HostFunction>).transcript!;
  const html=await transcript.call('111111111111111111') as Record<string,unknown>;
  assert.equal(html.messages,150);
  assert.equal(html.name,'transcript-111111111111111111.html');
  assert.deepEqual(requests.map(query=>query.before??null),[null,'1050']);
  const page=String(html.text);
  assert.ok(page.startsWith('<!doctype html>'));
  assert.ok(page.indexOf('message 0')<page.indexOf('message 148'));
  assert.match(page,/hi <span class="mention">@Mod<\/span> &lt;b&gt;/);
  assert.match(page,/<a class="file" href="https:\/\/cdn\.discordapp\.com\/x\/log\.txt"[^>]*>.*<span class="file-name">log\.txt<\/span>/);
  assert.match(page,/<div class="e-title">Rules<\/div><div class="e-desc">Be kind<\/div>/);
  const text=await transcript.call('111111111111111111',{format:'text',limit:2,name:'ticket.txt'}) as Record<string,unknown>;
  assert.equal(text.name,'ticket.txt');
  assert.equal(text.messages,2);
  assert.match(String(text.text),/\] helper \[bot\]: message 148\n/);
  assert.match(String(text.text),/\] Kuro: hi @Mod <b>\n/);
  await assert.rejects(async()=>transcript.call('111111111111111111',{format:'pdf'}),/"html" or "text"/);
  await assert.rejects(async()=>transcript.call('111111111111111111',{color:'red'}),/Unknown transcript setting color/);
});

test('scripts write files and send transcripts from memory or from the files folder',()=>withProject(async root=>{
  const script=[
    'mock.respond("GET", "/channels/111111111111111111/messages", [{"id": "5", "content": "bye", "timestamp": "2026-10-27T14:00:00Z", "author": {"username": "kuro"}}])',
    'let t = discord.transcript("111111111111111111", {"format": "text"})',
    'assert.equal(t.messages, 1)',
    'assert.ok(t.text.contains("kuro: bye"))',
    'mock.clear()',
    'mock.respond("POST", "/channels/222222222222222222/messages", {"id": "9"})',
    'discord.send("222222222222222222", "Ticket closed", {}, [t])',
    'assert.equal(mock.calls()[0].files[0].name, "transcript-111111111111111111.txt")',
    'assert.ok(mock.calls()[0].files[0].text.contains("kuro: bye"))',
    'let path = files.write("transcripts/{t.name}", t.text)',
    'assert.equal(path, "files/transcripts/transcript-111111111111111111.txt")',
    'mock.respond("POST", "/channels/222222222222222222/messages", {"id": "10"})',
    'discord.send("222222222222222222", "Saved copy", {}, [path])',
    'assert.ok(mock.calls()[1].files[0].text.contains("kuro: bye"))',
    'files.append("log.txt", "one\\n")',
    'files.append("log.txt", "two\\n")',
    'assert.equal(files.read("log.txt"), "one\\ntwo\\n")',
    'assert.equal(files.read("missing.txt"), null)',
    'assert.equal(files.list(), ["log.txt", "transcripts/transcript-111111111111111111.txt"])',
    'assert.equal(files.list("transcripts"), ["transcripts/transcript-111111111111111111.txt"])',
    'assert.ok(files.delete("log.txt"))',
    'assert.ok(not files.exists("log.txt"))',
    'let blocked = 0',
    'for bad in ["../escape.txt", "evil.wisp", "/abs.txt"]:',
    '    try:',
    '        files.write(bad, "x")',
    '    catch error:',
    '        blocked += 1',
    'assert.equal(blocked, 3)',
    ''
  ].join('\n');
  writeFileSync(join(root,'tests','files.test.wisp'),script);
  const project=loadProject(root);
  assert.equal(await runWispTests(project,discover(project)),2);
  assert.equal(existsSync(join(root,'files')),false);
}));

test('files.directory must be its own folder',()=>withProject(root=>{
  for(const directory of ['.','./data/files','./commands','./commands/files'])
    assert.throws(()=>{editManifest(root,m=>{m.files={directory};});loadProject(root);},/files.directory must be its own folder/);
  editManifest(root,m=>{m.files={directory:'./storage/files'};});
  assert.match(loadProject(root).paths.files.replaceAll('\\','/'),/storage\/files$/);
}));
