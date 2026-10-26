import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {TextDecoder} from 'node:util';
import {parse} from '../compiler/parser.js';
import type {Module,Stmt} from '../compiler/ast.js';
import {WispError} from '../diagnostics.js';
import {execute,record,type ExecutionBudget,type ExecutionContext,type Value} from '../runtime/interpreter.js';

export function resolveModulePath(root:string,from:string,source:string):string {
  if(!source.endsWith('.wisp')||isAbsolute(source))throw new WispError('MODULE001','Import must name a relative .wisp file',from);
  const path=resolve(dirname(from),source);
  const rel=relative(root,path);
  if(rel.startsWith('..')||isAbsolute(rel))throw new WispError('MODULE001',`Import escapes project root: ${source}`,from);
  if(!existsSync(path))throw new WispError('MODULE001',`Imported module not found: ${source}`,from);
  const real=realpathSync(path),realRel=relative(realpathSync(root),real);
  if(realRel.startsWith('..')||isAbsolute(realRel)||!statSync(real).isFile())throw new WispError('MODULE001',`Import resolves outside project root: ${source}`,from);
  return real;
}

function imports(statements:Stmt[]):Extract<Stmt,{kind:'import'}>[] {
  const found:Extract<Stmt,{kind:'import'}>[]=[];
  for(const stmt of statements){if(stmt.kind==='import')found.push(stmt);else if(stmt.kind==='function'||stmt.kind==='for'||stmt.kind==='while'||stmt.kind==='schedule')found.push(...imports(stmt.body));else if(stmt.kind==='if'){found.push(...imports(stmt.then));found.push(...imports(stmt.otherwise));}}
  return found;
}

export function compileModules(root:string,sources:{file:string;statements:Stmt[]}[]):Map<string,Module> {
  const compiled=new Map<string,Module>(),visiting:string[]=[];
  const visit=(from:string,source:string):void=>{
    const path=resolveModulePath(root,from,source);
    if(visiting.includes(path))throw new WispError('MODULE002',`Circular import: ${[...visiting,path].map(p=>relative(root,p)).join(' -> ')}`,from);
    if(compiled.has(path))return;
    if(statSync(path).size>1024*1024)throw new WispError('MODULE001','Module exceeds 1 MiB limit',path);
    let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path));}catch{throw new WispError('MODULE001','Module must be valid UTF-8',path);}
    const module=parse(content,path);
    if(module.commands.length||module.events.length||module.statements.some(s=>!['import','let','function'].includes(s.kind)))throw new WispError('MODULE001','Module may contain only imports, let declarations, and functions',path);
    visiting.push(path);
    for(const item of imports(module.statements))visit(path,item.source);
    visiting.pop();
    compiled.set(path,module);
  };
  for(const item of sources)for(const declaration of imports(item.statements))visit(item.file,declaration.source);
  return compiled;
}

/** A new cache is created for each command or event invocation; modules share the importer's budget. */
export function moduleResolver(root:string,modules:Map<string,Module>,context:Omit<ExecutionContext,'file'|'resolveImport'>):NonNullable<ExecutionContext['resolveImport']> {
  const cache=new Map<string,Promise<Value>>();
  const load=(source:string,from:string,parent?:ExecutionBudget):Promise<Value>=>{
    const path=resolveModulePath(root,from,source),module=modules.get(path);
    if(!module)throw new WispError('MODULE001',`Module was not compiled: ${source}`,from);
    const existing=cache.get(path);if(existing)return existing;
    const promise=execute(module.statements,{...context,file:path,resolveImport:load,budget:parent??context.budget}).then(exports=>record(exports) as Value);
    cache.set(path,promise);return promise;
  };
  return load;
}
