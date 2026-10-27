import {existsSync,readFileSync} from 'node:fs';
/** Edit distance between two names, used for "did you mean" hints. */
export function distance(a:string,b:string):number{const row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let prev=row[0]!;row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j]!;row[j]=Math.min(row[j]!+1,row[j-1]!+1,prev+(a[i-1]===b[j-1]?0:1));prev=old;}}return row[b.length]!;}
/** The closest candidate within two edits of name, if any. */
export function closest(name:string,candidates:Iterable<string>):string|undefined{let best:string|undefined,score=3;for(const candidate of candidates){if(candidate===name)continue;const d=distance(name,candidate);if(d<score){best=candidate;score=d;}}return best;}
export class WispError extends Error {
  readonly frames:{file?:string;line:number;column:number}[]=[];
  status:number|null=null;
  discordCode:number|string|null=null;
  constructor(public readonly code: string, message: string, public readonly file?: string, public readonly line?: number, public readonly column?: number,public readonly suggestion?:string) {
    super(message); this.name = 'WispError';
  }
  addFrame(file:string|undefined,line:number,column:number):this{const last=this.frames.at(-1);if(!last||last.file!==file||last.line!==line||last.column!==column)this.frames.push({file,line,column});return this;}
  format(source?: string): string {
    const where = this.file ? `${this.file}:${this.line ?? 1}:${this.column ?? 1}: ` : '';
    const text=source??(this.file?.endsWith('.wisp')&&existsSync(this.file)?readFileSync(this.file,'utf8'):undefined);
    const excerpt = text && this.line ? text.split(/\r?\n/)[this.line - 1] : undefined;
    const category=this.code.startsWith('PARSE')?'Syntax':this.code.startsWith('MANIFEST')?'Configuration':this.code.startsWith('DISCORD')?'Discord API':this.code.startsWith('RUNTIME')?'Runtime':this.code.startsWith('STORAGE')?'Storage':this.code.startsWith('HTTP')?'HTTP':'Project';
    return `${where}Wisp Error ${this.code} (${category})\n${this.message}${excerpt === undefined ? '' : `\n${this.line} | ${excerpt}\n    ${' '.repeat(Math.max(0, (this.column ?? 1) - 1))}^`}${this.frames.length?`\nCall stack:\n${this.frames.map(frame=>`  ${frame.file??'<source>'}:${frame.line}:${frame.column}`).join('\n')}`:''}${this.suggestion?`\nSuggestion: ${this.suggestion}`:''}`;
  }
}
