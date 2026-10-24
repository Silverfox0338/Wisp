import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {basename,join,relative} from 'node:path';
import type {CompiledProject} from '../project/discovery.js';
import type {ProjectConfig} from '../project/manifest.js';

export function doctorWarnings(project:ProjectConfig,compiled:CompiledProject,nodeVersion=process.versions.node):string[]{
  const warnings:string[]=[];
  const [major=0,minor=0]=nodeVersion.split('.').map(Number);
  if(major<24||(major===24&&minor<17))warnings.push(`Node.js 24.17 or newer is required; found ${nodeVersion}.`);
  const intents=project.manifest.discord.intents;
  if(compiled.events.some(event=>event.name.startsWith('member_'))&&!intents.includes('guild_members'))warnings.push('Member events need guild_members in discord.intents in wisp.json.');
  if(compiled.events.some(event=>event.name.startsWith('message_'))&&!intents.includes('guild_messages'))warnings.push('Message events need guild_messages in discord.intents in wisp.json.');
  if(intents.includes('guild_members'))warnings.push('Enable Server Members Intent in the Discord Developer Portal for this bot.');
  if(intents.includes('guild_presences'))warnings.push('Enable Presence Intent in the Discord Developer Portal for this bot.');
  if(intents.includes('message_content'))warnings.push('Enable Message Content Intent in the Discord Developer Portal for this bot.');
  if(existsSync(join(project.root,'.env'))&&project.root.split(/[\\/]/).some(part=>/(?:^|[\s_.()-])(zip(?:ped)?|shar(?:e|ed)|archive|backup|export)(?:$|[\s_.()-])/i.test(part)))warnings.push('.env is inside a folder that looks like an archive or shared copy; keep secrets out of files you distribute.');
  const sources=new Set([project.paths.entry,...compiled.commands.map(command=>command.file),...compiled.events.map(event=>event.file),...compiled.modules?.keys()??[]]);
  const tests=join(project.root,'tests');
  if(existsSync(tests))for(const entry of readdirSync(tests,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.wisp'))sources.add(join(tests,entry.name));
  for(const path of sources){
    const text=readFileSync(path,'utf8');
    if(text.includes('\r\n')&&text.replaceAll('\r\n','').includes('\n'))warnings.push(`Mixed CRLF and LF line endings in ${relative(project.root,path)||basename(path)}.`);
  }
  const traces=join(project.root,'.wisp','traces');
  if(existsSync(traces)){
    const files=readdirSync(traces).filter(name=>name.endsWith('.json')).sort().slice(-20);
    for(const file of files){try{
      const report=JSON.parse(readFileSync(join(traces,file),'utf8')) as {label?:string;roots?:{durationMs?:number}[]};
      const duration=(report.roots??[]).reduce((total,node)=>total+(node.durationMs??0),0);
      if(duration>2000)warnings.push(`Slow traced handler ${report.label??file}: ${Math.round(duration)} ms. Inspect .wisp/traces/${file.replace(/\.json$/,'.html')}.`);
    }catch{warnings.push(`Unreadable trace report: ${file}.`);}}
  }
  return warnings;
}
