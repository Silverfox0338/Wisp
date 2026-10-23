import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {execute} from '../runtime/interpreter.js';
import {compileModules,moduleResolver} from '../project/modules.js';

test('imports are namespaced, cached per invocation, and expose only exports',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-mod-'));try{
    mkdirSync(join(root,'utils'));
    const file=join(root,'commands.wisp'),utility=join(root,'utils','formatting.wisp');
    writeFileSync(utility,'let hidden = "secret"\nexport let prefix = "Hi"\nexport function greet(name):\n    return "{prefix}, {name}!"\n');
    const source='import "utils/formatting.wisp"\nimport "utils/formatting.wisp" as again\nreply formatting.greet("Fox")\n';
    const statements=parse(source,file).statements;
    const modules=compileModules(root,[{file,statements}]);
    assert.equal(modules.size,1);
    const replies:string[]=[];
    await execute(statements,{file,values:{},resolveImport:moduleResolver(root,modules,{values:{}}),reply:async body=>{replies.push(body.content!);}});
    assert.deepEqual(replies,['Hi, Fox!']);
    await assert.rejects(()=>execute(parse('import "utils/formatting.wisp"\nreply formatting.hidden\n',file).statements,{file,values:{},resolveImport:moduleResolver(root,modules,{values:{}}),reply:async()=>{}}),/Property hidden is unavailable/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('module compiler rejects circular, missing, and escaping imports',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-mod-'));try{
    const file=join(root,'main.wisp');writeFileSync(join(root,'a.wisp'),'import "b.wisp"\n');writeFileSync(join(root,'b.wisp'),'import "a.wisp"\n');
    assert.throws(()=>compileModules(root,[{file,statements:parse('import "a.wisp"\n',file).statements}]),/Circular import/);
    assert.throws(()=>compileModules(root,[{file,statements:parse('import "missing.wisp"\n',file).statements}]),/not found/);
    assert.throws(()=>compileModules(root,[{file,statements:parse('import "..\/outside.wisp"\n',file).statements}]),/escapes project root/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
