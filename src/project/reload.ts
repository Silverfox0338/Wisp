import type {CompiledProject} from './discovery.js';
export class ReloadableProject {
  private current:CompiledProject;
  constructor(initial:CompiledProject,private readonly compile:()=>CompiledProject){this.current=initial;}
  get value():CompiledProject{return this.current;}
  reload():{ok:true}|{ok:false;error:unknown}{try{const next=this.compile();this.current=next;return {ok:true};}catch(error){return {ok:false,error};}}
}
