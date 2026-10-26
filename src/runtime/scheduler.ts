import {WispError} from '../diagnostics.js';

interface Task {timer:NodeJS.Timeout;running:boolean;repeat:boolean;controller:AbortController}
export interface TaskOptions {
  /** Delay before the first run when it differs from the interval, such as a task restored mid-interval. */
  firstDelaySeconds?:number;
  /** Called as each run starts with the next run time, or null for a one-shot task. */
  onFire?:(nextFireAt:number|null)=>void;
}
export class Scheduler {
  private readonly tasks=new Map<string,Task>();
  private closed=false;
  constructor(private readonly report:(name:string,error:unknown)=>void,private readonly limit=32){}
  schedule(name:string,seconds:number,repeat:boolean,action:(signal:AbortSignal)=>Promise<void>,options:TaskOptions={}):void {
    if(this.closed)throw new WispError('SCHEDULE001','Scheduler is closed');
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(name))throw new WispError('SCHEDULE001',`Task name ${JSON.stringify(name)} must start with a letter and use letters, digits, _ or - (at most 100)`);
    if(!Number.isFinite(seconds)||seconds<1||seconds>604800)throw new WispError('SCHEDULE001','Delay must be 1 to 604800 seconds');
    const first=options.firstDelaySeconds??seconds;if(!Number.isFinite(first)||first<0||first>604800)throw new WispError('SCHEDULE001','First delay must be 0 to 604800 seconds');
    if(!this.tasks.has(name)&&this.tasks.size>=this.limit)throw new WispError('SCHEDULE001','Task limit reached');
    this.cancel(name);
    const task:Task={timer:undefined as unknown as NodeJS.Timeout,running:false,repeat,controller:new AbortController()};
    const fire=():void=>{
      if(this.closed||this.tasks.get(name)!==task||task.running)return;
      task.running=true;
      void Promise.resolve().then(()=>action(task.controller.signal)).catch(error=>{if(!task.controller.signal.aborted)this.report(name,error);}).finally(()=>{task.running=false;if(!repeat&&this.tasks.get(name)===task)this.tasks.delete(name);});
    };
    const arm=(delay:number):void=>{task.timer=setTimeout(()=>{if(this.closed||this.tasks.get(name)!==task)return;if(repeat)arm(seconds);options.onFire?.(repeat?Date.now()+seconds*1000:null);fire();},delay*1000);};
    arm(first);
    this.tasks.set(name,task);
  }
  cancel(name:string):boolean {const task=this.tasks.get(name);if(!task)return false;clearTimeout(task.timer);task.controller.abort();this.tasks.delete(name);return true;}
  clear():void {for(const name of [...this.tasks.keys()])this.cancel(name);}
  close():void {this.clear();this.closed=true;}
  get size():number{return this.tasks.size;}
}
