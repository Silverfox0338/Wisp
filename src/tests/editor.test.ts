import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze,completion,hover,references,signature,symbolAt} from '../editor/service.js';
import {apiMetadata} from '../runtime/api-metadata.js';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initProject} from '../cli/scaffold.js';

test('editor completion lists only published guild and storage APIs',()=>{
  const guild=completion(analyze('guild.','editor.wisp'),{line:0,character:6}).map(item=>item.label);
  assert.deepEqual(guild.sort(),Object.keys(apiMetadata.guild!).sort());
  assert.ok(!guild.includes('ban'));
  const storage=completion(analyze('storage.','editor.wisp'),{line:0,character:8}).map(item=>item.label);
  assert.deepEqual(storage.sort(),Object.keys(apiMetadata.storage!).sort());
  assert.match(hover(analyze('guild.joinRank','editor.wisp'),{line:0,character:9})??'',/joinRank/);
  assert.match(signature(analyze('guild.joinRank(','editor.wisp'),{line:0,character:15})?.signature??'',/member: Member/);
});

test('editor exposes nested Discord helpers',()=>{
  const discord=completion(analyze('discord.','editor.wisp'),{line:0,character:8}).map(item=>item.label);
  for(const name of ['send','editMessage','deleteMessage','dm','invite','nick','timeout','untimeout','channel','role','thread','react','ban','kick','poll','endPoll','voters','audit','guild','user','pins','pin','unpin','events','automod'])assert.ok(discord.includes(name));
  const channels=completion(analyze('discord.channels.','editor.wisp'),{line:0,character:17}).map(item=>item.label);
  assert.deepEqual(channels.sort(),Object.keys(apiMetadata.discordChannels!).sort());
  const messages=completion(analyze('discord.messages.','editor.wisp'),{line:0,character:17}).map(item=>item.label);
  assert.deepEqual(messages.sort(),Object.keys(apiMetadata.discordMessages!).sort());
  const threads=completion(analyze('discord.threads.','editor.wisp'),{line:0,character:16}).map(item=>item.label);
  assert.deepEqual(threads.sort(),Object.keys(apiMetadata.discordThreads!).sort());
  const events=completion(analyze('discord.events.','editor.wisp'),{line:0,character:15}).map(item=>item.label);
  assert.deepEqual(events.sort(),Object.keys(apiMetadata.discordEvents!).sort());
  const automod=completion(analyze('discord.automod.','editor.wisp'),{line:0,character:16}).map(item=>item.label);
  assert.deepEqual(automod.sort(),Object.keys(apiMetadata.discordAutomod!).sort());
  assert.match(hover(analyze('discord.roles.create','editor.wisp'),{line:0,character:15})??'',/Create a guild role/);
  assert.match(signature(analyze('discord.permissions.of(','editor.wisp'),{line:0,character:23})?.signature??'',/names: string/);
});

test('editor finds local definitions, references and semantic errors',()=>{
  const source='function greet(name):\n    return name\nlet result = greet("Fox")\nreply result\n';
  const analysis=analyze(source,'editor.wisp');assert.deepEqual(analysis.diagnostics,[]);
  const use=symbolAt(analysis,{line:2,character:14});assert.equal(use?.definition.name,'greet');assert.equal(use.definition.range.start.line,0);
  assert.equal(references(analysis,{line:0,character:10}).length,2);
  assert.ok(completion(analysis,{line:3,character:12}).some(item=>item.label==='result'));
  const invalid=analyze('reply absent\n','editor.wisp');assert.match(invalid.diagnostics[0]?.message??'',/Undefined name absent/);
  const syntax=analyze('if true\n    reply "x"\n','editor.wisp');assert.match(syntax.diagnostics[0]?.message??'',/Expected :/);
});

test('editor completion reads exported functions from a local Wisp module',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'wisp-editor-'));
  try{
    const project=initProject('sample',temporary),file=join(project,'commands','hello.wisp');
    mkdirSync(join(project,'utils'));
    writeFileSync(join(project,'utils','formatting.wisp'),'export function greet(name):\n    return name\nfunction hidden():\n    return null\n');
    const source='import "../utils/formatting.wisp"\nlet message = formatting.greet("Fox")\n';
    writeFileSync(file,source);
    const result=analyze(source,file);
    assert.equal(result.diagnostics.length,0);
    const line=source.split('\n').findIndex(text=>text.includes('formatting.greet'));
    const suggestions=completion(result,{line,character:source.split('\n')[line]!.indexOf('formatting.')+'formatting.'.length});
    assert.ok(suggestions.some(item=>item.label==='greet'&&item.kind==='function'));
    assert.ok(!suggestions.some(item=>item.label==='hidden'));
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('editor keeps command names apart from variables',()=>{
  const body='    description "Season info"\n    execute:\n        reply "hi"\n';
  for(const declaration of ['let season = 1\n','function season():\n    return 1\n'])
    assert.deepEqual(analyze(declaration+'command "season":\n'+body,'season.wisp').diagnostics,[]);
  assert.deepEqual(analyze('command "season":\n    description "x"\n    execute:\n        global season = 1\n        reply "hi"\n','season.wisp').diagnostics,[]);
  assert.deepEqual(analyze('command "season":\n'+body+'user command "season":\n    execute:\n        reply "hi"\n','season.wisp').diagnostics,[]);
  const twice=analyze('command "season":\n'+body+'command "season":\n'+body,'season.wisp').diagnostics;
  assert.deepEqual(twice.map(item=>[item.code,item.message]),[['EDITOR003','Duplicate command season']]);
});

test('editor lets a function call one defined below it',()=>{
  const helpers='function ensure_role(name):\n    return style_role(name)\n\nfunction style_role(name):\n    return name.upper()\n';
  assert.deepEqual(analyze(helpers+'command "role":\n    description "Role"\n    execute:\n        reply ensure_role("fox")\n','roles.wisp').diagnostics,[]);
  const early=analyze('let shout = loud("hi")\n\nfunction loud(text):\n    return text.upper()\n','early.wisp').diagnostics;
  assert.deepEqual(early.map(item=>item.code),['EDITOR001']);
});
