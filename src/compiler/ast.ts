export type Expr =
  | {kind:'literal'; value:string|number|boolean|null; line:number; column:number}
  | {kind:'name'; name:string; line:number; column:number}
  | {kind:'list'; items:Expr[]; line:number; column:number}
  | {kind:'map'; entries:{key:string; value:Expr}[]; line:number; column:number}
  | {kind:'unary'; op:string; right:Expr; line:number; column:number}
  | {kind:'binary'; op:string; left:Expr; right:Expr; line:number; column:number}
  | {kind:'property'; object:Expr; name:string; line:number; column:number}
  | {kind:'index'; object:Expr; index:Expr; line:number; column:number}
  | {kind:'call'; callee:Expr; args:Expr[]; line:number; column:number};
/** Compound assignment operators; `x += 1` means `x = x + 1`. */
export type AssignOp='+='|'-='|'*='|'/=';
export type Stmt =
  | {kind:'let'|'assign'; name:string; expr:Expr; op?:AssignOp; exported?:boolean; line:number; column:number}
  | {kind:'set'; target:Extract<Expr,{kind:'property'|'index'}>; op:'='|AssignOp; expr:Expr; line:number; column:number}
  | {kind:'break'|'continue'; line:number; column:number}
  | {kind:'match'; subject:Expr; cases:{values:Expr[]; body:Stmt[]; line:number}[]; otherwise:Stmt[]; line:number; column:number}
  | {kind:'global'; name:string; expr:Expr; line:number; column:number}
  | {kind:'if'; condition:Expr; then:Stmt[]; otherwise:Stmt[]; line:number; column:number}
  | {kind:'for'; name:string; iterable:Expr; body:Stmt[]; line:number; column:number}
  | {kind:'while'; condition:Expr; body:Stmt[]; line:number; column:number}
  | {kind:'function'; name:string; params:{name:string; defaultValue?:Expr}[]; body:Stmt[]; exported?:boolean; line:number; column:number}
  | {kind:'try'; body:Stmt[]; errorName:string; catchBody:Stmt[]; catchLine:number; line:number; column:number}
  | {kind:'raise'; expr:Expr; line:number; column:number}
  | {kind:'import'; source:string; alias:string; line:number; column:number}
  | {kind:'schedule'; name:string; seconds:Expr; repeat:boolean; data?:Expr; body:Stmt[]; line:number; column:number}
  | {kind:'show_modal'; component:ComponentDecl; line:number; column:number}
  | {kind:'return'; expr?:Expr; line:number; column:number}
  | {kind:'reply'; expr?:Expr; embed?:Record<string,Expr>; layout?:{fields:Record<string,Expr>;components:ComponentDecl[];embedFields?:Record<string,Expr>;roles?:RoleMenu}; v2?:V2Node[]; pages?:PagesDecl; ephemeral?:Expr; line:number; column:number}
  | {kind:'expr'; expr:Expr; line:number; column:number};
/** `roles:` inside `reply:`; members pick roles from a select menu. */
export interface RoleMenu {choices:{label:string; role:Expr}[]; pick:'one'|'many'; line:number}
/** `reply pages:`; each item becomes one line, split into pages with ◀ ▶ buttons. */
export interface PagesDecl {fields:Record<string,Expr>; each:{name:string; line:Expr}; line:number}
export interface OptionDecl { name:string; type:string; description:string; required:boolean; choices?:string[]; min?:number; max?:number; suggest?:Stmt[]; line:number }
export interface Cooldown {seconds:number; per:'user'|'guild'|'channel'}
export interface SubcommandDecl {name:string; description:string; group?:string; groupDescription?:string; options:OptionDecl[]; execute:Stmt[]; cooldown?:Cooldown; line:number}
export interface ComponentDecl {kind:'button'|'select'|'user_select'|'role_select'|'channel_select'|'modal';name:string;fields:Record<string,Expr>;choices?:{value:string;fields:Record<string,Expr>}[];inputs?:{name:string;fields:Record<string,Expr>}[];line:number}
export type V2Node =
  | {kind:'container';accent?:Expr;spoiler?:Expr;children:V2Node[];line:number}
  | {kind:'text';value:Expr;line:number}
  | {kind:'separator';line:number}
  | {kind:'section';text:Expr;thumbnail:Expr;line:number}
  | {kind:'row';components:ComponentDecl[];line:number};
export interface CommandDecl {kind:'command'; type?:'user'|'message'; name:string; description:string; options:OptionDecl[]; execute:Stmt[]; subcommands?:SubcommandDecl[]; file:string; line:number; defaultMemberPermissions?:string; permission?:string; timeoutMs?:number; defer?:'public'|'ephemeral'; cooldown?:Cooldown}
export interface EventDecl {kind:'event'; name:string; body:Stmt[]; file:string; line:number}
export type Module = {commands:CommandDecl[]; events:EventDecl[]; statements:Stmt[]};
