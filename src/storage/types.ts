import type {Value} from '../runtime/interpreter.js';

export interface ComponentState {id:string;kind:string;name:string;guildId:string;ownerId:string|null;expiresAt:number;state:Record<string,Value>;messageId?:string|null;channelId?:string|null}
/** What a component row is tied to; deleting that owner deletes the row. */
export type ComponentOwner='message'|'channel'|'guild';
/** A scheduled task saved so it survives a restart; the body is found again by file and name template. */
export interface TaskRow {name:string;file:string;template:string;repeat:boolean;intervalSeconds:number;fireAt:number;data:Record<string,Value>|null}
export interface StorageSnapshot {values:{scope:string;key:string;value:Value}[];components:ComponentState[];rosters:{guildId:string;members:{id:string;joinedAt:string}[];completedAt:string}[];tasks?:TaskRow[]}
export interface StorageBackend {
  get(scope:string,key:string,fallback?:Value):Value|Promise<Value>;
  has(scope:string,key:string):boolean|Promise<boolean>;
  set(scope:string,key:string,value:Value):void|Promise<void>;
  delete(scope:string,key:string):void|Promise<void>;
  increment(scope:string,key:string,amount?:number):number|Promise<number>;
  putComponent(item:ComponentState):void|Promise<void>;
  getComponent(id:string):ComponentState|null|Promise<ComponentState|null>;
  cleanupComponents():number|Promise<number>;
  /** Tie rows to the message that displays them; expiresAt replaces only rows without an expiry. */
  linkComponents(ids:string[],messageId:string,channelId:string,expiresAt?:number):void|Promise<void>;
  deleteComponentsFor(owner:ComponentOwner,ids:string[]):number|Promise<number>;
  saveRoster(guildId:string,members:{id:string;joinedAt:string}[]):void|Promise<void>;
  /** Start a cooldown that ends at until unless one is active; returns the active expiry, or null when claimed. */
  claimCooldown(key:string,now:number,until:number):number|null|Promise<number|null>;
  cleanupCooldowns(now:number):number|Promise<number>;
  putTask(task:TaskRow):void|Promise<void>;
  deleteTask(name:string):void|Promise<void>;
  listTasks():TaskRow[]|Promise<TaskRow[]>;
  close():void|Promise<void>;
}
