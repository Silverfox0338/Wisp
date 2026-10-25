import {WispError} from '../diagnostics.js';
import type {CommandDecl,ComponentDecl,EventDecl,Expr,Module,OptionDecl,Stmt,V2Node} from './ast.js';
import {tokenize,type Token} from './lexer.js';
import {basename} from 'node:path';
const precedence:Record<string,number>={'??':1,or:2,and:3,'==':4,'!=':4,'<':5,'<=':5,'>':5,'>=':5,'+':6,'-':6,'*':7,'/':7};
export function parse(source:string,file='<source>'):Module {return new Parser(tokenize(source,file),file).parse();}
class Parser {
  private i=0;
  constructor(private readonly tokens:Token[],private readonly file:string){}
  private peek(n=0):Token{return this.tokens[this.i+n] ?? this.tokens[this.tokens.length-1]!;}
  private at(value:string):boolean {const t=this.peek();return t.type===value||t.value===value;}
  private take():Token{return this.tokens[this.i++]!;}
  private expect(value:string):Token{if(!this.at(value))this.fail(`Expected ${value}, found ${this.peek().value || this.peek().type}`);return this.take();}
  private fail(message:string):never{const t=this.peek();throw new WispError('PARSE002',message,this.file,t.line,t.column);}
  private newline():void{this.expect('NEWLINE');}
  private block<T>(fn:()=>T):T[]{this.expect(':');this.newline();this.expect('INDENT');const out:T[]=[];while(!this.at('DEDENT')&&!this.at('EOF'))out.push(fn());this.expect('DEDENT');if(!out.length)this.fail('Block must contain at least one statement');return out;}
  parse():Module{const m:Module={commands:[],events:[],statements:[]};while(!this.at('EOF')){if(this.at('command'))m.commands.push(this.command());else if(this.at('event')||this.at('on'))m.events.push(this.event());else m.statements.push(this.statement());}return m;}
  private command():CommandDecl{const start=this.take();const name=this.stringLiteral();const sections=this.block(()=>{
    if(this.at('description')){this.take();const value=this.stringLiteral();this.newline();return {kind:'description' as const,value};}
    if(this.at('default_member_permissions')){this.take();this.expect(':');const value=this.stringLiteral();this.newline();return {kind:'permissions' as const,value};}
    if(this.at('permission')){this.take();this.expect(':');const value=this.stringLiteralOrIdent();this.newline();return {kind:'permission' as const,value};}
    if(this.at('timeout')){this.take();this.expect(':');const value=Number(this.expect('NUMBER').value);this.newline();return {kind:'timeout' as const,value};}
    if(this.at('option'))return {kind:'option' as const,value:this.option()};
    if(this.at('execute')){this.take();return {kind:'execute' as const,value:this.block(()=>this.statement())};}
    return this.fail('Expected description, option, or execute in command');
  });
  const desc=sections.filter(s=>s.kind==='description');const exec=sections.filter(s=>s.kind==='execute');
  if(desc.length!==1||exec.length!==1)throw new WispError('COMMAND001','Command requires exactly one description and execute block',this.file,start.line,start.column);
  if(sections.filter(s=>s.kind==='timeout').length>1)this.fail('Command timeout may be declared only once');
  if(sections.findIndex(s=>s.kind==='execute')!==sections.length-1)this.fail('Execute must be the final command section');
  const options=sections.filter(s=>s.kind==='option').map(s=>s.value as OptionDecl);
  const names=new Set<string>();for(const o of options){if(names.has(o.name))throw new WispError('COMMAND002',`Duplicate option ${o.name}`,this.file,o.line,1);names.add(o.name);}
  return {kind:'command',name,description:desc[0]!.value as string,options,execute:exec[0]!.value as Stmt[],file:this.file,line:start.line,defaultMemberPermissions:sections.find(s=>s.kind==='permissions')?.value as string|undefined,permission:sections.find(s=>s.kind==='permission')?.value as string|undefined,timeoutMs:sections.find(s=>s.kind==='timeout')?.value as number|undefined};}
  private option():OptionDecl{const start=this.take();const name=this.expect('IDENT').value;const fields=this.block(()=>{const k=this.expect('IDENT').value;if(!['type','description','required','choices','min','max'].includes(k))this.fail(`Unknown option property ${k}`);this.expect(':');let v:string|boolean|number|string[];if(k==='choices'){this.expect('[');const a:string[]=[];while(!this.at(']')){a.push(this.stringLiteral());if(!this.at(']'))this.expect(',');}this.expect(']');v=a;}else if(k==='required'){const b=this.expect('IDENT').value;if(b!=='true'&&b!=='false')this.fail('required must be true or false');v=b==='true';}else if(k==='min'||k==='max'){v=Number(this.expect('NUMBER').value);}else v=this.stringLiteralOrIdent();this.newline();return [k,v] as const;});
    const f=Object.fromEntries(fields);const type=f.type;const description=f.description;
    if(typeof type!=='string'||(description!==undefined&&typeof description!=='string'))throw new WispError('COMMAND002','Option requires a type and optional string description',this.file,start.line,start.column);
    if(!['user','string','integer','number','boolean','role','channel'].includes(type))throw new WispError('COMMAND002',`Unsupported option type ${type}`,this.file,start.line,start.column);
    return {name,type,description:typeof description==='string'?description:`Select ${name}`,required:f.required===true,choices:f.choices as string[]|undefined,min:f.min as number|undefined,max:f.max as number|undefined,line:start.line};}
  private stringLiteralOrIdent():string {return this.at('STRING')?this.stringLiteral():this.expect('IDENT').value;}
  private stringLiteral():string{const t=this.expect('STRING');try{return t.value[0]==='"'?JSON.parse(t.value) as string:t.value.slice(1,-1).replace(/\\([\\'nrt])/g,(_,c:string)=>({n:'\n',r:'\r',t:'\t'}[c]??c));}catch{return this.fail('Invalid string escape');}}
  private event():EventDecl{const start=this.take();let name=this.expect('IDENT').value;if(start.value==='on'&&['button','select','user_select','role_select','channel_select','modal'].includes(name)){const pattern=this.stringLiteral();if(pattern.includes('*')&&(name!=='button'||!/^[A-Za-z][A-Za-z0-9_-]*\*$/.test(pattern)))this.fail('Only button handlers support a trailing * wildcard');name=`${name}:${pattern}`;}else if(start.value==='on'&&name==='gateway'){const type=this.stringLiteral();if(!/^[A-Z][A-Z_0-9]{0,99}$/.test(type))throw new WispError('EVENT001',`Invalid Gateway dispatch ${type}`,this.file,start.line,start.column);name=`gateway:${type}`;}else if(!['ready','member_join','member_leave','message_create','message_update','message_delete'].includes(name))throw new WispError('EVENT001',`Unsupported event ${name}`,this.file,start.line,start.column);return {kind:'event',name,body:this.block(()=>this.statement()),file:this.file,line:start.line};}
  private component():ComponentDecl{const start=this.take(),kind=start.value as ComponentDecl['kind'],name=this.stringLiteral();if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))this.fail('Component name must use letters, digits, _ or -');const fields:Record<string,Expr>={},choices:NonNullable<ComponentDecl['choices']>=[],inputs:NonNullable<ComponentDecl['inputs']>=[];this.block(()=>{if(this.at('choice')||this.at('input')){const part=this.take().value,partName=this.stringLiteral();const partFields:Record<string,Expr>={};this.block(()=>{const key=this.expect('IDENT').value;this.expect(':');partFields[key]=this.expression();this.newline();return key;});if(part==='choice')choices.push({value:partName,fields:partFields});else inputs.push({name:partName,fields:partFields});return part;}const key=this.expect('IDENT').value;this.expect(':');if(Object.hasOwn(fields,key))this.fail(`Duplicate component field ${key}`);fields[key]=key==='style'&&['primary','secondary','success','danger'].includes(this.peek().value)&&this.peek(1).type==='NEWLINE'?{kind:'literal',value:this.take().value,line:start.line,column:start.column}:this.expression();this.newline();return key;});return {kind,name,fields,...(choices.length?{choices}:{}),...(inputs.length?{inputs}:{}),line:start.line};}
  private v2Node():V2Node{
    const start=this.peek();
    if(this.at('container')){
      this.take();let accent:Expr|undefined,spoiler:Expr|undefined;const children:V2Node[]=[];
      this.block(()=>{if(this.at('accent')||this.at('spoiler')){const key=this.take().value;this.expect(':');const value=this.expression();this.newline();if(key==='accent'){if(accent)this.fail('Duplicate container accent');accent=value;}else{if(spoiler)this.fail('Duplicate container spoiler');spoiler=value;}return key;}children.push(this.v2Node());return 'child';});
      if(!children.length)this.fail('Container requires a content component');
      return {kind:'container',accent,spoiler,children,line:start.line};
    }
    if(this.at('markdown'))return {kind:'text',value:this.markdownValue(),line:start.line};
    if(this.at('text')){this.take();this.expect(':');if(this.at('NEWLINE'))this.fail('Use markdown: for an unquoted text block');const value=this.expression();this.newline();return {kind:'text',value,line:start.line};}
    if(this.at('separator')){this.take();this.newline();return {kind:'separator',line:start.line};}
    if(this.at('section')){this.take();const fields:Record<string,Expr>={};this.block(()=>{const key=this.expect('IDENT').value;if(key!=='text'&&key!=='thumbnail')this.fail(`Unknown section field ${key}`);this.expect(':');if(Object.hasOwn(fields,key))this.fail(`Duplicate section field ${key}`);fields[key]=this.expression();this.newline();return key;});if(!fields.text||!fields.thumbnail)this.fail('Section requires text and thumbnail');return {kind:'section',text:fields.text,thumbnail:fields.thumbnail,line:start.line};}
    if(this.at('row')){this.take();const components=this.block(()=>{if(!['button','select','user_select','role_select','channel_select'].some(key=>this.at(key)))this.fail('Row requires a button or select');return this.component();});return {kind:'row',components,line:start.line};}
    return this.fail('Expected container, markdown, text, separator, section, or row in V2 reply');
  }
  private markdownValue():Expr{this.expect('markdown');this.expect(':');if(!this.at('NEWLINE')){const value=this.expression();this.newline();return value;}this.newline();this.expect('INDENT');const raw=this.expect('RAW_TEXT');this.newline();this.expect('DEDENT');return {kind:'literal',value:raw.value,line:raw.line,column:raw.column};}
  private replyLayout():{fields:Record<string,Expr>;components:ComponentDecl[];embedFields?:Record<string,Expr>}{
    const fields:Record<string,Expr>={},components:ComponentDecl[]=[];let embedFields:Record<string,Expr>|undefined;
    this.block(()=>{
      if(this.at('row')){this.take();components.push(...this.block(()=>{if(!['button','select','user_select','role_select','channel_select'].some(key=>this.at(key)))this.fail('Row requires a button or select');return this.component();}));return 'row';}
      if(['button','select','user_select','role_select','channel_select'].some(key=>this.at(key))){components.push(this.component());return 'component';}
      if(this.at('embed')&&this.peek(1).type===':'&&this.peek(2).type==='NEWLINE'){
        if(embedFields||fields.embed)this.fail('Reply can have only one embed');this.take();embedFields={};this.block(()=>{if(this.at('markdown')){if(embedFields!.description)this.fail('Embed description is already set');embedFields!.description=this.markdownValue();return 'markdown';}const key=this.expect('IDENT').value;this.expect(':');if(Object.hasOwn(embedFields!,key))this.fail(`Duplicate embed field ${key}`);embedFields![key]=this.expression();this.newline();return key;});return 'embed';
      }
      if(this.at('markdown')){if(fields.content)this.fail('Reply content is already set');fields.content=this.markdownValue();return 'markdown';}
      if(this.at('container')||this.at('section')||this.at('separator'))this.fail('This layout needs reply v2:');
      const key=this.expect('IDENT').value,field=key==='text'?'content':key;this.expect(':');if(Object.hasOwn(fields,field)||(field==='embed'&&embedFields))this.fail(`Duplicate reply field ${key}`);fields[field]=this.expression();this.newline();return key;
    });return {fields,components,...(embedFields?{embedFields}:{})};
  }
  private statement():Stmt{const t=this.peek();if(this.at('let')){this.take();const name=this.expect('IDENT').value;this.expect('=');const expr=this.expression();this.newline();return {kind:'let',name,expr,line:t.line,column:t.column};}
    if(this.at('import')){this.take();const source=this.stringLiteral();if(!source.endsWith('.wisp'))this.fail('Import path must end in .wisp');let alias=basename(source,'.wisp');if(this.at('as')){this.take();alias=this.expect('IDENT').value;}if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias))this.fail('Import needs a valid alias');this.newline();return {kind:'import',source,alias,line:t.line,column:t.column};}
    if(this.at('export')){this.take();if(!this.at('let')&&!this.at('function'))this.fail('export requires let or function');const declaration=this.statement();if(declaration.kind!=='let'&&declaration.kind!=='function')this.fail('Invalid export');return {...declaration,exported:true};}
    if(this.at('every')||this.at('after')){const repeat=this.take().value==='every';const name=this.stringLiteral();const seconds=this.expression();this.expect('seconds');return {kind:'schedule',name,seconds,repeat,body:this.block(()=>this.statement()),line:t.line,column:t.column};}
    if(this.at('show')){this.take();if(!this.at('modal'))this.fail('Expected modal after show');return {kind:'show_modal',component:this.component(),line:t.line,column:t.column};}
    if(this.at('global')){this.take();const name=this.expect('IDENT').value;this.expect('=');const expr=this.expression();this.newline();return {kind:'global',name,expr,line:t.line,column:t.column};}
    if(this.at('function')){this.take();const name=this.expect('IDENT').value;this.expect('(');const params:{name:string;defaultValue?:Expr}[]=[];let optional=false;while(!this.at(')')){const param=this.expect('IDENT').value;if(params.some(p=>p.name===param))this.fail(`Duplicate parameter ${param}`);let defaultValue:Expr|undefined;if(this.at('=')){this.take();defaultValue=this.expression();optional=true;}else if(optional)this.fail('Required parameters must precede default parameters');params.push({name:param,defaultValue});if(!this.at(')'))this.expect(',');}this.expect(')');return {kind:'function',name,params,body:this.block(()=>this.statement()),line:t.line,column:t.column};}
    if(this.at('try')){this.take();const body=this.block(()=>this.statement());const caught=this.expect('catch');const errorName=this.expect('IDENT').value;return {kind:'try',body,errorName,catchBody:this.block(()=>this.statement()),catchLine:caught.line,line:t.line,column:t.column};}
    if(this.at('raise')){this.take();const expr=this.expression();this.newline();return {kind:'raise',expr,line:t.line,column:t.column};}
    if(this.at('return')){this.take();const expr=this.at('NEWLINE')?undefined:this.expression();this.newline();return {kind:'return',expr,line:t.line,column:t.column};}
    if(this.at('if')){this.take();const condition=this.expression();const then=this.block(()=>this.statement());let otherwise:Stmt[]=[];if(this.at('elif')){otherwise=[this.statement()];}else if(this.at('else')){this.take();otherwise=this.block(()=>this.statement());}return {kind:'if',condition,then,otherwise,line:t.line,column:t.column};}
    if(this.at('elif')){this.take();const condition=this.expression();const then=this.block(()=>this.statement());let otherwise:Stmt[]=[];if(this.at('elif'))otherwise=[this.statement()];else if(this.at('else')){this.take();otherwise=this.block(()=>this.statement());}return {kind:'if',condition,then,otherwise,line:t.line,column:t.column};}
    if(this.at('for')){this.take();const name=this.expect('IDENT').value;this.expect('in');const iterable=this.expression();return {kind:'for',name,iterable,body:this.block(()=>this.statement()),line:t.line,column:t.column};}
    if(this.at('while')){this.take();const condition=this.expression();return {kind:'while',condition,body:this.block(()=>this.statement()),line:t.line,column:t.column};}
    if(this.at('reply')){this.take();if(this.at('v2')){this.take();let ephemeral:Expr|undefined;const v2:V2Node[]=[];this.block(()=>{if(this.at('ephemeral')){this.take();this.expect(':');if(ephemeral)this.fail('Duplicate V2 ephemeral field');ephemeral=this.expression();this.newline();return 'ephemeral';}v2.push(this.v2Node());return 'component';});if(!v2.length)this.fail('V2 reply requires a component');return {kind:'reply',v2,ephemeral,line:t.line,column:t.column};}if(this.at('v1')){this.take();return {kind:'reply',layout:this.replyLayout(),line:t.line,column:t.column};}if(this.at('embed')){this.take();const fields=this.block(()=>{const key=this.expect('IDENT').value;this.expect(':');const expr=this.expression();this.newline();return [key,expr] as const;});return {kind:'reply',embed:Object.fromEntries(fields),line:t.line,column:t.column};}if(this.at(':'))return {kind:'reply',layout:this.replyLayout(),line:t.line,column:t.column};const expr=this.expression();let ephemeral:Expr|undefined;if(this.at('ephemeral')){this.take();this.expect(':');ephemeral=this.expression();}this.newline();return {kind:'reply',expr,ephemeral,line:t.line,column:t.column};}
    if(this.at('IDENT')&&this.peek(1).type==='='){const name=this.take().value;this.take();const expr=this.expression();this.newline();return {kind:'assign',name,expr,line:t.line,column:t.column};}
    const expr=this.expression();this.newline();return {kind:'expr',expr,line:t.line,column:t.column};}
  private expression(min=0):Expr{let left=this.prefix();while(true){const t=this.peek();if(this.at('.')&&9>=min){this.take();left={kind:'property',object:left,name:this.expect('IDENT').value,line:t.line,column:t.column};continue;}
      if(this.at('(')&&9>=min){this.take();const args:Expr[]=[];while(!this.at(')')){args.push(this.expression());if(!this.at(')'))this.expect(',');}this.take();left={kind:'call',callee:left,args,line:t.line,column:t.column};continue;}
      if(this.at('[')&&9>=min){this.take();const index=this.expression();this.expect(']');left={kind:'index',object:left,index,line:t.line,column:t.column};continue;}
      const p=precedence[t.value];if(p===undefined||p<min)break;this.take();left={kind:'binary',op:t.value,left,right:this.expression(p+1),line:t.line,column:t.column};}return left;}
  private prefix():Expr{const t=this.take();if(t.type==='STRING'){this.i--;return {kind:'literal',value:this.stringLiteral(),line:t.line,column:t.column};}
    if(t.type==='NUMBER')return {kind:'literal',value:Number(t.value),line:t.line,column:t.column};
    if(t.value==='true'||t.value==='false'||t.value==='null')return {kind:'literal',value:t.value==='null'?null:t.value==='true',line:t.line,column:t.column};
    if(t.value==='not'||t.value==='-')return {kind:'unary',op:t.value,right:this.expression(8),line:t.line,column:t.column};
    if(t.type==='IDENT')return {kind:'name',name:t.value,line:t.line,column:t.column};
    if(t.type==='('){const e=this.expression();this.expect(')');return e;}
    if(t.type==='['){const items:Expr[]=[];while(!this.at(']')){items.push(this.expression());if(!this.at(']'))this.expect(',');}this.take();return {kind:'list',items,line:t.line,column:t.column};}
    if(t.type==='{'){const entries:{key:string;value:Expr}[]=[];while(!this.at('}')){const key=this.stringLiteral();this.expect(':');entries.push({key,value:this.expression()});if(!this.at('}'))this.expect(',');}this.take();return {kind:'map',entries,line:t.line,column:t.column};}
    return this.fail(`Expected expression, found ${t.value||t.type}`);}
}
