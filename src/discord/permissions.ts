import {PermissionFlagsBits} from 'discord.js';
import {WispError} from '../diagnostics.js';
import {host,record,type Value} from '../runtime/interpreter.js';
export const commandPermissions:Record<string,bigint>={administrator:PermissionFlagsBits.Administrator,manage_messages:PermissionFlagsBits.ManageMessages,manage_guild:PermissionFlagsBits.ManageGuild,kick_members:PermissionFlagsBits.KickMembers,ban_members:PermissionFlagsBits.BanMembers};

const flags=new Map(Object.entries(PermissionFlagsBits).map(([name,bit])=>[name.replace(/[A-Z]/g,(letter,index)=>(index?'_':'')+letter.toLowerCase()),bit]));
export const permissionNames=[...flags.keys()].sort();
function bit(name:Value):bigint{if(typeof name!=='string'||!flags.has(name))throw new WispError('DISCORD005',`Unknown Discord permission ${String(name)}`);return flags.get(name)!;}
function memberBits(subject:Value):bigint{
  const value=typeof subject==='string'?subject:subject&&typeof subject==='object'&&!Array.isArray(subject)?(subject as Record<string,unknown>).permissions:null;
  if(typeof value!=='string'||!/^\d+$/.test(value))throw new WispError('DISCORD005','Permission check requires a member with permissions or a decimal bitfield string');
  return BigInt(value);
}
function position(subject:Value):number{
  const value=typeof subject==='number'?subject:subject&&typeof subject==='object'&&!Array.isArray(subject)?(subject as Record<string,unknown>).highestRolePosition??(subject as Record<string,unknown>).position:null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new WispError('DISCORD005','Hierarchy check requires a role position or member highestRolePosition');
  return value;
}

export function permissionApi():Value {
  return record({of:host((...names)=>{
    let bits=0n;
    for(const name of names){
      bits|=bit(name);
    }
    return bits.toString();
  }),has:host((subject,...names)=>{const bits=memberBits(subject),required=names.map(bit);return required.every(flag=>(bits&PermissionFlagsBits.Administrator)!==0n||(bits&flag)===flag);}),above:host((actor,target)=>position(actor)>position(target)),canManageRole:host((actor,role)=>{const bits=memberBits(actor);return ((bits&PermissionFlagsBits.Administrator)!==0n||(bits&PermissionFlagsBits.ManageRoles)!==0n)&&position(actor)>position(role);})}) as Value;
}
