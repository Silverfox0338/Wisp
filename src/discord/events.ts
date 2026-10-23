export class EventGate {
  private active=0;
  constructor(private readonly limit:number){if(!Number.isInteger(limit)||limit<1)throw new Error('Event concurrency limit must be positive');}
  get count():number{return this.active;}
  async run(work:()=>Promise<void>):Promise<boolean>{if(this.active>=this.limit)return false;this.active++;try{await work();return true;}finally{this.active--;}}
}
