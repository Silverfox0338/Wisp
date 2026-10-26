import type {Stmt} from '../compiler/ast.js';
import type {TaskRow} from '../storage/types.js';
export type RestoreStep =
  | {action:'arm';row:TaskRow;body:Stmt[];delaySeconds:number;moved:boolean}
  | {action:'drop';row:TaskRow;reason:'missing'|'missed'};
/** Decide what to do with each saved task at boot. Runs missed while offline are skipped: one-shots are dropped and repeating tasks move to their next interval. */
export function planRestore(rows:TaskRow[],bodies:Map<string,Stmt[]>|undefined,now:number):RestoreStep[]{
  return rows.map(row=>{
    const body=bodies?.get(row.template);
    if(!body)return {action:'drop',row,reason:'missing'};
    if(row.fireAt>now)return {action:'arm',row,body,delaySeconds:(row.fireAt-now)/1000,moved:false};
    if(!row.repeat)return {action:'drop',row,reason:'missed'};
    const step=row.intervalSeconds*1000,fireAt=row.fireAt+(Math.floor((now-row.fireAt)/step)+1)*step;
    return {action:'arm',row:{...row,fireAt},body,delaySeconds:(fireAt-now)/1000,moved:true};
  });
}
