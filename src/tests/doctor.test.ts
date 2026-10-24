import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {doctorWarnings} from '../cli/doctor.js';
import {initProject} from '../cli/scaffold.js';
import {discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';

test('doctor warns about missing intent, shared secrets, mixed endings, and old Node',()=>{
  const temp=mkdtempSync(join(tmpdir(),'wisp-doctor-'));
  try{
    const root=initProject('bot-shared',temp);
    writeFileSync(join(root,'.env'),'DISCORD_TOKEN=test\n');
    writeFileSync(join(root,'events','member.wisp'),'event member_join:\r\n    log.info("joined")\n');
    const project=loadProject(root),compiled=discover(project,false);
    const warnings=doctorWarnings(project,compiled,'24.16.0').join('\n');
    assert.match(warnings,/24\.17/);
    assert.match(warnings,/guild_members/);
    assert.match(warnings,/\.env/);
    assert.match(warnings,/Mixed CRLF and LF/);
    project.manifest.discord.intents.push('guild_members');
    const enabled=doctorWarnings(project,compiled,'24.17.0').join('\n');
    assert.match(enabled,/Server Members Intent/);
    assert.doesNotMatch(enabled,/Member events need guild_members/);
    const traces=join(root,'.wisp','traces');mkdirSync(traces,{recursive:true});
    writeFileSync(join(traces,'recent.json'),JSON.stringify({label:'/slow',roots:[{durationMs:2500}]}));
    assert.match(doctorWarnings(project,compiled,'24.17.0').join('\n'),/Slow traced handler \/slow: 2500 ms/);
  }finally{
    const rel=relative(tmpdir(),temp);
    if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(temp,{recursive:true,force:true});
  }
});
