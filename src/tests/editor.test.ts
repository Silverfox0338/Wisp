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
