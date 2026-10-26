import type {Cooldown} from '../compiler/ast.js';
import type {StorageBackend} from '../storage/types.js';
export interface CooldownIds {user:string;guild:string|null;channel:string|null}
/** Claim the route's cooldown; returns the reply for a blocked user, or null when the command may run. */
export async function checkCooldown(storage:Pick<StorageBackend,'claimCooldown'>,cooldown:Cooldown|undefined,route:string,label:string,ids:CooldownIds,now=Date.now()):Promise<string|null>{
  if(!cooldown)return null;
  const who=cooldown.per==='user'?ids.user:cooldown.per==='guild'?ids.guild??ids.user:ids.channel??ids.user;
  const expires=await storage.claimCooldown(`${route}:${cooldown.per}:${who}`,now,now+cooldown.seconds*1000);
  if(expires===null)return null;
  return `Slow down! You can use ${label} again <t:${Math.ceil(expires/1000)}:R>.`;
}
