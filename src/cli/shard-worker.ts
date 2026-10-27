// One of several bot processes, started by `wisp run` when discord.processes is above 1.
import {loadProject} from '../project/manifest.js';
import {discover} from '../project/discovery.js';
import {runBot} from '../discord/bot.js';
import {FATAL_EXIT,processLink,workerInfo} from '../discord/shards.js';
import {WispError} from '../diagnostics.js';

try{
  const info=workerInfo();
  if(!info)throw new WispError('SHARD001','This file is started by wisp run; run wisp run instead');
  const project=loadProject(process.cwd(),true);
  if(process.argv.includes('--debug'))project.manifest.logging.level='debug';
  await runBot(project,discover(project),false,undefined,processLink(info));
}catch(error){
  console.error(error instanceof WispError?error.format():`Process ${process.env.WISP_PROCESS??'?'} could not start`);
  process.exit(FATAL_EXIT);
}
