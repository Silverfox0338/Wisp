import {existsSync,readFileSync} from 'node:fs';
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
