import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {initProject} from '../cli/scaffold.js';
import {loadProject} from '../project/manifest.js';
import {addPackage,removePackage,verifyPackages} from '../project/packages.js';

test('local packages pin version and integrity, detect tampering, and remove cleanly',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-pkg-'));try{
    const projectRoot=initProject('bot',root),source=join(root,'source');mkdirSync(source);
    writeFileSync(join(source,'wisp-package.json'),JSON.stringify({name:'formatters',version:'1.0.0'}));
    writeFileSync(join(source,'index.wisp'),'export function greet(name):\n    return "Hi, {name}"\n');
    assert.equal(addPackage(loadProject(projectRoot),source),'formatters');
    let project=loadProject(projectRoot);verifyPackages(project);
    assert.equal(project.manifest.packages?.formatters?.version,'1.0.0');
    assert.match(readFileSync(join(projectRoot,'wisp.json'),'utf8'),/sha256-/);
    writeFileSync(join(projectRoot,'packages','formatters','index.wisp'),'export let changed = true\n');
    assert.throws(()=>verifyPackages(project),/integrity/);
    removePackage(project,'formatters');project=loadProject(projectRoot);assert.equal(project.manifest.packages,undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('wisp package add, list, and remove work from a project directory',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-pkg-cli-'));try{
    const projectRoot=initProject('bot',root),source=join(root,'source');mkdirSync(source);
    writeFileSync(join(source,'wisp-package.json'),JSON.stringify({name:'helpers',version:'1.2.0'}));
    writeFileSync(join(source,'index.wisp'),'export let value = 1\n');
    const cli=resolve('dist/cli/index.js'),run=(...args:string[])=>spawnSync(process.execPath,[cli,...args],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(run('package','add',source).status,0);
    assert.match(run('package','list').stdout,/helpers 1\.2\.0 sha256-/);
    assert.equal(run('check').status,0);
    assert.equal(run('package','remove','helpers').status,0);
    assert.equal(run('package','list').stdout.trim(),'');
  }finally{rmSync(root,{recursive:true,force:true});}
});
