import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';

test('Wisp tests use fake Discord and temporary SQLite storage',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wisp-runner-'));
  try{
    const root=initProject('sample',temp);
    writeFileSync(join(root,'events','ready.wisp'),'event ready:\n    storage.sharedSet("event_ran", true)\n');
    const project=loadProject(root),compiled=discover(project);
    writeFileSync(join(root,'tests','error.test.wisp'),`mock.fail("GET", "/users/42", 404, 10013)
try:
    discord.user("42")
    assert.ok(false)
catch error:
    assert.equal(error.status, 404)
    assert.equal(error.code, 10013)
storage.sharedSet("temporary", true)
assert.equal(storage.sharedGet("temporary"), true)
let replies = mock.run("ping")
assert.equal(replies[0].content, "Pong!")
mock.runEvent("ready")
assert.equal(storage.sharedGet("event_ran"), true)
`);
    assert.equal(await runWispTests(project,compiled),2);
    assert.equal(await runWispTests(project,compiled,true),2);
    const reports=readdirSync(join(root,'.wisp','traces')).filter(name=>name.endsWith('.json'));
    assert.equal(reports.length,2);
    assert.match(readFileSync(join(root,'.wisp','traces',reports[0]!),'utf8'),/mock\.runEvent|mock\.run/);
    assert.equal(existsSync(project.paths.database),false);
    writeFileSync(join(root,'tests','error.test.wisp'),'assert.equal(1, 2)\n');
    const previous=console.error;
    console.error=()=>{};
    try{await assert.rejects(()=>runWispTests(project,compiled),/1 of 2 Wisp tests failed/);}
    finally{console.error=previous;}
    assert.equal(existsSync(project.paths.database),false);
  }finally{
    const rel=relative(tmpdir(),temp);
    if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(temp,{recursive:true,force:true});
  }
});
