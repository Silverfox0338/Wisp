import {WispError,closest} from '../diagnostics.js';
import type {AssignOp,PagesDecl,RoleMenu,CommandDecl,ComponentDecl,Cooldown,EventDecl,Expr,Module,OptionDecl,Stmt,SubcommandDecl,V2Node} from './ast.js';
import {tokenize,type Token} from './lexer.js';
import {basename} from 'node:path';
const precedence:Record<string,number>={'??':1,or:2,and:3,'==':4,'!=':4,in:4,'<':5,'<=':5,'>':5,'>=':5,'+':6,'-':6,'*':7,'/':7,'%':7};
const assignOps=['=','+=','-=','*=','/='];
const events=['ready','member_join','member_leave','message_create','message_update','message_delete','shard_ready','shard_disconnect','shard_reconnecting','shard_resume'];
export function parse(source:string,file='<source>'):Module {return new Parser(tokenize(source,file),file).parse();}
class Parser {
  private i=0;
  /** How many for/while bodies enclose the statement being parsed; break and continue need one. */
  private loops=0;
  constructor(private readonly tokens:Token[],private readonly file:string){}
  private peek(n=0):Token{return this.tokens[this.i+n] ?? this.tokens[this.tokens.length-1]!;}
  private at(value:string):boolean {const t=this.peek();return t.type===value||t.value===value;}
  private take():Token{return this.tokens[this.i++]!;}
  private expect(value:string):Token{if(!this.at(value))this.fail(`Expected ${value}, found ${this.peek().value || this.peek().type}`);return this.take();}
  private fail(message:string):never{const t=this.peek();throw new WispError('PARSE002',message,this.file,t.line,t.column);}
  private newline():void{this.expect('NEWLINE');}
  private block<T>(fn:()=>T):T[]{if(this.at('=')&&this.peek(1).type!=='=')this.fail('Use == to compare');if(!this.at(':'))this.fail(`Expected : at the end of the line, found ${this.peek().value||this.peek().type}`);this.take();this.newline();this.expect('INDENT');const out:T[]=[];while(!this.at('DEDENT')&&!this.at('EOF'))out.push(fn());this.expect('DEDENT');if(!out.length)this.fail('Block must contain at least one statement');return out;}
  private loopBody():Stmt[]{this.loops++;try{return this.block(()=>this.statement());}finally{this.loops--;}}
  /** A body that runs later or elsewhere, so break and continue cannot reach an enclosing loop. */
  private isolatedBody():Stmt[]{const saved=this.loops;this.loops=0;try{return this.block(()=>this.statement());}finally{this.loops=saved;}}
  parse():Module{const m:Module={commands:[],events:[],statements:[]};while(!this.at('EOF')){if(this.at('command'))m.commands.push(this.command());else if((this.at('user')||this.at('message'))&&this.peek(1).value==='command')m.commands.push(this.command(this.peek().value as 'user'|'message'));else if(this.at('event')||this.at('on'))m.events.push(this.event());else m.statements.push(this.statement());}return m;}
  private command(type?:'user'|'message'):CommandDecl{if(type)this.take();const start=this.take();const name=this.stringLiteral();const subcommands:SubcommandDecl[]=[];const sections=this.block(()=>{
    if(this.at('description')){this.take();const value=this.stringLiteral();this.newline();return {kind:'description' as const,value};}
    if(this.at('default_member_permissions')){this.take();this.expect(':');const value=this.stringLiteral();this.newline();return {kind:'permissions' as const,value};}
    if(this.at('permission')){this.take();this.expect(':');const value=this.stringLiteralOrIdent();this.newline();return {kind:'permission' as const,value};}
    if(this.at('timeout')){this.take();this.expect(':');const value=Number(this.expect('NUMBER').value);this.newline();return {kind:'timeout' as const,value};}
    if(this.at('defer')){this.take();this.expect(':');const value=this.stringLiteralOrIdent();if(value!=='public'&&value!=='ephemeral')this.fail('defer must be public or ephemeral');this.newline();return {kind:'defer' as const,value};}
    if(this.at('cooldown'))return {kind:'cooldown' as const,value:this.cooldown()};
    if(this.at('option'))return {kind:'option' as const,value:this.option()};
    if(this.at('subcommand')){subcommands.push(this.subcommand());return {kind:'subcommand' as const,value:null};}
    if(this.at('group')){subcommands.push(...this.group());return {kind:'subcommand' as const,value:null};}
    if(this.at('execute')){this.take();return {kind:'execute' as const,value:this.block(()=>this.statement())};}
    return this.fail(type?'Expected permission, timeout, defer, cooldown, or execute in context menu command':'Expected description, option, subcommand, group, cooldown, or execute in command');
  });
  const desc=sections.filter(s=>s.kind==='description');const exec=sections.filter(s=>s.kind==='execute');const options=sections.filter(s=>s.kind==='option').map(s=>s.value as OptionDecl);
  const err=(code:string,message:string,suggestion:string)=>new WispError(code,message,this.file,start.line,start.column,suggestion);
  if(type){
    if(desc.length)throw err('COMMAND004',`${type} command "${name}" cannot have a description`,'Remove the description line; Discord only shows the name in the Apps menu');
    if(options.length||subcommands.length)throw err('COMMAND004',`${type} command "${name}" cannot have options or subcommands`,`Use target inside execute: to read the right-clicked ${type}`);
    if(exec.length!==1)throw err('COMMAND001',`${type} command "${name}" requires exactly one execute block`,'Add an execute: block');
  }else if(subcommands.length){
    if(desc.length!==1)throw err('COMMAND001',`Command "${name}" requires exactly one description`,'Add description "..." at the top of the command');
    if(exec.length||options.length)throw err('COMMAND004',`Command "${name}" has subcommands, so it cannot have its own execute or options`,'Move execute: and option blocks into a subcommand');
  }else if(desc.length!==1||exec.length!==1)throw new WispError('COMMAND001','Command requires exactly one description and execute block',this.file,start.line,start.column);
  if(sections.filter(s=>s.kind==='timeout').length>1)this.fail('Command timeout may be declared only once');if(sections.filter(s=>s.kind==='defer').length>1)this.fail('Command defer may be declared only once');if(sections.filter(s=>s.kind==='cooldown').length>1)this.fail('Command cooldown may be declared only once');
  if(exec.length&&sections.findIndex(s=>s.kind==='execute')!==sections.length-1)this.fail('Execute must be the final command section');
  this.uniqueOptions(options);
  const routes=new Set<string>(),groups=new Set<string>();for(const sub of subcommands){const key=`${sub.group??''} ${sub.name}`;if(routes.has(key))throw new WispError('COMMAND002',`Duplicate subcommand ${sub.group?`${sub.group} `:''}${sub.name}`,this.file,sub.line,1);routes.add(key);if(sub.group)groups.add(sub.group);}
  for(const sub of subcommands)if(!sub.group&&groups.has(sub.name))throw new WispError('COMMAND002',`Subcommand ${sub.name} has the same name as a group`,this.file,sub.line,1,'Give the subcommand or the group a different name');
  return {kind:'command',...(type?{type}:{}),name,description:(desc[0]?.value as string|undefined)??'',options,execute:(exec[0]?.value as Stmt[]|undefined)??[],...(subcommands.length?{subcommands}:{}),file:this.file,line:start.line,defaultMemberPermissions:sections.find(s=>s.kind==='permissions')?.value as string|undefined,permission:sections.find(s=>s.kind==='permission')?.value as string|undefined,timeoutMs:sections.find(s=>s.kind==='timeout')?.value as number|undefined,defer:sections.find(s=>s.kind==='defer')?.value as 'public'|'ephemeral'|undefined,...(sections.some(s=>s.kind==='cooldown')?{cooldown:sections.find(s=>s.kind==='cooldown')!.value as Cooldown}:{})};}
  private cooldown():Cooldown{const start=this.take();const usage='Write it like cooldown: 10 seconds per user';const fail=(message:string):never=>{throw new WispError('COMMAND004',message,this.file,start.line,start.column,usage);};if(!this.at(':'))fail('cooldown needs a colon');this.take();if(!this.at('NUMBER'))fail('cooldown needs a number first');const amount=Number(this.take().value);const unit=this.at('IDENT')?this.take().value:'';const scale=({second:1,seconds:1,minute:60,minutes:60,hour:3600,hours:3600,day:86400,days:86400} as Record<string,number>)[unit];if(!scale)fail(`cooldown unit must be seconds, minutes, hours, or days${unit?`, not ${unit}`:''}`);let per:Cooldown['per']='user';if(this.at('per')){this.take();const who=this.at('IDENT')?this.take().value:'';if(who!=='user'&&who!=='guild'&&who!=='channel')fail(`cooldown must be per user, guild, or channel${who?`, not ${who}`:''}`);per=who as Cooldown['per'];}if(!this.at('NEWLINE'))fail('Unexpected text after cooldown');this.newline();return {seconds:amount*scale!,per};}
  private uniqueOptions(options:OptionDecl[]):void{const names=new Set<string>();for(const o of options){if(names.has(o.name))throw new WispError('COMMAND002',`Duplicate option ${o.name}`,this.file,o.line,1);names.add(o.name);}}
  private subcommand():SubcommandDecl{const start=this.take();const name=this.stringLiteralOrIdent();const parts:{description?:string;execute?:Stmt[];cooldown?:Cooldown}={};const options:OptionDecl[]=[];
    this.block(()=>{
      if(this.at('description')){this.take();if(parts.description!==undefined)this.fail('Subcommand description may be declared only once');parts.description=this.stringLiteral();this.newline();return 'description';}
      if(this.at('cooldown')){if(parts.cooldown)this.fail('Subcommand cooldown may be declared only once');parts.cooldown=this.cooldown();return 'cooldown';}
      if(this.at('option')){if(parts.execute)this.fail('Execute must be the final subcommand section');options.push(this.option());return 'option';}
      if(this.at('execute')){if(parts.execute)this.fail('Subcommand execute may be declared only once');this.take();parts.execute=this.block(()=>this.statement());return 'execute';}
      if(this.at('subcommand')||this.at('group'))this.fail('Subcommands cannot be nested; put group blocks directly inside the command');
      return this.fail('Expected description, option, cooldown, or execute in subcommand');
    });
    if(parts.description===undefined||!parts.execute)throw new WispError('COMMAND001',`Subcommand ${name} requires a description and an execute block`,this.file,start.line,start.column,'Add description "..." and execute: inside the subcommand');
    this.uniqueOptions(options);
    return {name,description:parts.description,options,execute:parts.execute,...(parts.cooldown?{cooldown:parts.cooldown}:{}),line:start.line};}
  private group():SubcommandDecl[]{const start=this.take();const name=this.stringLiteralOrIdent();const parts:{description?:string}={};const subs:SubcommandDecl[]=[];
    this.block(()=>{
      if(this.at('description')){this.take();if(parts.description!==undefined)this.fail('Group description may be declared only once');parts.description=this.stringLiteral();this.newline();return 'description';}
      if(this.at('subcommand')){subs.push(this.subcommand());return 'subcommand';}
      return this.fail('Groups contain only a description and subcommand blocks');
    });
    if(parts.description===undefined||!subs.length)throw new WispError('COMMAND001',`Group ${name} requires a description and at least one subcommand`,this.file,start.line,start.column,'Add description "..." and one or more subcommand blocks inside the group');
    return subs.map(sub=>({...sub,group:name,groupDescription:parts.description}));}
  private option():OptionDecl{const start=this.take();const name=this.expect('IDENT').value;const fields=this.block(()=>{const k=this.expect('IDENT').value;if(!['type','description','required','choices','min','max','suggest'].includes(k))this.fail(`Unknown option property ${k}`);if(k==='suggest')return [k,this.block(()=>this.statement())] as const;this.expect(':');let v:string|boolean|number|string[];if(k==='choices'){this.expect('[');const a:string[]=[];while(!this.at(']')){a.push(this.stringLiteral());if(!this.at(']'))this.expect(',');}this.expect(']');v=a;}else if(k==='required'){const b=this.expect('IDENT').value;if(b!=='true'&&b!=='false')this.fail('required must be true or false');v=b==='true';}else if(k==='min'||k==='max'){v=Number(this.expect('NUMBER').value);}else v=this.stringLiteralOrIdent();this.newline();return [k,v] as const;});
    const f=Object.fromEntries(fields);const type=f.type;const description=f.description;
    if(typeof type!=='string'||(description!==undefined&&typeof description!=='string'))throw new WispError('COMMAND002','Option requires a type and optional string description',this.file,start.line,start.column);
    if(!['user','string','integer','number','boolean','role','channel'].includes(type))throw new WispError('COMMAND002',`Unsupported option type ${type}`,this.file,start.line,start.column);
    const suggest=f.suggest as Stmt[]|undefined;
    if(suggest&&f.choices)throw new WispError('COMMAND004',`Option ${name} cannot have both choices and suggest`,this.file,start.line,start.column,'Use choices for a fixed list, or suggest: for live (autocomplete) suggestions');
    if(suggest&&!['string','integer','number'].includes(type))throw new WispError('COMMAND004',`suggest: (autocomplete) needs a string, integer, or number option, not ${type}`,this.file,start.line,start.column,'Discord already offers a picker for user, role, and channel options');
    return {name,type,description:typeof description==='string'?description:`Select ${name}`,required:f.required===true,choices:f.choices as string[]|undefined,min:f.min as number|undefined,max:f.max as number|undefined,...(suggest?{suggest}:{}),line:start.line};}
  private stringLiteralOrIdent():string {return this.at('STRING')?this.stringLiteral():this.expect('IDENT').value;}
  private stringLiteral():string{const t=this.expect('STRING');try{return t.value[0]==='"'?JSON.parse(t.value) as string:t.value.slice(1,-1).replace(/\\([\\'nrt])/g,(_,c:string)=>({n:'\n',r:'\r',t:'\t'}[c]??c));}catch{return this.fail('Invalid string escape');}}
  private event():EventDecl{const start=this.take();if(this.at('STRING'))this.fail(`Event names are not quoted; write ${start.value} ${this.peek().value.slice(1,-1)}:`);let name=this.expect('IDENT').value;if(start.value==='on'&&['button','select','user_select','role_select','channel_select','modal'].includes(name)){const pattern=this.stringLiteral();if(pattern.includes('*')&&(name!=='button'||!/^[A-Za-z][A-Za-z0-9_-]*\*$/.test(pattern)))this.fail('Only button handlers support a trailing * wildcard');name=`${name}:${pattern}`;}else if(start.value==='on'&&name==='gateway'){const type=this.stringLiteral();if(!/^[A-Z][A-Z_0-9]{0,99}$/.test(type))throw new WispError('EVENT001',`Invalid Gateway dispatch ${type}`,this.file,start.line,start.column);name=`gateway:${type}`;}else if(!events.includes(name)){const guess=closest(name,events);throw new WispError('EVENT001',`Unsupported event ${name}${guess?`; did you mean ${guess}?`:''}`,this.file,start.line,start.column,guess?`Did you mean "${guess}"?`:undefined);}return {kind:'event',name,body:this.block(()=>this.statement()),file:this.file,line:start.line};}
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
  private replyLayout():{fields:Record<string,Expr>;components:ComponentDecl[];embedFields?:Record<string,Expr>;roles?:RoleMenu}{
    const start=this.peek();const fields:Record<string,Expr>={},components:ComponentDecl[]=[];let embedFields:Record<string,Expr>|undefined,roles:RoleMenu|undefined,pick:'one'|'many'|undefined;
    const layout=()=>({fields,components,...(embedFields?{embedFields}:{}),...(roles?{roles:{...roles,pick:pick??'many'}}:{})});
    this.block(()=>{
      if(this.at('roles')&&this.peek(1).type===':'&&this.peek(2).type==='NEWLINE'){if(roles)this.fail('Reply can have only one roles menu');const at=this.take();const choices=this.block(()=>{const label=this.stringLiteral();this.expect(':');const role=this.expression();this.newline();return {label,role};});if(choices.length>25)this.fail('A roles menu holds at most 25 roles');roles={choices,pick:'many',line:at.line};return 'roles';}
      if(this.at('pick')&&this.peek(1).type===':'){this.take();this.take();const value=this.stringLiteralOrIdent();if(value!=='one'&&value!=='many')this.fail('pick must be one or many');pick=value;this.newline();return 'pick';}
      if(this.at('row')){this.take();components.push(...this.block(()=>{if(!['button','select','user_select','role_select','channel_select'].some(key=>this.at(key)))this.fail('Row requires a button or select');return this.component();}));return 'row';}
      if(['button','select','user_select','role_select','channel_select'].some(key=>this.at(key))){components.push(this.component());return 'component';}
      if(this.at('embed')&&this.peek(1).type===':'&&this.peek(2).type==='NEWLINE'){
        if(embedFields||fields.embed)this.fail('Reply can have only one embed');this.take();embedFields={};this.block(()=>{if(this.at('markdown')){if(embedFields!.description)this.fail('Embed description is already set');embedFields!.description=this.markdownValue();return 'markdown';}const key=this.expect('IDENT').value;this.expect(':');if(Object.hasOwn(embedFields!,key))this.fail(`Duplicate embed field ${key}`);embedFields![key]=this.expression();this.newline();return key;});return 'embed';
      }
      if(this.at('markdown')){if(fields.content)this.fail('Reply content is already set');fields.content=this.markdownValue();return 'markdown';}
      if(this.at('container')||this.at('section')||this.at('separator'))this.fail('This layout needs reply v2:');
      const key=this.expect('IDENT').value,field=key==='text'?'content':key;this.expect(':');if(Object.hasOwn(fields,field)||(field==='embed'&&embedFields))this.fail(`Duplicate reply field ${key}`);fields[field]=this.expression();this.newline();return key;
    });if(pick&&!roles)throw new WispError('PARSE002','pick needs a roles: menu in the same reply',this.file,start.line,start.column);return layout();
  }
  private pages():PagesDecl{const start=this.peek();const fields:Record<string,Expr>={};let each:PagesDecl['each']|undefined;
    this.block(()=>{
      if(this.at('each')){if(each)this.fail('reply pages has only one each');this.take();const name=this.expect('IDENT').value;const lines=this.block(()=>{const expr=this.expression();this.newline();return expr;});if(lines.length!==1)this.fail('each holds one line of text, like "{item.name}"');each={name,line:lines[0]!};return 'each';}
      const key=this.expect('IDENT').value;if(!['items','per_page','title','color','empty','ephemeral'].includes(key))this.fail(`Unknown pages field ${key}; use items, per_page, title, color, empty, ephemeral, or each`);if(Object.hasOwn(fields,key))this.fail(`Duplicate pages field ${key}`);this.expect(':');fields[key]=this.expression();this.newline();return key;
    });
    if(!fields.items)throw new WispError('PARSE002','reply pages needs items: with the list to show',this.file,start.line,start.column);
    if(!each)throw new WispError('PARSE002','reply pages needs an each item: line',this.file,start.line,start.column);
    return {fields,each,line:start.line};}
  private statement():Stmt{const t=this.peek();
    if((this.at('break')||this.at('continue'))&&this.peek(1).type==='NEWLINE'){if(!this.loops)this.fail(`${t.value} only works inside for or while`);this.take();this.newline();return {kind:t.value as 'break'|'continue',line:t.line,column:t.column};}
    if(this.at('match')&&!['NEWLINE',':','.','(','[',...assignOps].includes(this.peek(1).type))return this.match();
if(this.at('let')){this.take();const name=this.expect('IDENT').value;this.expect('=');const expr=this.expression();this.newline();return {kind:'let',name,expr,line:t.line,column:t.column};}
    if(this.at('import')){this.take();const source=this.stringLiteral();if(!source.endsWith('.wisp'))this.fail('Import path must end in .wisp');let alias=basename(source,'.wisp');if(this.at('as')){this.take();alias=this.expect('IDENT').value;}if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias))this.fail('Import needs a valid alias');this.newline();return {kind:'import',source,alias,line:t.line,column:t.column};}
    if(this.at('export')){this.take();if(!this.at('let')&&!this.at('function'))this.fail('export requires let or function');const declaration=this.statement();if(declaration.kind!=='let'&&declaration.kind!=='function')this.fail('Invalid export');return {...declaration,exported:true};}
    if(this.at('every')||this.at('after')){const repeat=this.take().value==='every';const name=this.stringLiteral();const seconds=this.expression();this.expect('seconds');let data:Expr|undefined;if(this.at('with')){this.take();data=this.expression();}return {kind:'schedule',name,seconds,repeat,...(data?{data}:{}),body:this.isolatedBody(),line:t.line,column:t.column};}
    if(this.at('show')){this.take();if(!this.at('modal'))this.fail('Expected modal after show');return {kind:'show_modal',component:this.component(),line:t.line,column:t.column};}
    if(this.at('global')){this.take();const name=this.expect('IDENT').value;this.expect('=');const expr=this.expression();this.newline();return {kind:'global',name,expr,line:t.line,column:t.column};}
    if(this.at('function')){this.take();const name=this.expect('IDENT').value;this.expect('(');const params:{name:string;defaultValue?:Expr}[]=[];let optional=false;while(!this.at(')')){const param=this.expect('IDENT').value;if(params.some(p=>p.name===param))this.fail(`Duplicate parameter ${param}`);let defaultValue:Expr|undefined;if(this.at('=')){this.take();defaultValue=this.expression();optional=true;}else if(optional)this.fail('Required parameters must precede default parameters');params.push({name:param,defaultValue});if(!this.at(')'))this.expect(',');}this.expect(')');return {kind:'function',name,params,body:this.isolatedBody(),line:t.line,column:t.column};}
    if(this.at('try')){this.take();const body=this.block(()=>this.statement());const caught=this.expect('catch');const errorName=this.expect('IDENT').value;return {kind:'try',body,errorName,catchBody:this.block(()=>this.statement()),catchLine:caught.line,line:t.line,column:t.column};}
    if(this.at('raise')){this.take();const expr=this.expression();this.newline();return {kind:'raise',expr,line:t.line,column:t.column};}
    if(this.at('return')){this.take();const expr=this.at('NEWLINE')?undefined:this.expression();this.newline();return {kind:'return',expr,line:t.line,column:t.column};}
    if(this.at('if')){this.take();const condition=this.expression();const then=this.block(()=>this.statement());let otherwise:Stmt[]=[];if(this.at('elif')){otherwise=[this.statement()];}else if(this.at('else')){this.take();otherwise=this.block(()=>this.statement());}return {kind:'if',condition,then,otherwise,line:t.line,column:t.column};}
    if(this.at('elif')){this.take();const condition=this.expression();const then=this.block(()=>this.statement());let otherwise:Stmt[]=[];if(this.at('elif'))otherwise=[this.statement()];else if(this.at('else')){this.take();otherwise=this.block(()=>this.statement());}return {kind:'if',condition,then,otherwise,line:t.line,column:t.column};}
    if(this.at('for')){this.take();const name=this.expect('IDENT').value;this.expect('in');const iterable=this.expression();return {kind:'for',name,iterable,body:this.loopBody(),line:t.line,column:t.column};}
    if(this.at('while')){this.take();const condition=this.expression();return {kind:'while',condition,body:this.loopBody(),line:t.line,column:t.column};}
    if(this.at('reply')){this.take();if(this.at('pages')&&this.peek(1).type===':'){this.take();return {kind:'reply',pages:this.pages(),line:t.line,column:t.column};}if(this.at('v2')){this.take();let ephemeral:Expr|undefined;const v2:V2Node[]=[];this.block(()=>{if(this.at('ephemeral')){this.take();this.expect(':');if(ephemeral)this.fail('Duplicate V2 ephemeral field');ephemeral=this.expression();this.newline();return 'ephemeral';}v2.push(this.v2Node());return 'component';});if(!v2.length)this.fail('V2 reply requires a component');return {kind:'reply',v2,ephemeral,line:t.line,column:t.column};}if(this.at('v1')){this.take();return {kind:'reply',layout:this.replyLayout(),line:t.line,column:t.column};}if(this.at('embed')){this.take();const fields=this.block(()=>{const key=this.expect('IDENT').value;this.expect(':');const expr=this.expression();this.newline();return [key,expr] as const;});return {kind:'reply',embed:Object.fromEntries(fields),line:t.line,column:t.column};}if(this.at(':'))return {kind:'reply',layout:this.replyLayout(),line:t.line,column:t.column};const expr=this.expression();let ephemeral:Expr|undefined;if(this.at('ephemeral')){this.take();this.expect(':');ephemeral=this.expression();}this.newline();return {kind:'reply',expr,ephemeral,line:t.line,column:t.column};}
    const expr=this.expression();
    if(assignOps.includes(this.peek().type)){const op=this.take().type as '='|AssignOp;const value=this.expression();this.newline();
      if(expr.kind==='name')return {kind:'assign',name:expr.name,expr:value,...(op==='='?{}:{op}),line:t.line,column:t.column};
      if(expr.kind==='property'||expr.kind==='index')return {kind:'set',target:expr,op,expr:value,line:t.line,column:t.column};
      throw new WispError('PARSE002','Only names, fields, and list items can be assigned',this.file,t.line,t.column);}
    this.newline();return {kind:'expr',expr,line:t.line,column:t.column};}
  /** `match value:` followed by `when a, b:` branches and an optional final `else:`. */
  private match():Stmt{const t=this.take();const subject=this.expression();this.expect(':');this.newline();this.expect('INDENT');const cases:{values:Expr[];body:Stmt[];line:number}[]=[];let otherwise:Stmt[]|undefined;
    while(!this.at('DEDENT')&&!this.at('EOF')){if(otherwise)this.fail('else must be the last branch of match');const branch=this.peek();if(this.at('else')){this.take();otherwise=this.block(()=>this.statement());continue;}if(!this.at('when'))this.fail('Each match branch starts with when or else');this.take();const values=[this.expression()];while(this.at(',')){this.take();values.push(this.expression());}cases.push({values,body:this.block(()=>this.statement()),line:branch.line});}
    this.expect('DEDENT');if(!cases.length)this.fail('match needs at least one when branch');return {kind:'match',subject,cases,otherwise:otherwise??[],line:t.line,column:t.column};}
  private expression(min=0):Expr{let left=this.prefix();while(true){const t=this.peek();if(this.at('.')&&9>=min){this.take();left={kind:'property',object:left,name:this.expect('IDENT').value,line:t.line,column:t.column};continue;}
      if(this.at('(')&&9>=min){this.take();const args:Expr[]=[];while(!this.at(')')){args.push(this.expression());if(!this.at(')'))this.expect(',');}this.take();left={kind:'call',callee:left,args,line:t.line,column:t.column};continue;}
      if(this.at('[')&&9>=min){this.take();const index=this.expression();this.expect(']');left={kind:'index',object:left,index,line:t.line,column:t.column};continue;}
      if(this.at('not')&&this.peek(1).value==='in'&&4>=min){this.take();this.take();left={kind:'binary',op:'not in',left,right:this.expression(5),line:t.line,column:t.column};continue;}
      const p=t.type==='STRING'?undefined:precedence[t.value];if(p===undefined||p<min)break;this.take();left={kind:'binary',op:t.value,left,right:this.expression(p+1),line:t.line,column:t.column};}return left;}
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
