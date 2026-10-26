import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SqlDatabase,RedisDatabase} from '../storage/external.js';
import {Storage} from '../storage/sqlite.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for(const [engine,variable] of [['postgres','WISP_TEST_POSTGRES_URL'],['mysql','WISP_TEST_MYSQL_URL']] as const){
  test(`${engine} live adapter persists state and returns SQL rows`,{skip:!process.env[variable]},async()=>{
    const url=process.env[variable]!,scope=`integration:${Date.now()}:${Math.random()}`;let db=new SqlDatabase(engine,url);
    try{await db.connect();await db.initialize();const result=await db.sql('SELECT ? AS answer',[42]);assert.equal(String(result.rows[0]?.answer),'42');assert.equal(result.affected,1);
      await db.set(scope,'value',{ok:true});await db.close();db=new SqlDatabase(engine,url);await db.connect();assert.deepEqual(await db.get(scope,'value'),{ok:true});
      assert.deepEqual(await Promise.all(Array.from({length:8},()=>db.increment(scope,'counter'))).then(values=>values.sort((a,b)=>a-b)),[1,2,3,4,5,6,7,8]);
      const id=`ss:${Math.random().toString(16).slice(2).padEnd(32,'0').slice(0,32)}`;
      await db.putComponent({id,kind:'button',name:'test',guildId:'guild',ownerId:null,expiresAt:Date.now()+60000,state:{count:1}});
      assert.equal((await db.getComponent(id))?.state.count,1);await db.saveRoster(scope,[{id:'1',joinedAt:'2024-01-01T00:00:00Z'}]);
      assert.equal((await db.sql('SELECT guild_id FROM wisp_rosters WHERE guild_id = ?',[scope])).rows.length,1);
      await db.sql('DELETE FROM wisp_components WHERE id = ?',[id]);await db.sql('DELETE FROM wisp_rosters WHERE guild_id = ?',[scope]);await db.delete(scope,'value');await db.delete(scope,'counter');
    }finally{await db.close().catch(()=>{});}
  });
}

for(const [engine,variable] of [['postgres','WISP_TEST_POSTGRES_MIGRATION_URL'],['mysql','WISP_TEST_MYSQL_MIGRATION_URL']] as const){
  test(`${engine} live SQLite migration copies all Wisp data`,{skip:!process.env[variable]},async()=>{
    const dir=mkdtempSync(join(tmpdir(),'wisp-sql-migrate-')),source=new Storage(join(dir,'source.db')),target=new SqlDatabase(engine,process.env[variable]!);
    try{source.set('shared','migrated',42);source.putComponent({id:'ss:'+'b'.repeat(32),kind:'button',name:'old',guildId:'guild',ownerId:null,expiresAt:0,state:{ok:true}});source.saveRoster('guild',[{id:'1',joinedAt:'2024-01-01T00:00:00Z'}]);
      await target.connect();await target.initialize();await target.restore(source.snapshot());assert.equal(await target.get('shared','migrated'),42);assert.equal((await target.getComponent('ss:'+'b'.repeat(32)))?.state.ok,true);
      assert.equal((await target.sql('SELECT guild_id FROM wisp_rosters WHERE guild_id = ?',['guild'])).rows.length,1);await assert.rejects(()=>target.restore(source.snapshot()),/must be empty/);
    }finally{source.close();await target.close().catch(()=>{});rmSync(dir,{recursive:true,force:true});}
  });
}

test('Redis live adapter supports TTL, counters, component persistence, and migration',{skip:!process.env.WISP_TEST_REDIS_URL},async()=>{
  const name=`integration:${Date.now()}:${Math.random()}`,db=new RedisDatabase(process.env.WISP_TEST_REDIS_URL!,name),dir=mkdtempSync(join(tmpdir(),'wisp-redis-migrate-'));
  try{await db.connect();await db.userSet('ttl',{ok:true},2);assert.deepEqual(await db.userGet('ttl'),{ok:true});assert.equal(await db.userHas('ttl'),true);
    assert.deepEqual(await Promise.all(Array.from({length:8},()=>db.userIncrement('counter'))).then(values=>values.sort((a,b)=>a-b)),[1,2,3,4,5,6,7,8]);
    await db.close();const source=new Storage(join(dir,'source.db'));source.set('shared','migrated',42);source.putComponent({id:'ss:'+'a'.repeat(32),kind:'button',name:'old',guildId:'guild',ownerId:null,expiresAt:0,state:{ok:true}});source.saveRoster('guild',[{id:'1',joinedAt:'2024-01-01T00:00:00Z'}]);const snapshot=source.snapshot();source.close();
    const target=new RedisDatabase(process.env.WISP_TEST_REDIS_URL!,`${name}:target`);try{await target.connect();await target.restore(snapshot);assert.equal(await target.get('shared','migrated'),42);assert.equal((await target.getComponent('ss:'+'a'.repeat(32)))?.name,'old');await assert.rejects(()=>target.restore(snapshot),/must be empty/);}finally{await target.close();}
  }finally{if(db.client.isOpen)await db.close();rmSync(dir,{recursive:true,force:true});}
});
