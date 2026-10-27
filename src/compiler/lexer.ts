import {WispError} from '../diagnostics.js';
export interface Token {type:string; value:string; line:number; column:number}
const ops = ['==','!=','<=','>=','??','+=','-=','*=','/=','+','-','*','/','%','<','>','=','.',':',',','(',')','[',']','{','}'];
export function tokenize(source:string, file='<source>'):Token[] {
  const tokens:Token[]=[]; const indents=[0]; const lines=source.replace(/\r\n?/g,'\n').split('\n');let nesting=0;
  for(let li=0;li<lines.length;li++) {
    const line=lines[li]!; if(!line.trim() || /^ *#/.test(line)) continue;
    const prefix=line.match(/^[ \t]*/)?.[0] ?? '';
    if(prefix.includes('\t')) throw new WispError('PARSE001','Tabs are not allowed for indentation',file,li+1,1);
    if(!nesting){
      if(prefix.length%4) throw new WispError('PARSE001','Indentation must use multiples of four spaces',file,li+1,1);
      const current=indents[indents.length-1]!;
      if(prefix.length>current) { if(prefix.length-current!==4) throw new WispError('PARSE001','Indent one level (four spaces) at a time',file,li+1,1); indents.push(prefix.length); tokens.push({type:'INDENT',value:'',line:li+1,column:1}); }
      else if(prefix.length<current) { while(indents.length>1 && prefix.length<indents[indents.length-1]!) {indents.pop();tokens.push({type:'DEDENT',value:'',line:li+1,column:1});} if(prefix.length!==indents[indents.length-1]) throw new WispError('PARSE001','Inconsistent dedent',file,li+1,1); }
    }
    if(/^markdown:\s*$/.test(line.slice(prefix.length))){
      const base=prefix.length;let end=li+1;
      while(end<lines.length){const next=lines[end]!;if(!next.trim()){end++;continue;}const indent=next.match(/^ */)?.[0].length??0;if(indent<=base)break;end++;}
      if(end>li+1&&lines.slice(li+1,end).some(next=>next.trim())){
        const content=lines.slice(li+1,end);const first=content.find(next=>next.trim())!;const margin=first.match(/^ */)![0].length;
        if(margin!==base+4||content.some(next=>next.trim()&&(next.match(/^ */)?.[0].length??0)<margin))throw new WispError('PARSE001','Markdown block must indent one level',file,li+2,1);
        tokens.push({type:'IDENT',value:'markdown',line:li+1,column:base+1},{type:':',value:':',line:li+1,column:base+9},{type:'NEWLINE',value:'',line:li+1,column:line.length+1},{type:'INDENT',value:'',line:li+2,column:1},{type:'RAW_TEXT',value:content.map(next=>next.trim()?next.slice(margin):'').join('\n').trimEnd(),line:li+2,column:margin+1},{type:'NEWLINE',value:'',line:end,column:1},{type:'DEDENT',value:'',line:end,column:1});
        li=end-1;continue;
      }
    }
    for(let i=prefix.length;i<line.length;) {
      const c=line[i]!; if(c===' '){i++;continue;} if(c==='#') break;
      const col=i+1;
      if(c==='"'||c==="'") {let raw=c; i++; let closed=false; while(i<line.length){const x=line[i++]!;raw+=x;if(x==='\\'&&i<line.length){raw+=line[i++]!;continue;}if(x===c){closed=true;break;}} if(!closed)throw new WispError('PARSE002','Unterminated string',file,li+1,col); tokens.push({type:'STRING',value:raw,line:li+1,column:col});continue;}
      const num=/^(?:\d+(?:\.\d+)?)/.exec(line.slice(i)); if(num){tokens.push({type:'NUMBER',value:num[0],line:li+1,column:col});i+=num[0].length;continue;}
      const ident=/^[A-Za-z_][A-Za-z_0-9]*/.exec(line.slice(i));if(ident){tokens.push({type:'IDENT',value:ident[0],line:li+1,column:col});i+=ident[0].length;continue;}
      const op=ops.find(o=>line.startsWith(o,i));if(op){if(['(','[','{'].includes(op))nesting++;else if([')',']','}'].includes(op))nesting--;tokens.push({type:op,value:op,line:li+1,column:col});i+=op.length;continue;}
      throw new WispError('PARSE002',`Unexpected character ${JSON.stringify(c)}`,file,li+1,col);
    }
    if(!nesting)tokens.push({type:'NEWLINE',value:'',line:li+1,column:line.length+1});
  }
  if(nesting>0)throw new WispError('PARSE002','Unclosed list, map, or grouping',file,lines.length,1);
  while(indents.length>1){indents.pop();tokens.push({type:'DEDENT',value:'',line:lines.length,column:1});}
  tokens.push({type:'EOF',value:'',line:lines.length,column:1});return tokens;
}
