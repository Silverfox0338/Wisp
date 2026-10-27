import {createConnection,ProposedFeatures,TextDocuments,TextDocumentSyncKind,CompletionItemKind,SymbolKind,DiagnosticSeverity,MarkupKind,type InitializeParams,type Location,type WorkspaceEdit} from 'vscode-languageserver/node';
import {TextDocument} from 'vscode-languageserver-textdocument';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {analyze,completion,hover,references,signature,symbolAt,type Analysis} from '../../../src/editor/service.js';

const connection=createConnection(ProposedFeatures.all),documents=new TextDocuments(TextDocument);
const cache=new Map<string,{version:number;analysis:Analysis}>();
let roots:string[]=[];
const analysisFor=(document:TextDocument):Analysis=>{const prior=cache.get(document.uri);if(prior?.version===document.version)return prior.analysis;const result=analyze(document.getText(),document.uri);cache.set(document.uri,{version:document.version,analysis:result});return result;};
const location=(uri:string,range:Analysis['definitions'][number]['range']):Location=>({uri,range});
function projectFiles():string[]{const files:string[]=[];const visit=(dir:string):void=>{if(files.length>=1000)return;let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}for(const entry of entries){if(['node_modules','dist','.wisp','.git'].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile()&&extname(path)==='.wisp')files.push(path);if(files.length>=1000)return;}};for(const root of roots)visit(root);return files;}
function sameFile(left:string,right:string):boolean{const a=resolve(left),b=resolve(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
function projectRoot(file:string):string|undefined{let dir=dirname(file);while(true){if(existsSync(join(dir,'wisp.json')))return dir;const parent=dirname(dir);if(parent===dir)return undefined;dir=parent;}}
function importCompletions(document:TextDocument,line:string):{label:string;kind:CompletionItemKind}[]|null{const match=/\bimport\s+"([^"]*)$/.exec(line);if(!match)return null;const file=fileURLToPath(document.uri),target=resolve(dirname(file),match[1]!);if(!roots.some(root=>{const rel=relative(root,target);return !rel.startsWith('..')&&!isAbsolute(rel);}))return [];let dir=target;try{if(!statSync(dir).isDirectory())dir=dirname(dir);}catch{dir=dirname(dir);}try{return readdirSync(dir,{withFileTypes:true}).filter(item=>item.isDirectory()||item.name.endsWith('.wisp')).map(item=>({label:item.name+(item.isDirectory()?'/':''),kind:item.isDirectory()?CompletionItemKind.Folder:CompletionItemKind.File}));}catch{return [];}}

