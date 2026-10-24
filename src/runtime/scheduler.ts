import {WispError} from '../diagnostics.js';

interface Task {timer:NodeJS.Timeout;running:boolean;repeat:boolean;controller:AbortController}
export class Scheduler {
  private readonly tasks=new Map<string,Task>();
  private closed=false;
  constructor(private readonly report:(name:string,error:unknown)=>void,private readonly limit=32){}
  schedule(name:string,seconds:number,repeat:boolean,action:(signal:AbortSignal)=>Promise<void>):void {
    if(this.closed)throw new WispError('SCHEDULE001','Scheduler is closed');
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))throw new WispError('SCHEDULE001','Task name must use letters, digits, _ or -');
    if(!Number.isFinite(seconds)||seconds<1||seconds>604800)throw new WispError('SCHEDULE001','Delay must be 1 to 604800 seconds');
    if(!this.tasks.has(name)&&this.tasks.size>=this.limit)throw new WispError('SCHEDULE001','Task limit reached');
    this.cancel(name);
    const task:Task={timer:undefined as unknown as NodeJS.Timeout,running:false,repeat,controller:new AbortController()};
    const fire=():void=>{
      if(this.closed||this.tasks.get(name)!==task||task.running)return;
      task.running=true;
      void Promise.resolve().then(()=>action(task.controller.signal)).catch(error=>{if(!task.controller.signal.aborted)this.report(name,error);}).finally(()=>{task.running=false;if(!repeat&&this.tasks.get(name)===task)this.tasks.delete(name);});
    };
    task.timer=repeat?setInterval(fire,seconds*1000):setTimeout(fire,seconds*1000);
    this.tasks.set(name,task);
  }
  cancel(name:string):boolean {const task=this.tasks.get(name);if(!task)return false;clearTimeout(task.timer);task.controller.abort();this.tasks.delete(name);return true;}
  clear():void {for(const name of [...this.tasks.keys()])this.cancel(name);}
  close():void {this.clear();this.closed=true;}
  get size():number{return this.tasks.size;}
}
