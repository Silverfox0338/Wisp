import {WispError} from '../diagnostics.js';
import type {Value} from '../runtime/interpreter.js';
import {colorHex,escapeHtml,plainMentions,renderMarkdown,timestampText,type MentionContext} from './markdown.js';

export type DiscordCall=(method:string,path:string,body?:Value,query?:Value)=>Promise<unknown>;
export type ImageFetcher=(url:string)=>Promise<{type:string;data:Buffer}|null>;
export interface TranscriptSettings {format:'html'|'text';limit:number;name:string|null;title:string|null;images:'embed'|'link'}
export interface Transcript {name:string;text:string;format:'html'|'text';messages:number;channel:string|null}

export const transcriptKeys=['format','limit','name','title','images'];
export const imageHosts=new Set(['cdn.discordapp.com','media.discordapp.net']);
const imageBudget=8*1024*1024,imageLimit=4*1024*1024,memberLookups=50;
const fail=(message:string):never=>{throw new WispError('DISCORD005',message);};

export function transcriptSettings(input:Record<string,unknown>):TranscriptSettings{
  const format=input.format??'html',limit=input.limit??1000,title=input.title??null,name=input.name??null,images=input.images??'embed';
  if(format!=='html'&&format!=='text')fail('Transcript format must be "html" or "text"');
  if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>10000)fail('Transcript limit must be a whole number from 1 to 10000');
  if(title!==null&&(typeof title!=='string'||title.length>200))fail('Transcript title must be text of at most 200 characters');
  if(name!==null&&(typeof name!=='string'||!/^[\w][\w .-]{0,99}$/.test(name)))fail('Transcript name must be 1 to 100 letters, digits, spaces, dots, dashes, or underscores');
  if(images!=='embed'&&images!=='link')fail('Transcript images must be "embed" or "link"');
  return {format:format as TranscriptSettings['format'],limit:limit as number,title:title as string|null,name:name as string|null,images:images as TranscriptSettings['images']};
}

/** Downloads Discord CDN images for embedding; anything else, or anything too large, stays a link. */
export const discordImages:ImageFetcher=async url=>{
  if(!imageHosts.has(new URL(url).hostname))return null;
  const response=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'error'});
  const type=(response.headers.get('content-type')??'').split(';')[0]!.trim();
  if(!response.ok||!/^image\/(?:png|jpeg|gif|webp)$/.test(type)||Number(response.headers.get('content-length')??0)>imageLimit)return null;
  const data=Buffer.from(await response.arrayBuffer());
  return data.length>imageLimit?null:{type,data};
};

type Obj=Record<string,unknown>;
const obj=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const list=(value:unknown):Obj[]=>Array.isArray(value)?value.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)) as Obj[]:[];
const str=(value:unknown)=>typeof value==='string'?value:'';
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const https=(value:unknown)=>/^https:\/\/[^\s"'<>]+$/.test(str(value))?str(value):'';
const snowflake=(value:unknown)=>/^\d{1,20}$/.test(str(value))?str(value):'';
const timeOf=(message:Obj)=>{const time=Date.parse(str(message.timestamp));return Number.isFinite(time)?time:null;};
const stamp=(time:number|null)=>time===null?'unknown time':timestampText(time/1000);
const dayOf=(time:number|null)=>time===null?'':timestampText(time/1000,'D');
const size=(bytes:number|null)=>bytes===null?'':bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;
const normalTypes=new Set([0,19,20,21,23]);
/** One line of a replied-to message, without markdown symbols, like Discord's reply preview. */
const preview=(text:string)=>text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'$1').replace(/```[\w+#.-]*\n?|\*\*|__|~~|\|\||[*_`]|^>>> |^> |^#{1,3} |^-# /gm,'').replace(/\s+/g,' ').trim().slice(0,100);

export async function fetchHistory(call:DiscordCall,channelId:string,limit:number):Promise<Obj[]>{
  const messages:Obj[]=[];let before:string|null=null;
  while(messages.length<limit){
    const count=Math.min(100,limit-messages.length);
    const page=await call('GET',`/channels/${channelId}/messages`,null,{limit:count,...(before?{before}:{})});
    if(!Array.isArray(page)||!page.length)break;
    messages.push(...list(page));
    before=snowflake(obj(page[page.length-1]).id)||null;
    if(page.length<count||!before)break;
  }
  return messages.reverse();
}

