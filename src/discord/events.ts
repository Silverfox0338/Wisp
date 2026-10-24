export class EventGate {
  private active=0;
  private readonly pending:{work:()=>Promise<void>;resolve:(accepted:boolean)=>void;reject:(error:unknown)=>void}[]=[];
  private closed=false;
  constructor(private readonly limit:number,private readonly queueLimit=256){if(!Number.isInteger(limit)||limit<1||!Number.isInteger(queueLimit)||queueLimit<0)throw new Error('Event limits must be nonnegative and concurrency must be positive');}
  get count():number{return this.active;}
  get queued():number{return this.pending.length;}
  run(work:()=>Promise<void>):Promise<boolean>{if(this.closed||this.active>=this.limit&&this.pending.length>=this.queueLimit)return Promise.resolve(false);return new Promise<boolean>((resolve,reject)=>{this.pending.push({work,resolve,reject});this.pump();});}
  close():void{this.closed=true;for(const item of this.pending.splice(0))item.resolve(false);}
  private pump():void{while(!this.closed&&this.active<this.limit&&this.pending.length){const item=this.pending.shift()!;this.active++;void Promise.resolve().then(item.work).then(()=>{this.active--;this.pump();item.resolve(true);},error=>{this.active--;this.pump();item.reject(error);});}}
}
