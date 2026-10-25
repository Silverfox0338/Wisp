import {existsSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=realpathSync(dirname(fileURLToPath(import.meta.url)));
const target=resolve(root,'dist');
const rel=relative(root,target);
if(rel!=='dist'||isAbsolute(rel))throw new Error('Unexpected build directory');
if(existsSync(target)){
  if(lstatSync(target).isSymbolicLink())throw new Error('Build directory must not be a symlink');
  const actual=realpathSync(target),actualRel=relative(root,actual);
  if(actualRel!=='dist'||isAbsolute(actualRel))throw new Error('Build directory escapes project');
  rmSync(target,{recursive:true,force:true});
}
const compiler=resolve(root,'node_modules','typescript','bin','tsc');
if(!existsSync(compiler))throw new Error('TypeScript is required to pack Wisp; run npm ci first');
const result=spawnSync(process.execPath,[compiler,'-p','tsconfig.json'],{cwd:root,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