interface Person {id:string;name:string;avatar:string;color:string|null;bot:boolean}

/** Server, channel, role, and member lookups. Each one is optional: a missing permission just gives plainer output. */
async function gather(call:DiscordCall,channelId:string,messages:Obj[]){
  const safe=async(path:string)=>{try{return await call('GET',path);}catch{return null;}};
  const channel=obj(await safe(`/channels/${channelId}`)),guildId=snowflake(channel.guild_id);
  const members=new Map<string,Obj>();let guild:Obj={},roles:Obj[]=[],channels:Obj[]=[];
  if(guildId){
    [guild,roles,channels]=await Promise.all([safe(`/guilds/${guildId}`).then(obj),safe(`/guilds/${guildId}/roles`).then(list),safe(`/guilds/${guildId}/channels`).then(list)]);
    const authors=[...new Set(messages.filter(message=>!message.webhook_id).map(message=>snowflake(obj(message.author).id)).filter(Boolean))].slice(0,memberLookups);
    for(let index=0;index<authors.length;index+=5)await Promise.all(authors.slice(index,index+5).map(async id=>{const member=await safe(`/guilds/${guildId}/members/${id}`);if(member)members.set(id,obj(member));}));
  }
  return {channel,guildId,guild,roles,channels,members};
}

export async function buildTranscript(call:DiscordCall,channelId:string,settings:TranscriptSettings,fetchImage:ImageFetcher|null):Promise<Transcript>{
  const messages=await fetchHistory(call,channelId,settings.limit);
  const info=await gather(call,channelId,messages);
  const channelName=str(info.channel.name)||null;
  const title=settings.title??(channelName?`Transcript of #${channelName}`:'Transcript');
  const name=settings.name??`transcript-${channelId}.${settings.format==='html'?'html':'txt'}`;

  const roles=new Map(info.roles.map(role=>[str(role.id),{name:str(role.name),color:colorHex(role.color),position:num(role.position)??0}]));
  const channelNames=new Map(info.channels.map(channel=>[str(channel.id),str(channel.name)]));
  const users=new Map<string,Obj>();
  for(const message of messages){
    for(const user of [obj(message.author),...list(message.mentions),obj(obj(message.referenced_message).author),obj(obj(message.interaction).user)])if(snowflake(user.id)&&!users.has(str(user.id)))users.set(str(user.id),user);
  }
  const people=new Map<string,Person>();
  const person=(id:string,fallback:Obj={}):Person=>{
    const cached=people.get(id);if(cached)return cached;
    const user={...fallback,...obj(users.get(id))},member=obj(info.members.get(id));
    const colored=(Array.isArray(member.roles)?member.roles:[]).map(role=>roles.get(str(role))).filter(role=>role?.color).sort((a,b)=>b!.position-a!.position)[0];
    const memberAvatar=str(member.avatar),userAvatar=str(user.avatar),discriminator=str(user.discriminator);
    const avatar=memberAvatar&&info.guildId?`https://cdn.discordapp.com/guilds/${info.guildId}/users/${id}/avatars/${memberAvatar}.png?size=64`
      :userAvatar?`https://cdn.discordapp.com/avatars/${id}/${userAvatar}.png?size=64`
      :`https://cdn.discordapp.com/embed/avatars/${discriminator&&discriminator!=='0'?Number(discriminator)%5:/^\d+$/.test(id)?Number((BigInt(id)>>22n)%6n):0}.png`;
    const found={id,name:str(member.nick)||str(user.global_name)||str(user.username)||'Unknown User',avatar,color:colored?.color??null,bot:user.bot===true};
    people.set(id,found);return found;
  };
  const authorOf=(message:Obj)=>{const author=obj(message.author);return person(snowflake(author.id)||`unknown:${str(author.username)}`,author);};

  const images:{url:string;priority:number}[]=[],imageIndex=new Map<string,number>();
  const image=(url:string,priority=1)=>{
    if(!https(url))return '';
    let index=imageIndex.get(url);
    if(index===undefined){index=images.push({url,priority})-1;imageIndex.set(url,index);}else images[index]!.priority=Math.min(images[index]!.priority,priority);
    return `\0img${index}\0`;
  };
  const emojiUrl=(id:string,animated:boolean)=>`https://cdn.discordapp.com/emojis/${id}.${animated?'gif':'png'}?size=48`;
  const mentions:MentionContext={
    user:id=>{
      if(!users.has(id)&&!info.members.has(id))return null;
      const found=person(id,obj(obj(info.members.get(id)).user));
      return {name:found.name,color:found.color};
    },
    channel:id=>channelNames.get(id)??(id===channelId?channelName:null),
    role:id=>roles.get(id)??null,
    emoji:(id,animated)=>image(emojiUrl(id,animated),0)
  };
  const counts=new Map<string,number>();
  for(const message of messages){const id=authorOf(message).id;counts.set(id,(counts.get(id)??0)+1);}
  const participants=[...counts].map(([id,count])=>({person:person(id),count})).sort((a,b)=>b.count-a.count||a.person.name.localeCompare(b.person.name));
  const firstTime=messages.length?timeOf(messages[0]!):null,lastTime=messages.length?timeOf(messages[messages.length-1]!):null;
  const saved=stamp(Date.now());

  if(settings.format==='text'){
    const lines=[title];
    if(str(info.guild.name))lines.push(`Server: ${str(info.guild.name)}`);
    lines.push(`Channel: ${channelName?`#${channelName} `:''}(${channelId})`,`${messages.length} messages${messages.length?`, ${stamp(firstTime)} to ${stamp(lastTime)}`:''}, saved ${saved}`);
    if(participants.length)lines.push(`Participants: ${participants.map(item=>`${item.person.name} (${item.count})`).join(', ')}`);
    lines.push('');
    for(const message of messages)lines.push(...textMessage(message,authorOf(message),mentions,id=>person(id)));
    return {name,text:`${lines.join('\n')}\n`,format:'text',messages:messages.length,channel:channelName};
  }

  const md=(text:string)=>renderMarkdown(text,mentions);
  const picture=(url:string,className:string,alt='',priority=1)=>{const src=image(url,priority);return src?`<img class="${className}" src="${src}" alt="${escapeHtml(alt)}" loading="lazy">`:'';};
  const urlOf=(item:Obj,prefix='')=>https(item[`proxy_${prefix}url`])||https(item[`${prefix}url`]);
  const nameTag=(who:Person)=>`<span class="name"${who.color?` style="color:${who.color}"`:''}>${escapeHtml(who.name)}</span>${who.bot?'<span class="tag">APP</span>':''}`;

  const renderEmbed=(embed:Obj)=>{
    const thumb=obj(embed.thumbnail),pic=obj(embed.image),author=obj(embed.author),footer=obj(embed.footer),type=str(embed.type);
    if((type==='image'||type==='gifv')&&urlOf(thumb))return `<div class="media">${picture(urlOf(thumb),'attachment')}</div>`;
    const parts:string[]=[],color=colorHex(embed.color),link=https(embed.url),time=Date.parse(str(embed.timestamp));
    if(str(author.name))parts.push(`<div class="e-author">${picture(urlOf(author,'icon_'),'e-icon')}${https(author.url)?`<a href="${escapeHtml(https(author.url))}" rel="noopener noreferrer">${escapeHtml(str(author.name))}</a>`:escapeHtml(str(author.name))}</div>`);
    if(str(embed.title))parts.push(`<div class="e-title">${link?`<a href="${escapeHtml(link)}" rel="noopener noreferrer">${md(str(embed.title))}</a>`:md(str(embed.title))}</div>`);
    if(str(embed.description))parts.push(`<div class="e-desc">${md(str(embed.description))}</div>`);
    const fields=list(embed.fields);
    if(fields.length)parts.push(`<div class="e-fields">${fields.map(field=>`<div class="e-field${field.inline===true?' inline':''}"><div class="e-fname">${md(str(field.name))}</div><div class="e-fvalue">${md(str(field.value))}</div></div>`).join('')}</div>`);
    if(urlOf(pic))parts.push(`<div class="e-image">${picture(urlOf(pic),'attachment')}</div>`);
    if(str(footer.text)||Number.isFinite(time))parts.push(`<div class="e-footer">${picture(urlOf(footer,'icon_'),'e-icon')}${escapeHtml(str(footer.text))}${str(footer.text)&&Number.isFinite(time)?' • ':''}${Number.isFinite(time)?stamp(time):''}</div>`);
    const side=urlOf(thumb)?`<div class="e-thumb">${picture(urlOf(thumb),'thumb')}</div>`:'';
    return parts.length||side?`<div class="embed"${color?` style="border-left-color:${color}"`:''}><div class="e-main">${parts.join('')}</div>${side}</div>`:'';
  };
  const renderAttachment=(file:Obj)=>{
    const fileName=str(file.filename)||'file',type=str(file.content_type),link=https(file.url),view=https(file.proxy_url)||link;
    if(type.startsWith('image/')&&view)return `<a class="att-image" href="${escapeHtml(link||view)}" rel="noopener noreferrer">${picture(view,'attachment',fileName)}</a>`;
    const body=`<span class="file-icon">${type.startsWith('video/')?'▶':type.startsWith('audio/')?'♪':'📄'}</span><span class="file-name">${escapeHtml(fileName)}</span><small>${size(num(file.size))}</small>`;
    return link?`<a class="file" href="${escapeHtml(link)}" rel="noopener noreferrer">${body}</a>`:`<span class="file">${body}</span>`;
  };
  const emojiFace=(emoji:Obj)=>snowflake(emoji.id)?picture(emojiUrl(str(emoji.id),emoji.animated===true),'emoji',`:${str(emoji.name)}:`,0):escapeHtml(str(emoji.name));
  const renderComponents=(items:Obj[]):string=>items.map(item=>{
    switch(num(item.type)){
      case 1:return `<div class="row">${renderComponents(list(item.components))}</div>`;
      case 2:{const style=num(item.style)??2;return `<span class="button ${['','primary','secondary','success','danger','link','premium'][style]??'secondary'}">${emojiFace(obj(item.emoji))}${escapeHtml(str(item.label))}${style===5?' ↗':''}</span>`;}
      case 3:case 5:case 6:case 7:case 8:return `<span class="select">${escapeHtml(str(item.placeholder)||'Make a selection')} ▾</span>`;
      case 9:return `<div class="section"><div>${renderComponents(list(item.components))}</div>${item.accessory?renderComponents([obj(item.accessory)]):''}</div>`;
      case 10:return `<div class="text-display">${md(str(item.content))}</div>`;
      case 11:return picture(urlOf(obj(item.media)),'thumb');
      case 12:return `<div class="gallery">${list(item.items).map(entry=>picture(urlOf(obj(entry.media)),'attachment')).join('')}</div>`;
      case 13:return `<span class="file"><span class="file-icon">📄</span><span class="file-name">${escapeHtml(str(item.name)||str(obj(item.file).url).split('/').pop()||'file')}</span></span>`;
      case 14:return item.divider===false?'<div class="spacer"></div>':'<hr>';
      case 17:{const color=colorHex(item.accent_color);return `<div class="container"${color?` style="border-left-color:${color}"`:''}>${renderComponents(list(item.components))}</div>`;}
      default:return '';
    }
  }).join('');
  const renderPoll=(poll:Obj)=>{
    const totals=new Map(list(obj(poll.results).answer_counts).map(count=>[num(count.id),num(count.count)??0]));
    const answers=list(poll.answers).map(answer=>{const media=obj(answer.poll_media);return `<li>${emojiFace(obj(media.emoji))} ${escapeHtml(str(media.text))}<span class="votes">${totals.get(num(answer.answer_id))??0}</span></li>`;}).join('');
    return `<div class="poll"><strong>${escapeHtml(str(obj(poll.question).text))}</strong><ul>${answers}</ul></div>`;
  };

  const rows:string[]=[];let previous:{author:string;time:number|null;system:boolean}|null=null,day='';
  for(const message of messages){
    const who=authorOf(message),time=timeOf(message),type=num(message.type)??0,system=!normalTypes.has(type);
    const today=dayOf(time);
    if(today&&today!==day){rows.push(`<div class="day"><span>${today}</span></div>`);day=today;previous=null;}
    const id=snowflake(message.id);
    if(system){
      rows.push(`<div class="system" id="m-${id}"><span class="sys-icon">${type===7?'→':type===6?'📌':type>=8&&type<=11?'◆':'•'}</span>${nameTag(who)} ${escapeHtml(systemText(type,plainMentions(str(message.content),mentions)))}<time>${stamp(time)}</time></div>`);
      previous={author:who.id,time,system:true};continue;
    }
    const replied=obj(message.referenced_message),reference=obj(message.message_reference),interaction=obj(message.interaction);
    let above='';
    if(snowflake(replied.id)){
      const target=person(snowflake(obj(replied.author).id)||'0',obj(replied.author)),snippet=preview(plainMentions(str(replied.content),mentions))||(list(replied.attachments).length?'Click to see attachment':'Click to see message');
      above=`<a class="reply" href="#m-${snowflake(replied.id)}">${picture(target.avatar,'reply-avatar','',0)}${nameTag(target)}<span>${escapeHtml(snippet)}</span></a>`;
    }else if(type===19||snowflake(reference.message_id)&&type!==21)above='<div class="reply"><span>Original message was deleted</span></div>';
    else if(str(interaction.name)){const user=person(snowflake(obj(interaction.user).id)||'0',obj(interaction.user));above=`<div class="reply">${picture(user.avatar,'reply-avatar','',0)}${nameTag(user)}<span>used <span class="mention">/${escapeHtml(str(interaction.name))}</span></span></div>`;}
    const grouped=!above&&previous!==null&&!previous.system&&previous.author===who.id&&time!==null&&previous.time!==null&&time-previous.time<7*60000;
    const content=str(message.content);
    const body:string[]=[];
    if(content||message.edited_timestamp)body.push(`<div class="content">${md(content)}${message.edited_timestamp?' <span class="edited">(edited)</span>':''}</div>`);
    body.push(...list(message.embeds).map(renderEmbed));
    const files=list(message.attachments);if(files.length)body.push(`<div class="attachments">${files.map(renderAttachment).join('')}</div>`);
    for(const sticker of list(message.sticker_items))body.push(num(sticker.format_type)===3||!snowflake(sticker.id)?`<div class="sticker-name">Sticker: ${escapeHtml(str(sticker.name))}</div>`:picture(`https://media.discordapp.net/stickers/${str(sticker.id)}.${num(sticker.format_type)===4?'gif':'png'}?size=160`,'sticker',str(sticker.name)));
    if(message.poll)body.push(renderPoll(obj(message.poll)));
    const components=list(message.components);if(components.length)body.push(`<div class="components">${renderComponents(components)}</div>`);
    const thread=obj(message.thread);if(str(thread.name))body.push(`<div class="thread"># ${escapeHtml(str(thread.name))} <small>${num(thread.message_count)??0} messages</small></div>`);
    const reactions=list(message.reactions);if(reactions.length)body.push(`<div class="reactions">${reactions.map(reaction=>`<span class="reaction">${emojiFace(obj(reaction.emoji))} ${num(reaction.count)??0}</span>`).join('')}</div>`);
    rows.push(grouped
      ?`<div class="msg cont" id="m-${id}"><time class="side">${time===null?'':timestampText(time/1000,'t').replace(' UTC','')}</time><div class="body">${body.join('')}</div></div>`
      :`<div class="msg" id="m-${id}">${above}<div class="line">${picture(who.avatar,'avatar','',0)}<div class="body"><div class="meta">${nameTag(who)}<time>${stamp(time)}</time></div>${body.join('')}</div></div></div>`);
    previous={author:who.id,time,system:false};
  }

  const guildIcon=str(info.guild.icon)&&info.guildId?picture(`https://cdn.discordapp.com/icons/${info.guildId}/${str(info.guild.icon)}.png?size=96`,'guild-icon','',0):'';
  const guildName=str(info.guild.name);
  const header=`<header class="top">${guildIcon||`<div class="guild-icon initials">${escapeHtml((guildName||channelName||'#').slice(0,2))}</div>`}<div><h1>${escapeHtml(title)}</h1><p class="where">${guildName?`${escapeHtml(guildName)} · `:''}${channelName?`#${escapeHtml(channelName)}`:escapeHtml(channelId)}</p>${str(info.channel.topic)?`<div class="topic">${md(str(info.channel.topic))}</div>`:''}<p class="stats">${messages.length} messages${messages.length?` · ${stamp(firstTime)} to ${stamp(lastTime)}`:''} · saved ${saved}</p>\0linknote\0</div></header>`;
  const who=participants.length?`<section class="people"><h2>Participants (${participants.length})</h2><ul>${participants.map(item=>`<li>${picture(item.person.avatar,'avatar small','',0)}${nameTag(item.person)}<span class="count">${item.count}</span></li>`).join('')}</ul></section>`:'';
  let html=`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${header}${who}<main>\n${rows.join('\n')}\n</main></body></html>\n`;

  const sources=new Map<number,string>();let linked=0;
  if(settings.images==='embed'&&fetchImage){
    let spent=0;
    const order=images.map((item,index)=>({...item,index})).sort((a,b)=>a.priority-b.priority||a.index-b.index);
    for(let start=0;start<order.length;start+=6){
      const batch=order.slice(start,start+6);
      const loaded=await Promise.all(batch.map(item=>imageHosts.has(new URL(item.url).hostname)?fetchImage(item.url).catch(()=>null):Promise.resolve(null)));
      batch.forEach((item,position)=>{const file=loaded[position];if(!file)return;const uri=`data:${file.type};base64,${file.data.toString('base64')}`;if(spent+uri.length>imageBudget)return;spent+=uri.length;sources.set(item.index,uri);});
    }
    linked=images.filter((item,index)=>!sources.has(index)&&imageHosts.has(new URL(item.url).hostname)).length;
  }
  html=html.replace(/\0img(\d+)\0/g,(_,index:string)=>sources.get(Number(index))??escapeHtml(images[Number(index)]!.url));
  html=html.replace('\0linknote\0',linked?`<p class="note">${linked} ${linked===1?'image was':'images were'} kept as links; they stop working when Discord's links expire.</p>`:'');
  return {name,text:html,format:'html',messages:messages.length,channel:channelName};
}

function systemText(type:number,content:string):string{
  switch(type){
    case 1:return 'added someone to the group.';
    case 2:return 'removed someone from the group.';
    case 3:return 'started a call.';
    case 4:return `changed the channel name: ${content}`;
    case 5:return 'changed the channel icon.';
    case 6:return 'pinned a message to this channel.';
    case 7:return 'joined the server.';
    case 8:return content?`boosted the server ${content} times!`:'boosted the server!';
    case 9:case 10:case 11:return `boosted the server. It reached level ${type-8}!`;
    case 12:return `added ${content} to this channel.`;
    case 18:return `started a thread: ${content}`;
    case 24:return 'AutoMod acted on a message.';
    case 46:return 'A poll ended.';
    default:return content?`system message: ${content}`:'system message.';
  }
}

function textMessage(message:Obj,who:Person,mentions:MentionContext,person:(id:string)=>Person):string[]{
  const time=stamp(timeOf(message)),type=num(message.type)??0,plain=(text:string)=>plainMentions(text,mentions);
  if(!normalTypes.has(type))return [`[${time}] -- ${who.name} ${systemText(type,plain(str(message.content)))} --`];
  const lines:string[]=[],replied=obj(message.referenced_message);
  if(snowflake(replied.id))lines.push(`  ↪ replying to ${person(snowflake(obj(replied.author).id)||'0').name}: ${preview(plain(str(replied.content)))}`);
  else if(str(obj(message.interaction).name))lines.push(`  ↪ ${person(snowflake(obj(obj(message.interaction).user).id)||'0').name} used /${str(obj(message.interaction).name)}`);
  lines.push(`[${time}] ${who.name}${who.bot?' [bot]':''}: ${plain(str(message.content)).replace(/\n/g,'\n    ')}${message.edited_timestamp?' (edited)':''}`);
  for(const embed of list(message.embeds)){
    const head=[str(embed.title),str(embed.description)].filter(Boolean).map(plain).join(' - ');
    if(head)lines.push(`    embed: ${head}`);
    for(const field of list(embed.fields))lines.push(`    ${plain(str(field.name))}: ${plain(str(field.value))}`);
    if(str(obj(embed.footer).text))lines.push(`    footer: ${str(obj(embed.footer).text)}`);
  }
  const texts=(items:Obj[]):string[]=>items.flatMap(item=>num(item.type)===10?[plain(str(item.content))]:texts([...list(item.components),...(item.accessory?[obj(item.accessory)]:[])]));
  for(const text of texts(list(message.components)))lines.push(`    | ${text.replace(/\n/g,'\n    | ')}`);
  const labels=(items:Obj[]):string[]=>items.flatMap(item=>num(item.type)===2?[`[${str(item.label)||str(obj(item.emoji).name)}]`]:labels(list(item.components)));
  const buttons=labels(list(message.components));if(buttons.length)lines.push(`    buttons: ${buttons.join(' ')}`);
  for(const sticker of list(message.sticker_items))lines.push(`    sticker: ${str(sticker.name)}`);
  if(message.poll){
    const poll=obj(message.poll),totals=new Map(list(obj(poll.results).answer_counts).map(count=>[num(count.id),num(count.count)??0]));
    lines.push(`    poll: ${str(obj(poll.question).text)} - ${list(poll.answers).map(answer=>`${str(obj(answer.poll_media).text)} (${totals.get(num(answer.answer_id))??0})`).join(', ')}`);
  }
  for(const file of list(message.attachments))lines.push(`    attachment: ${str(file.filename)||'file'}${https(file.url)?` ${https(file.url)}`:''}`);
  if(str(obj(message.thread).name))lines.push(`    thread: ${str(obj(message.thread).name)} (${num(obj(message.thread).message_count)??0} messages)`);
  const reactions=list(message.reactions);
  if(reactions.length)lines.push(`    reactions: ${reactions.map(reaction=>{const emoji=obj(reaction.emoji);return `${snowflake(emoji.id)?`:${str(emoji.name)}:`:str(emoji.name)} ${num(reaction.count)??0}`;}).join(', ')}`);
  return lines;
}

const style=[
  ':root{color-scheme:light dark;--bg:#ffffff;--panel:#f2f3f5;--text:#313338;--muted:#5c5e66;--line:#e3e5e8;--link:#006ce7;--mention:#505cdc;--mention-bg:rgba(88,101,242,.15);--code:#f2f3f5;--embed:#f2f3f5;--accent:#5865f2}',
  '@media (prefers-color-scheme:dark){:root{--bg:#313338;--panel:#2b2d31;--text:#dbdee1;--muted:#949ba4;--line:#3f4147;--link:#00a8fc;--mention:#c9cdfb;--mention-bg:rgba(88,101,242,.3);--code:#2b2d31;--embed:#2b2d31}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.375 "gg sans","Noto Sans",system-ui,-apple-system,"Segoe UI",sans-serif}',
  'a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}',
  '.top{display:flex;gap:16px;align-items:center;padding:20px 16px;background:var(--panel);border-bottom:1px solid var(--line)}.top>div{min-width:0}',
  '.guild-icon{width:64px;height:64px;border-radius:50%;flex:none;object-fit:cover}.initials{display:grid;place-items:center;background:var(--accent);color:#fff;font-weight:700;font-size:22px}',
  'h1{margin:0;font-size:22px}.where{margin:2px 0;font-weight:600}.topic,.stats,.note{margin:4px 0 0;color:var(--muted);font-size:14px}.note{color:#f0b232}',
  '.people{padding:12px 16px;border-bottom:1px solid var(--line)}.people h2{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.02em;color:var(--muted)}',
  '.people ul{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;padding:0;list-style:none}.people li{display:flex;align-items:center;gap:6px;font-size:14px}.count{color:var(--muted)}',
  'main{padding:8px 0 24px}.day{display:flex;align-items:center;margin:16px 16px 8px;color:var(--muted);font-size:12px;font-weight:600}.day::before,.day::after{content:"";flex:1;border-top:1px solid var(--line)}.day span{padding:0 8px}',
  '.msg{padding:2px 16px 2px 16px;margin-top:14px}.msg.cont{margin-top:0;display:flex}.msg:hover{background:rgba(127,127,127,.06)}',
  '.line{display:flex;gap:16px}.avatar{width:40px;height:40px;border-radius:50%;flex:none;object-fit:cover}.avatar.small{width:22px;height:22px}',
  '.side{width:40px;flex:none;margin-right:16px;color:transparent;font-size:11px;text-align:right;padding-top:3px}.msg.cont:hover .side{color:var(--muted)}',
  '.body{min-width:0;flex:1}.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}.name{font-weight:600}',
  '.tag{background:var(--accent);color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600;line-height:15px;align-self:center}',
  'time{color:var(--muted);font-size:12px}.edited{color:var(--muted);font-size:10px}',
  '.content{white-space:pre-wrap;overflow-wrap:anywhere}.content h1,.content h2,.content h3{margin:8px 0 0;line-height:1.3}.content h1{font-size:24px}.content h2{font-size:20px}.content h3{font-size:16px}',
  '.sub{display:block;color:var(--muted);font-size:12px}.content ul{margin:4px 0;padding-left:20px;white-space:normal}',
  'blockquote{margin:0;padding:0 8px 0 12px;border-left:4px solid var(--line)}',
  'code{background:var(--code);border-radius:4px;padding:0 3px;font:85% Consolas,"Andale Mono",monospace}pre.code{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:8px;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}pre.code code{padding:0;background:none}',
  '.mention{background:var(--mention-bg);color:var(--mention);border-radius:3px;padding:0 2px;font-weight:500}.time{background:rgba(127,127,127,.15);border-radius:3px;padding:0 2px}',
  '.spoiler{background:#1e1f22;color:transparent;border-radius:3px;cursor:pointer}.spoiler:focus,.spoiler:active{background:rgba(127,127,127,.25);color:inherit}.spoiler img{visibility:hidden}.spoiler:focus img{visibility:visible}',
  '.emoji{width:22px;height:22px;vertical-align:-5px;object-fit:contain}',
  '.reply{display:flex;align-items:center;gap:4px;margin:0 0 4px 56px;color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden}.reply>span:last-child{overflow:hidden;text-overflow:ellipsis}.reply-avatar{width:16px;height:16px;border-radius:50%}.reply .name{font-size:14px}',
  '.embed{display:flex;gap:16px;max-width:520px;margin:4px 0;padding:8px 16px 12px 12px;background:var(--embed);border-left:4px solid var(--line);border-radius:4px}.e-main{min-width:0;flex:1}',
  '.e-author{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:14px;font-weight:600}.e-icon{width:24px;height:24px;border-radius:50%}',
  '.e-title{margin-top:6px;font-weight:600}.e-desc{margin-top:6px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.e-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}.e-field{grid-column:1/-1;font-size:14px}.e-field.inline{grid-column:auto}.e-fname{font-weight:600}.e-fvalue{white-space:pre-wrap;overflow-wrap:anywhere}',
  '.e-image img,.attachment{display:block;max-width:100%;max-height:350px;border-radius:4px;margin-top:8px}.e-thumb .thumb{max-width:80px;max-height:80px;border-radius:4px}',
  '.e-footer{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--muted);font-size:12px}.e-footer .e-icon{width:20px;height:20px}',
  '.attachments{display:flex;flex-direction:column;align-items:flex-start;gap:4px}.att-image .attachment{max-width:min(400px,100%)}',
  '.file{display:inline-flex;align-items:center;gap:8px;max-width:100%;margin-top:4px;padding:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file small{color:var(--muted)}',
  '.sticker{width:160px;height:160px;object-fit:contain;margin-top:4px}.sticker-name{color:var(--muted);font-style:italic}',
  '.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.reaction{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;background:var(--panel);border:1px solid var(--line);border-radius:8px;font-size:14px}.reaction .emoji{width:16px;height:16px}',
  '.poll{max-width:440px;margin-top:4px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.poll ul{margin:8px 0 0;padding:0;list-style:none}.poll li{display:flex;gap:6px;padding:6px 8px;margin-top:4px;border:1px solid var(--line);border-radius:6px}.votes{margin-left:auto;color:var(--muted)}',
  '.thread{display:inline-block;margin-top:4px;padding:6px 10px;background:var(--panel);border-radius:6px;font-weight:600}.thread small{color:var(--muted);font-weight:400}',
  '.components{margin-top:4px}.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}.button{display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:2px 16px;border-radius:8px;color:#fff;font-size:14px;font-weight:500;opacity:.85}',
  '.button.primary{background:#5865f2}.button.secondary,.button.link{background:#4e5058}.button.success{background:#248046}.button.danger{background:#da373c}.button.premium{background:#5865f2}',
  '.select{display:inline-block;min-width:200px;padding:8px 12px;background:var(--panel);border:1px solid var(--line);border-radius:4px;color:var(--muted)}',
  '.container{max-width:520px;margin-top:4px;padding:12px 16px;background:var(--embed);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px}.section{display:flex;gap:12px;justify-content:space-between}.text-display{white-space:pre-wrap;overflow-wrap:anywhere}',
  '.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:4px}.thumb{max-width:85px;max-height:85px;border-radius:8px}hr{border:0;border-top:1px solid var(--line)}.spacer{height:8px}',
  '.system{position:relative;margin-top:14px;padding:2px 16px 2px 72px;color:var(--muted);font-size:15px}.system time{margin-left:6px}.sys-icon{position:absolute;left:16px;width:40px;text-align:center;color:#23a55a}',
  '@media (max-width:480px){.line{gap:10px}.avatar{width:32px;height:32px}.side{width:32px;margin-right:10px}.reply{margin-left:42px}.system{padding-left:58px}.sys-icon{width:32px}.e-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.embed{padding-right:10px}}'
].join('');