connection.onInitialize((params:InitializeParams)=>{roots=(params.workspaceFolders??[]).map(folder=>fileURLToPath(folder.uri));if(!roots.length&&params.rootUri)roots=[fileURLToPath(params.rootUri)];return {capabilities:{textDocumentSync:TextDocumentSyncKind.Incremental,completionProvider:{triggerCharacters:['.','"']},hoverProvider:true,signatureHelpProvider:{triggerCharacters:['(', ',']},definitionProvider:true,referencesProvider:true,renameProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true}};});
documents.onDidOpen(change=>publish(change.document));documents.onDidChangeContent(change=>publish(change.document));documents.onDidClose(change=>{cache.delete(change.document.uri);connection.sendDiagnostics({uri:change.document.uri,diagnostics:[]});});
function publish(document:TextDocument):void{
  const result=analysisFor(document);
  const diagnostics=result.diagnostics.map(item=>({...item,severity:item.severity===1?DiagnosticSeverity.Error:DiagnosticSeverity.Warning,source:'Wisp'}));
  const localCommands=result.definitions.filter(item=>item.kind==='command');
  const openFile=fileURLToPath(document.uri),root=projectRoot(openFile);
  if(localCommands.length&&root){
    for(const file of projectFiles()){
      const candidateRoot=projectRoot(file);
      if(sameFile(file,openFile)||!candidateRoot||!sameFile(candidateRoot,root))continue;
      let other;
      try{other=analyze(readFileSync(file,'utf8'),file);}catch{continue;}
      for(const command of localCommands)if(other.definitions.some(item=>item.kind==='command'&&item.name===command.name&&item.type===command.type))diagnostics.push({range:command.range,message:`Duplicate command ${command.name} in ${file}`,severity:DiagnosticSeverity.Error,code:'COMMAND003',source:'Wisp'});
    }
  }
  connection.sendDiagnostics({uri:document.uri,diagnostics});
}
connection.onCompletion(params=>{const document=documents.get(params.textDocument.uri);if(!document)return [];const line=document.getText().split(/\r?\n/)[params.position.line]?.slice(0,params.position.character)??'';const imports=importCompletions(document,line);if(imports)return imports;return completion(analysisFor(document),params.position).map(item=>({label:item.label,kind:item.kind==='function'?CompletionItemKind.Function:item.kind==='keyword'?CompletionItemKind.Keyword:item.kind==='module'?CompletionItemKind.Module:item.kind==='property'?CompletionItemKind.Property:CompletionItemKind.Variable,detail:item.detail,documentation:item.documentation}));});
connection.onHover(params=>{const doc=documents.get(params.textDocument.uri);if(!doc)return null;const value=hover(analysisFor(doc),params.position);return value?{contents:{kind:MarkupKind.Markdown,value}}:null;});
connection.onSignatureHelp(params=>{const doc=documents.get(params.textDocument.uri);if(!doc)return null;const info=signature(analysisFor(doc),params.position);if(!info?.signature)return null;const before=doc.getText().split(/\r?\n/)[params.position.line]?.slice(0,params.position.character)??'';return {signatures:[{label:info.signature,documentation:info.description}],activeSignature:0,activeParameter:Math.max(0,(before.match(/,/g)??[]).length)};});
connection.onDefinition(params=>{const doc=documents.get(params.textDocument.uri);if(!doc)return null;const occurrence=symbolAt(analysisFor(doc),params.position);return occurrence?location(doc.uri,occurrence.definition.range):null;});
connection.onReferences(params=>{const doc=documents.get(params.textDocument.uri);if(!doc)return [];const analysis=analysisFor(doc),occurrence=symbolAt(analysis,params.position);if(!occurrence)return [];return references(analysis,params.position).filter(item=>params.context.includeDeclaration||item!==occurrence.definition.range).map(item=>location(doc.uri,item));});
connection.onRenameRequest(params=>{if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(params.newName))return null;const doc=documents.get(params.textDocument.uri);if(!doc)return null;const changes=references(analysisFor(doc),params.position).map(range=>({range,newText:params.newName}));return changes.length?{changes:{[doc.uri]:changes}} satisfies WorkspaceEdit:null;});
connection.onDocumentSymbol(params=>{const doc=documents.get(params.textDocument.uri);if(!doc)return [];return analysisFor(doc).definitions.filter(def=>['command','event','function','variable','module'].includes(def.kind)).map(def=>({name:def.name,kind:def.kind==='command'||def.kind==='function'?SymbolKind.Function:def.kind==='event'?SymbolKind.Event:def.kind==='module'?SymbolKind.Module:SymbolKind.Variable,range:def.range,selectionRange:def.range}));});
connection.onWorkspaceSymbol(params=>{const query=params.query.toLowerCase(),out:{name:string;kind:SymbolKind;location:Location}[]=[];for(const path of projectFiles()){let result:Analysis;try{result=analyze(readFileSync(path,'utf8'),path);}catch{continue;}for(const def of result.definitions)if(def.name.toLowerCase().includes(query)){out.push({name:def.name,kind:def.kind==='command'||def.kind==='function'?SymbolKind.Function:def.kind==='event'?SymbolKind.Event:SymbolKind.Variable,location:location(pathToFileURL(path).href,def.range)});if(out.length>=500)return out;}}return out;});
documents.listen(connection);connection.listen();
