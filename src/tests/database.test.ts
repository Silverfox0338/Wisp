import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initProject} from '../cli/scaffold.js';
import {loadProject} from '../project/manifest.js';
import {sqlParameters} from '../storage/external.js';
import {runWispTests} from '../cli/test-runner.js';
import {discover} from '../project/discovery.js';
import {analyze,completion} from '../editor/service.js';

test('PostgreSQL placeholders skip literals, identifiers and comments',()=>{
  const source="SELECT '?' AS literal, \"?\" AS ident, $$?$$ AS dollar, value FROM things WHERE id = ? AND flags ?? 'active' /* ? */ -- ?\n AND label = ?";
  assert.deepEqual(sqlParameters(source,'postgres'),{text:source.replace('id = ?','id = $1').replace("flags ?? 'active'","flags ? 'active'").replace('label = ?','label = $2'),count:2});
  assert.equal(sqlParameters('SELECT ?','mysql').count,1);
  assert.equal(sqlParameters("SELECT E'it\\'s ?' WHERE id = ?",'postgres').count,1);
  assert.equal(sqlParameters("SELECT 'it\\'s ?' WHERE id = ?",'mysql').count,1);
  assert.throws(()=>sqlParameters('SELECT 1; SELECT 2','postgres'),/one SQL statement/);
});

test('manifest validates named databases and storage connections',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-db-config-'));
  try{const root=initProject('database-bot',dir),path=join(root,'wisp.json');const manifest=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
    manifest.databases={main:{engine:'postgres',url:'${TEST_DATABASE_URL}'},cache:{engine:'redis',url:'${TEST_REDIS_URL}'}};
    manifest.storage={connection:'main'};writeFileSync(path,JSON.stringify(manifest));
    const project=loadProject(root);assert.equal(project.manifest.databases?.main?.engine,'postgres');assert.deepEqual(project.manifest.storage,{connection:'main'});
    assert.deepEqual(completion(analyze('db.',join(root,'commands','query.wisp')),{line:0,character:3}).map(item=>item.label).sort(),['cache','main']);
    assert.ok(completion(analyze('db.main.',join(root,'commands','query.wisp')),{line:0,character:8}).some(item=>item.label==='sql'));
    assert.throws(()=>loadProject(root,false,true),/Missing environment variable TEST_DATABASE_URL/);
    manifest.storage={connection:'missing'};writeFileSync(path,JSON.stringify(manifest));assert.throws(()=>loadProject(root),/Unknown storage connection/);
    manifest.storage={engine:'sqlite',path:'./data/bot.db'};manifest.databases={main:{engine:'postgres',url:'postgres://user:secret@host/db'}};writeFileSync(path,JSON.stringify(manifest));assert.throws(()=>loadProject(root),/environment reference/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('offline Wisp tests mock named database operations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wisp-db-mock-'));
  try{const root=initProject('database-bot',dir),path=join(root,'wisp.json');const manifest=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
    manifest.databases={main:{engine:'mysql',url:'${TEST_MYSQL_URL}'},cache:{engine:'redis',url:'${TEST_REDIS_URL}'}};writeFileSync(path,JSON.stringify(manifest));
    writeFileSync(join(root,'tests','database.test.wisp'),'mock.dbRespond("main", "sql", {"rows": [{"value": 42}], "affected": 1})\nlet result = db.main.sql("SELECT ? AS value", [42])\nassert.equal(result.rows[0].value, 42)\nmock.dbRespond("cache", "get", "cached")\nassert.equal(db.cache.get("key"), "cached")\nassert.equal(len(mock.dbCalls()), 2)\n');
    const project=loadProject(root);assert.equal(await runWispTests(project,discover(project)),2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
