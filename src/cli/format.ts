import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {formatSource} from '../compiler/format.js';
import {WispError} from '../diagnostics.js';

const skipped=new Set(['node_modules','dist','data','.wisp','.git']);
function wispFiles(path:string,found:string[]):void{
  const stat=statSync(path);
  if(stat.isFile()){if(path.endsWith('.wisp'))found.push(path);return;}
  for(const entry of readdirSync(path,{withFileTypes:true})){if(skipped.has(entry.name))continue;const child=join(path,entry.name);if(entry.isDirectory())wispFiles(child,found);else if(entry.isFile()&&entry.name.endsWith('.wisp'))found.push(child);}
}

/** Formats .wisp files under paths (default: the current folder). With check, files are only reported, never written. */
export function formatFiles(paths:string[],cwd:string,check:boolean):{files:number;changed:string[];failed:{file:string;message:string}[]}{
  const files:string[]=[];
  for(const path of paths.length?paths:['.']){try{wispFiles(resolve(cwd,path),files);}catch{throw new WispError('CLI001',`Cannot read ${path}`);}}
  const changed:string[]=[],failed:{file:string;message:string}[]=[];
  for(const file of files){
    const source=readFileSync(file,'utf8');
    try{const formatted=formatSource(source,file).replace(/\n/g,source.includes('\r\n')?'\r\n':'\n');if(formatted===source)continue;changed.push(file);if(!check)writeFileSync(file,formatted,'utf8');}
    catch(error){failed.push({file,message:error instanceof WispError?error.message:String(error)});}
  }
  return {files:files.length,changed,failed};
}
