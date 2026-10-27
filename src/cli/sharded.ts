import {fileURLToPath} from 'node:url';
import type {ProjectConfig} from '../project/manifest.js';
import {ShardManager,gatewayBot,shardGroups} from '../discord/shards.js';
import {WispError} from '../diagnostics.js';

/** `wisp run` with discord.processes above 1: split the shards over several processes and keep them running. */
export async function runSharded(project:ProjectConfig,debug:boolean):Promise<void>{
  const log=(level:string,message:string)=>console.log(`${new Date().toISOString()} ${level.toUpperCase()} [manager] ${message}`);
  const setting=project.manifest.discord.shards??'auto',processes=project.manifest.discord.processes??1;
  const count=setting==='auto'?(await gatewayBot(project.manifest.discord.token)).shards:setting;
  if(processes>count)throw new WispError('SHARD001',`discord.processes (${processes}) is more than the ${count} shard${count===1?'':'s'} Discord recommends; lower discord.processes or set discord.shards`);
  const manager=new ShardManager({groups:shardGroups(count,processes),entry:fileURLToPath(new URL('./shard-worker.js',import.meta.url)),args:debug?['--debug']:[],log});
  const stop=()=>{log('info','Stopping every process');void manager.stop();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  log('info',`Starting ${processes} processes for ${count} shards`);
  await manager.start();
  log('info','Every process is running');
  await manager.done;
  if(manager.failure)throw manager.failure;
}
