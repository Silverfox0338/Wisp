const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');

test('language server handles initialization, diagnostics, completion and hover over LSP',async()=>{
  const child=spawn(process.execPath,[path.join(__dirname,'../dist/server.js'),'--stdio'],{stdio:['pipe','pipe','pipe']});
  let buffer=Buffer.alloc(0),next=1;const pending=new Map(),notifications=[];
  child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const header=buffer.indexOf('\r\n\r\n');if(header<0)break;const match=/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,header).toString());if(!match)throw new Error('Missing Content-Length');const length=Number(match[1]);if(buffer.length<header+4+length)break;const data=JSON.parse(buffer.subarray(header+4,header+4+length).toString());buffer=buffer.subarray(header+4+length);if(data.id!==undefined&&pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}else notifications.push(data);}});
  const send=payload=>{const json=Buffer.from(JSON.stringify({jsonrpc:'2.0',...payload}));child.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);child.stdin.write(json);};
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>reject(new Error(`LSP ${method} timed out`)),5000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});send({id,method,params});});
  try{
    const initialized=await request('initialize',{processId:process.pid,rootUri:null,capabilities:{}});assert.equal(initialized.result.capabilities.hoverProvider,true);
    send({method:'initialized',params:{}});
    const uri='file:///test.wisp';send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'wisp',version:1,text:'let x = missing\nguild.\n'}}});
    const completed=await request('textDocument/completion',{textDocument:{uri},position:{line:1,character:6}});
    assert.ok(completed.result.some(item=>item.label==='joinRank'));
    assert.ok(!completed.result.some(item=>item.label==='ban'));
    assert.ok(notifications.some(item=>item.method==='textDocument/publishDiagnostics'&&item.params.diagnostics.length));
    const text='function greet(name):\n    return name\nlet message = greet("Fox")\nlet rank = guild.joinRank(interaction.user)\n';
    send({method:'textDocument/didChange',params:{textDocument:{uri,version:2},contentChanges:[{text}]}});
    const definition=await request('textDocument/definition',{textDocument:{uri},position:{line:2,character:15}});assert.equal(definition.result.range.start.line,0);
    const found=await request('textDocument/references',{textDocument:{uri},position:{line:2,character:15},context:{includeDeclaration:true}});assert.equal(found.result.length,2);
    const renamed=await request('textDocument/rename',{textDocument:{uri},position:{line:2,character:15},newName:'welcome'});assert.equal(renamed.result.changes[uri].length,2);
    const symbols=await request('textDocument/documentSymbol',{textDocument:{uri}});assert.ok(symbols.result.some(item=>item.name==='greet'));
    const hovered=await request('textDocument/hover',{textDocument:{uri},position:{line:3,character:20}});assert.match(hovered.result.contents.value,/joinRank/);
    const hinted=await request('textDocument/signatureHelp',{textDocument:{uri},position:{line:3,character:text.split('\n')[3].indexOf('joinRank(')+'joinRank('.length}});assert.match(hinted.result.signatures[0].label,/member: Member/);
  }finally{child.kill();}
});
