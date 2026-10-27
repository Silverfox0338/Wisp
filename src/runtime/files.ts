import {appendFile,mkdir,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {WispError} from '../diagnostics.js';
import {host,record,type Value} from './interpreter.js';

export const maxFileBytes=8*1024*1024;
const maxListed=1000;
function fail(message:string):never{throw new WispError('FILES001',message);}
function text(value:Value,label:string):string{if(typeof value!=='string')fail(`${label} must be text`);return value;}
function cleanPath(value:Value):string{
  const raw=text(value,'File path').replaceAll('\\','/');
  if(!raw||raw.length>255||raw.includes('\0')||isAbsolute(raw)||/^[a-zA-Z]:/.test(raw))fail('File path must be a relative path of at most 255 characters, such as "notes/today.txt"');
  const parts=raw.split('/').filter(part=>part&&part!=='.');
  if(!parts.length||parts.includes('..'))fail(`File path ${raw} must stay inside the files folder`);
  return parts.join('/');
}
async function inside(root:string,target:string):Promise<void>{
  let existing=target;
  while(existing!==root&&!(await stat(existing).then(()=>true,()=>false)))existing=dirname(existing);
  const rel=relative(await realpath(root),await realpath(existing));
  if(rel.startsWith('..')||isAbsolute(rel))fail('File path must stay inside the files folder');
}

/** Text files under the project's files folder. Paths are relative to that folder; write and append return the project-relative path that discord.send accepts. */
export function filesApi(root:string,prefix:string):Value{
  const locate=async(value:Value,create=false):Promise<{path:string;target:string}>=>{
    const path=cleanPath(value),target=resolve(root,path);
    if(create)await mkdir(dirname(target),{recursive:true});else await mkdir(root,{recursive:true});
    await inside(root,target);
    return {path,target};
  };
  const writable=(path:string,content:Value,existing=0):string=>{
    if(path.endsWith('.wisp'))fail('Scripts can\'t write .wisp files');
    const body=text(content,'File content');
    if(existing+Buffer.byteLength(body)>maxFileBytes)fail(`${path} would be larger than 8 MiB`);
    return body;
  };
  const size=(target:string)=>stat(target).then(info=>info.isFile()?info.size:fail(`${relative(root,target)} is a folder`),()=>0);
  const shown=(path:string)=>`${prefix}/${path}`;
  return record({
    write:host(async(path,content)=>{const file=await locate(path,true),body=writable(file.path,content);await writeFile(file.target,body,'utf8');return shown(file.path);}),
    append:host(async(path,content)=>{const file=await locate(path,true),body=writable(file.path,content,await size(file.target));await appendFile(file.target,body,'utf8');return shown(file.path);}),
    read:host(async path=>{const file=await locate(path),info=await stat(file.target).catch(()=>null);if(!info)return null;if(!info.isFile())fail(`${file.path} is a folder`);if(info.size>maxFileBytes)fail(`${file.path} is larger than 8 MiB`);return readFile(file.target,'utf8');}),
    exists:host(async path=>{const file=await locate(path);return stat(file.target).then(info=>info.isFile(),()=>false);}),
    delete:host(async path=>{const file=await locate(path);if(!(await stat(file.target).then(info=>info.isFile(),()=>false)))return false;await rm(file.target);return true;}),
    list:host(async(folder='')=>{
      const base=folder===''?{path:'',target:root}:await locate(folder),found:string[]=[];
      const visit=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){if(found.length>=maxListed)return;const full=join(dir,entry.name);if(entry.isDirectory())await visit(full);else if(entry.isFile())found.push(relative(root,full).replaceAll('\\','/'));}};
      await mkdir(root,{recursive:true});await visit(base.target);
      return found.sort();
    })
  }) as Value;
}
