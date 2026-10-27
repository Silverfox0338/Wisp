import {fork,type ChildProcess} from 'node:child_process';
import {REST,Routes} from 'discord.js';
import {WispError} from '../diagnostics.js';

export interface GatewayBot {shards:number;session_start_limit:{total:number;remaining:number;reset_after:number;max_concurrency:number}}
/** Discord's recommended shard count and today's session limit, from GET /gateway/bot. */
export async function gatewayBot(token:string):Promise<GatewayBot>{
  try{return await new REST({version:'10',timeout:8000}).setToken(token).get(Routes.gatewayBot()) as GatewayBot;}
  catch(error){throw new WispError('SHARD001',`Could not ask Discord for the shard count${error instanceof Error?` (${error.message.slice(0,200)})`:''}; check the token, or set discord.shards to a number`);}
}

/** Which worker process this is, and which shards every worker runs. Set by the manager through WISP_PROCESS and WISP_SHARD_GROUPS. */
export interface WorkerInfo {index:number;groups:number[][];shards:number[];count:number}
export interface ShardStatus {id:number;status:string;ping:number|null;guilds:number|null}

/** Split shards 0..count-1 into contiguous groups, one per process; earlier groups take the remainder. */
export function shardGroups(count:number,processes:number):number[][]{
  if(!Number.isInteger(count)||count<1)throw new WispError('SHARD001','Shard count must be a whole number of at least 1');
  if(!Number.isInteger(processes)||processes<1||processes>count)throw new WispError('SHARD001',`processes (${processes}) can't be more than shards (${count})`);
  const size=Math.floor(count/processes),extra=count%processes,groups:number[][]=[];let next=0;
  for(let index=0;index<processes;index++){const take=size+(index<extra?1:0);groups.push(Array.from({length:take},(_,offset)=>next+offset));next+=take;}
  return groups;
}

/** Discord's rule for which shard receives a guild. */
export function shardForGuild(guildId:string,count:number):number{
  if(!/^\d{1,20}$/.test(guildId))throw new WispError('DISCORD005','Guild ID must be a snowflake string');
  return Number((BigInt(guildId)>>22n)%BigInt(count));
}

export function workerInfo(env:NodeJS.ProcessEnv=process.env):WorkerInfo|null{
  if(env.WISP_PROCESS===undefined)return null;
  const index=Number(env.WISP_PROCESS);let groups:unknown;
  try{groups=JSON.parse(env.WISP_SHARD_GROUPS??'');}catch{groups=null;}
  if(!Number.isInteger(index)||!Array.isArray(groups)||!groups[index]||!groups.every(group=>Array.isArray(group)&&group.every(id=>Number.isInteger(id)&&id>=0)))throw new WispError('SHARD001','Invalid WISP_PROCESS or WISP_SHARD_GROUPS; start sharded bots with wisp run');
  const typed=groups as number[][];
  return {index,groups:typed,shards:typed[index]!,count:typed.flat().length};
}

export type LinkMessage=
  |{wisp:'ready'}
  |{wisp:'all-ready'}
  |{wisp:'stop'}
  |{wisp:'call';id:number;from:number;to:number;op:string;payload:unknown}
  |{wisp:'reply';id:number;to:number;ok:boolean;result?:unknown;error?:{code:string;message:string}};
const isLinkMessage=(value:unknown):value is LinkMessage=>!!value&&typeof value==='object'&&typeof (value as {wisp?:unknown}).wisp==='string';

/** A worker's connection to the other workers, through the manager. */
export class ShardLink {
  private next=1;
  private readonly waiting=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private readonly handlers=new Map<string,(payload:unknown)=>unknown>();
  private readonly listeners={allReady:[] as (()=>void)[],stop:[] as (()=>void)[]};
  constructor(readonly info:WorkerInfo,private readonly post:(message:LinkMessage)=>void){}
  get primary():boolean{return this.info.index===0;}
  handle(op:string,handler:(payload:unknown)=>unknown):void{this.handlers.set(op,handler);}
  onAllReady(listener:()=>void):void{this.listeners.allReady.push(listener);}
  onStop(listener:()=>void):void{this.listeners.stop.push(listener);}
  ready():void{this.post({wisp:'ready'});}
  workerFor(shard:number):number{return this.info.groups.findIndex(group=>group.includes(shard));}
  /** Run an operation in another worker. Calls to this worker run directly. */
  async call(to:number,op:string,payload:unknown,timeoutMs=2000):Promise<unknown>{
    if(to===this.info.index)return this.run(op,payload);
    if(!this.info.groups[to])throw new WispError('SHARD001',`There is no process ${to}`);
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waiting.delete(id);reject(new WispError('SHARD001',`Process ${to} did not answer; it may be restarting`));},timeoutMs);
      this.waiting.set(id,{resolve,reject,timer});
      this.post({wisp:'call',id,from:this.info.index,to,op,payload});
    });
  }
  /** Run an operation in every worker; a worker that fails or doesn't answer gives an error entry. */
  callAll(op:string,payload:unknown,timeoutMs=2000):Promise<PromiseSettledResult<unknown>[]>{return Promise.allSettled(this.info.groups.map((_,index)=>this.call(index,op,payload,timeoutMs)));}
  async receive(message:unknown):Promise<void>{
    if(!isLinkMessage(message))return;
    if(message.wisp==='all-ready'){for(const listener of this.listeners.allReady)listener();return;}
    if(message.wisp==='stop'){for(const listener of this.listeners.stop)listener();return;}
    if(message.wisp==='reply'){const waiting=this.waiting.get(message.id);if(!waiting)return;clearTimeout(waiting.timer);this.waiting.delete(message.id);if(message.ok)waiting.resolve(message.result??null);else waiting.reject(new WispError(message.error?.code??'SHARD001',message.error?.message??'Shard operation failed'));return;}
    if(message.wisp==='call'){
      try{this.post({wisp:'reply',id:message.id,to:message.from,ok:true,result:await this.run(message.op,message.payload)});}
      catch(error){this.post({wisp:'reply',id:message.id,to:message.from,ok:false,error:error instanceof WispError?{code:error.code,message:error.message}:{code:'SHARD001',message:'Shard operation failed'}});}
    }
  }
  close():void{for(const [id,waiting] of this.waiting){clearTimeout(waiting.timer);waiting.reject(new WispError('SHARD001','The bot is shutting down'));this.waiting.delete(id);}}
  private async run(op:string,payload:unknown):Promise<unknown>{const handler=this.handlers.get(op);if(!handler)throw new WispError('SHARD001',`Unknown shard operation ${op}`);return handler(payload);}
}

