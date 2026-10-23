import {PermissionFlagsBits} from 'discord.js';
export const commandPermissions:Record<string,bigint>={administrator:PermissionFlagsBits.Administrator,manage_messages:PermissionFlagsBits.ManageMessages,manage_guild:PermissionFlagsBits.ManageGuild,kick_members:PermissionFlagsBits.KickMembers,ban_members:PermissionFlagsBits.BanMembers};
