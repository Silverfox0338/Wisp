import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {payload,diffCommands,sync,type CommandApi,type RemoteCommand} from '../discord/registry.js';
import {rankMembers,RankingService} from '../discord/ranking.js';
import type {Guild,GuildMember} from 'discord.js';
import {Storage} from '../storage/sqlite.js';
import {commandPermissions} from '../discord/permissions.js';
import {initProject} from '../cli/scaffold.js';
import {loadProject} from '../project/manifest.js';
import {discover} from '../project/discovery.js';
test('payload and diff preserve remote-only commands',()=>{const t=mkdtempSync(join(tmpdir(),'wisp-'));try{const cmd=discover(loadProject(initProject('x',t))).commands[0]!;const local=payload(cmd);assert.equal(local.type,1);assert.equal(local.name,'ping');const remote:RemoteCommand[]=[{...local,id:'1'},{...local,name:'other',id:'2'}];assert.deepEqual(diffCommands([local],remote).map(x=>x.kind),['remote','conflict']);assert.deepEqual(diffCommands([local],remote,['1','2']).map(x=>x.kind),['remove','same']);}finally{rmSync(t,{recursive:true,force:true});}});
test('remote metadata extras do not cause an unnecessary update',()=>{const t=mkdtempSync(join(tmpdir(),'wisp-'));try{const local=payload(discover(loadProject(initProject('x',t))).commands[0]!);const remote={...local,id:'1',version:'revision',options:[]};assert.equal(diffCommands([local],[remote],['1'])[0]?.kind,'same');}finally{rmSync(t,{recursive:true,force:true});}});
test('sync only deletes owned commands with prune',async()=>{const t=mkdtempSync(join(tmpdir(),'wisp-'));try{const p=loadProject(initProject('x',t));const cmd=payload(discover(p).commands[0]!);let remote:RemoteCommand[]=[{...cmd,name:'unrelated',id:'u'}];let deletes=0;const api:CommandApi={list:async()=>remote,create:async c=>{const r={...c,id:'p'};remote.push(r);return r;},update:async(id,c)=>({id,...c}),delete:async id=>{deletes++;remote=remote.filter(x=>x.id!==id);}};await sync(p,[cmd],api);assert.equal(deletes,0);await sync(p,[],api,false);assert.equal(deletes,0);await sync(p,[],api,true);assert.equal(deletes,1);assert.equal(remote[0]?.id,'u');}finally{rmSync(t,{recursive:true,force:true});}});

test('partial command sync reports how many local commands were confirmed',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wisp-sync-'));
  try{
    const project=loadProject(initProject('sample',temp));
    const first=payload(discover(project).commands[0]!);
    const second={...first,name:'second'};
    const api:CommandApi={list:async()=>[],create:async command=>{if(command.name==='second')throw new Error('request failed');return {...command,id:'42'};},update:async(id,command)=>({...command,id}),delete:async()=>{}};
    await assert.rejects(()=>sync(project,[first,second],api),/1\/2 local commands confirmed/);
  }finally{const rel=relative(tmpdir(),temp);if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(temp,{recursive:true,force:true});}
});
test('rank sorting uses joinedAt then ID and rejects missing data',()=>{const r=rankMembers([{id:'2',name:'B',joinedAt:'2024-01-01T00:00:00Z'},{id:'1',name:'A',joinedAt:'2024-01-01T00:00:00Z'}]);assert.deepEqual(r.map(x=>x.id),['1','2']);assert.deepEqual(r.map(x=>x.rank),[1,2]);assert.throws(()=>rankMembers([{id:'1',name:'A',joinedAt:null}]),/timestamp/);});
test('ranking service rejects partial roster and handles 10k members',async()=>{const t=mkdtempSync(join(tmpdir(),'wisp-rank-'));const db=new Storage(join(t,'data','bot.db'));try{const members=Array.from({length:10000},(_,i)=>({id:String(i+1).padStart(5,'0'),displayName:`Member ${i}`,joinedAt:new Date(1700000000000+i*1000)}));const guild={id:'g',memberCount:10001,members:{list:async({after}:{after?:string})=>{const start=after?members.findIndex(m=>m.id===after)+1:0;return new Map(members.slice(start,start+1000).map(m=>[m.id,m]));}}} as unknown as Guild;const service=new RankingService(db);await assert.rejects(()=>service.roster(guild),/Could not complete roster/);(guild as unknown as {memberCount:number}).memberCount=10000;assert.equal((await service.roster(guild)).length,10000);assert.equal(await service.joinRank(guild,'00001'),1);}finally{db.close();rmSync(t,{recursive:true,force:true});}});
test('ranking coalesces simultaneous fetches and invalidates changed scans',async()=>{const t=mkdtempSync(join(tmpdir(),'wisp-rank-')),db=new Storage(join(t,'data','bot.db'));try{let calls=0,release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const guild={id:'g',memberCount:1,members:{list:async()=>{calls++;await gate;return new Map([['1',{id:'1',displayName:'A',joinedAt:new Date('2024-01-01T00:00:00Z'),user:{bot:false}}]]);}}} as unknown as Guild;const service=new RankingService(db);const a=service.roster(guild),b=service.roster(guild);release();await Promise.all([a,b]);assert.equal(calls,1);service.invalidate('g');assert.equal((await service.roster(guild)).length,1);assert.equal(calls,2);}finally{db.close();rmSync(t,{recursive:true,force:true});}});
test('ranking pages and bot filtering preserve original ranks',async()=>{const t=mkdtempSync(join(tmpdir(),'wisp-page-')),db=new Storage(join(t,'data','bot.db'));try{const data=Array.from({length:50},(_,i)=>({id:String(i+1),displayName:`M${i}`,joinedAt:new Date(1700000000000+i*1000),user:{bot:i%2===0}}));const guild={id:'g',memberCount:50,members:{list:async()=>new Map(data.map(m=>[m.id,m]))}} as unknown as Guild;const service=new RankingService(db);const page=await service.page(guild,2,10,false);assert.equal(page.total,25);assert.equal(page.pages,3);assert.equal(page.members[0]?.rank,22);assert.equal(page.members[0]?.bot,false);}finally{db.close();rmSync(t,{recursive:true,force:true});}});
test('named permission becomes a stable Discord permission bitfield',()=>{const t=mkdtempSync(join(tmpdir(),'wisp-perm-'));try{const p=loadProject(initProject('x',t));const command=discover(p).commands[0]!;command.permission='manage_messages';assert.equal(payload(command).default_member_permissions,String(commandPermissions.manage_messages));}finally{rmSync(t,{recursive:true,force:true});}});
