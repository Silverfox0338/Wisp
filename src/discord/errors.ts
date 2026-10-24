/** Safe, actionable summaries for common Discord REST failures. */
export function explainDiscordError(status:number|null,code:number|string|null):string {
  switch(String(code)){
    case '50013':return 'The bot lacks a permission required for this action. Check its server and channel permissions, and make sure its highest role is above the target role or member.';
    case '50001':return 'The bot cannot access this resource. Check its channel visibility and whether it is still in the server.';
    case '50035':return 'Discord rejected one or more arguments. Check required fields, IDs, lengths, and allowed values.';
    case '10003':return 'Discord could not find that channel. Check the channel ID and whether it was deleted.';
    case '10007':return 'Discord could not find that member. Check the user ID and server membership.';
    case '10008':return 'Discord could not find that message. It may have been deleted.';
    case '20028':case '20029':return 'Discord is rate limiting this operation. Wait for the limit to reset before retrying.';
  }
  if(status===429)return 'Discord is rate limiting requests. Wait before retrying.';
  if(status===403)return 'Discord denied this action. Check bot permissions and role hierarchy.';
  if(status===400)return 'Discord rejected the request. Check the arguments sent to this API route.';
  if(status===401)return 'Discord rejected the bot token. Check the configured token.';
  if(status===404)return 'Discord could not find the requested resource. Check the ID and access permissions.';
  if(status!==null&&status>=500)return 'Discord had a server error. Try again later.';
  return 'Discord could not complete the request. Check the route, permissions, and arguments.';
}