/** The link for a worker started by the manager, over Node's IPC channel. */
export function processLink(info:WorkerInfo):ShardLink{
  const link=new ShardLink(info,message=>{if(process.connected)process.send?.(message);});
  process.on('message',message=>{void link.receive(message);});
  return link;
}

/** Exit code a worker uses when it can't start at all, such as a rejected token; the manager stops instead of restarting it. */
export const FATAL_EXIT=2;

export interface ManagerOptions {
  groups:number[][];
  entry:string;
  args?:string[];
  log:(level:'info'|'warn'|'error',message:string)=>void;
  /** First restart delay; it doubles on each crash in a row, up to 30 seconds. */
  restartDelayMs?:number;
}

/** Starts one worker per shard group, one after another, routes messages between them, and restarts crashed workers. */
export class ShardManager {
  private readonly workers:(ChildProcess|null)[];
  private readonly ready:boolean[];
  private readonly crashes:number[];
  private announced=false;
  private stopping=false;
  private failed:Error|null=null;
  get failure():Error|null{return this.failed;}
  private finish:(()=>void)|undefined;
  readonly done:Promise<void>;
  constructor(private readonly options:ManagerOptions){
    this.workers=options.groups.map(()=>null);this.ready=options.groups.map(()=>false);this.crashes=options.groups.map(()=>0);
    this.done=new Promise(resolve=>{this.finish=resolve;});
  }
  /** Resolves once every worker has reported ready, or rejects if one can't start. */
  async start():Promise<void>{
    for(let index=0;index<this.options.groups.length&&!this.stopping;index++)await this.spawn(index);
    if(this.failed)throw this.failed;
  }
  private label(index:number):string{const group=this.options.groups[index]!;return `process ${index} (shard${group.length===1?'':'s'} ${group.length===1?group[0]:`${group[0]}-${group[group.length-1]}`})`;}
  private spawn(index:number):Promise<void>{
    return new Promise(resolve=>{
      const child=fork(this.options.entry,this.options.args??[],{env:{...process.env,WISP_PROCESS:String(index),WISP_SHARD_GROUPS:JSON.stringify(this.options.groups)},stdio:'inherit'});
      this.workers[index]=child;
      let settled=false;const settle=()=>{if(!settled){settled=true;resolve();}};
      child.on('message',message=>{if(isLinkMessage(message)&&message.wisp==='ready'){this.ready[index]=true;this.crashes[index]=0;this.options.log('info',`Started ${this.label(index)}`);settle();this.announce();}else this.route(message);});
      child.on('exit',code=>{
        this.workers[index]=null;this.ready[index]=false;if(index===0)this.announced=false;settle();
        if(this.stopping){if(this.workers.every(worker=>worker===null))this.finish?.();return;}
        if(code===FATAL_EXIT){this.failed=new WispError('SHARD001',`${this.label(index)} could not start; see the error above`);void this.stop();return;}
        const delay=Math.min(30000,(this.options.restartDelayMs??1000)*2**this.crashes[index]!);this.crashes[index]!++;
        this.options.log('error',`${this.label(index)} exited with code ${code}; restarting in ${Math.round(delay/1000)} s`);
        setTimeout(()=>{if(!this.stopping)void this.spawn(index);},delay).unref();
      });
    });
  }
  /** Tell process 0 once every worker is ready, so `on ready:` runs once for the whole bot. */
  private announce():void{if(this.announced||!this.ready.every(Boolean))return;this.announced=true;this.workers[0]?.send({wisp:'all-ready'});}
  private route(message:unknown):void{
    if(!isLinkMessage(message))return;
    if(message.wisp==='call'){const target=this.workers[message.to];if(target?.connected)target.send(message);else this.workers[message.from]?.send({wisp:'reply',id:message.id,to:message.from,ok:false,error:{code:'SHARD001',message:`Process ${message.to} is restarting; try again shortly`}});}
    else if(message.wisp==='reply'){const target=this.workers[message.to];if(target?.connected)target.send(message);}
  }
  /** Ask every worker to shut down, and force any that take longer than 10 seconds. */
  async stop():Promise<void>{
    if(!this.stopping){this.stopping=true;
      for(const worker of this.workers)if(worker?.connected)worker.send({wisp:'stop'});
      const force=setTimeout(()=>{for(const worker of this.workers)worker?.kill();},10000);force.unref();
      if(this.workers.every(worker=>worker===null))this.finish?.();
    }
    await this.done;
  }
}
