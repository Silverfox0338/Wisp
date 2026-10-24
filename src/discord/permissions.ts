import {PermissionFlagsBits} from 'discord.js';
import {WispError} from '../diagnostics.js';
import {host,record,type Value} from '../runtime/interpreter.js';
export const commandPermissions:Record<string,bigint>={administrator:PermissionFlagsBits.Administrator,manage_messages:PermissionFlagsBits.ManageMessages,manage_guild:PermissionFlagsBits.ManageGuild,kick_members:PermissionFlagsBits.KickMembers,ban_members:PermissionFlagsBits.BanMembers};

const flags=new Map(Object.entries(PermissionFlagsBits).map(([name,bit])=>[name.replace(/[A-Z]/g,(letter,index)=>(index?'_':'')+letter.toLowerCase()),bit]));

export function permissionApi():Value {
  return record({of:host((...names)=>{
    let bits=0n;
    for(const name of names){
      if(typeof name!=='string'||!flags.has(name))throw new WispError('DISCORD005',`Unknown Discord permission ${String(name)}`);
      bits|=flags.get(name)!;
    }
    return bits.toString();
  })}) as Value;
}
