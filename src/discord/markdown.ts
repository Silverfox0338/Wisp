/** Discord markdown for transcripts. Everything is escaped first; only the tags added here reach the page. */
export interface MentionContext {
  user(id:string):{name:string;color:string|null}|null;
  channel(id:string):string|null;
  role(id:string):{name:string;color:string|null}|null;
  /** Returns an attribute-safe image source for a custom emoji. */
  emoji(id:string,animated:boolean):string;
}

const escapeKeepingSlots=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
/** Escapes text for HTML and drops NUL, which transcripts use to mark placeholders. */
export const escapeHtml=(value:string)=>escapeKeepingSlots(value.replace(/\0/g,''));
export const colorHex=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=0xffffff?`#${value.toString(16).padStart(6,'0')}`:null;

const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const pad=(value:number)=>String(value).padStart(2,'0');
/** A Discord <t:unix:style> timestamp, shown in UTC because a saved file has no viewer time zone. */
export function timestampText(seconds:number,style='f'):string{
  const date=new Date(seconds*1000);
  if(!Number.isFinite(date.getTime()))return 'unknown time';
  const time=`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,long=`${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  switch(style){
    case 't':return `${time} UTC`;
    case 'T':return `${time}:${pad(date.getUTCSeconds())} UTC`;
    case 'd':return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}`;
    case 'D':return long;
    case 'F':return `${days[date.getUTCDay()]}, ${long} ${time} UTC`;
    default:return `${long} ${time} UTC`;
  }
}

const mentionPatterns=/<@!?(\d{1,20})>|<@&(\d{1,20})>|<#(\d{1,20})>|<(a?):(\w{2,32}):(\d{1,20})>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>|<\/([\w -]{1,96}):\d{1,20}>|@(everyone|here)\b/g;
const roleStyle=(color:string|null)=>color?` style="color:${color};background:${color}26"`:'';

/** Mentions, custom emoji, and timestamps as plain text, for text transcripts and short previews. */
export function plainMentions(source:string,ctx:MentionContext):string{
  return source.replace(mentionPatterns,(raw,user,role,channel,_animated,emojiName,_emojiId,time,style,command,everyone)=>{
    if(user)return `@${ctx.user(user)?.name??'Unknown User'}`;
    if(role)return `@${ctx.role(role)?.name??'deleted-role'}`;
    if(channel)return `#${ctx.channel(channel)??'unknown'}`;
    if(emojiName)return `:${emojiName}:`;
    if(time)return timestampText(Number(time),style);
    if(command)return `/${command}`;
    if(everyone)return `@${everyone}`;
    return raw;
  });
}

const inline=(text:string)=>text
  .replace(/\|\|(.+?)\|\|/g,'<span class="spoiler" tabindex="0">$1</span>')
  .replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
  .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
  .replace(/__(.+?)__/g,'<u>$1</u>')
  .replace(/~~(.+?)~~/g,'<s>$1</s>')
  .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g,'$1<em>$2</em>')
  .replace(/(^|[^\w])_([^_]+?)_(?!\w)/g,'$1<em>$2</em>');

/** Message text as HTML: code, formatting, quotes, headings, lists, links, mentions, emoji, and timestamps. */
export function renderMarkdown(source:string,ctx:MentionContext):string{
  const slots:string[]=[];
  const hold=(html:string)=>`\0${slots.push(html)-1}\0`;
  let text=source.replace(/\0/g,'').replace(/\r\n?/g,'\n');
  text=text.replace(/```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g,(_,lang:string|undefined,code:string)=>hold(`<pre class="code"${lang?` data-lang="${escapeHtml(lang)}"`:''}><code>${escapeHtml(code.replace(/^\n|\n$/g,''))}</code></pre>`));
  text=text.replace(/``([^`]+?)``|`([^`\n]+?)`/g,(_,double:string|undefined,single:string|undefined)=>hold(`<code>${escapeHtml(double??single??'')}</code>`));
  text=text.replace(/\\([*_~|`>#\-[\]()\\:<@])/g,(_,char:string)=>hold(escapeHtml(char)));
  text=text.replace(mentionPatterns,(raw,user,role,channel,animated,emojiName,emojiId,time,style,command,everyone)=>{
    if(user){const found=ctx.user(user);return hold(`<span class="mention">@${escapeHtml(found?.name??'Unknown User')}</span>`);}
    if(role){const found=ctx.role(role);return hold(`<span class="mention"${roleStyle(found?.color??null)}>@${escapeHtml(found?.name??'deleted-role')}</span>`);}
    if(channel)return hold(`<span class="mention">#${escapeHtml(ctx.channel(channel)??'unknown')}</span>`);
    if(emojiName)return hold(`<img class="emoji" src="${ctx.emoji(emojiId,animated==='a')}" alt=":${escapeHtml(emojiName)}:" title=":${escapeHtml(emojiName)}:">`);
    if(time)return hold(`<span class="time">${escapeHtml(timestampText(Number(time),style))}</span>`);
    if(command)return hold(`<span class="mention">/${escapeHtml(command)}</span>`);
    if(everyone)return hold(`<span class="mention">@${everyone}</span>`);
    return raw;
  });
  text=escapeKeepingSlots(text);
  text=text.replace(/\[([^\]\n]{1,256})\]\((https?:\/\/[^\s)]{1,2048})\)/g,(_,label:string,url:string)=>hold(`<a href="${url}" rel="noopener noreferrer">${inline(label)}</a>`));
  text=text.replace(/&lt;(https?:\/\/[^\s]{1,2048}?)&gt;/g,(_,url:string)=>hold(`<a href="${url}" rel="noopener noreferrer">${url}</a>`));
  text=text.replace(/https?:\/\/[^\s\0]{1,2048}?(?=[.,:;!?)]*(?:\s|\0|$))/g,url=>hold(`<a href="${url}" rel="noopener noreferrer">${url}</a>`));
  const out:string[]=[];let quoteAll=false,quote:string[]=[],list:string[]=[],listTarget=out;
  const flushList=()=>{if(list.length){listTarget.push(`<ul>${list.join('')}</ul>`);list=[];}};
  const flushQuote=()=>{if(quote.length){out.push(`<blockquote>${quote.join('\n')}</blockquote>`);quote=[];}};
  for(let line of text.split('\n')){
    let quoted:boolean=quoteAll;
    if(!quoteAll&&line.startsWith('&gt;&gt;&gt; ')){quoteAll=quoted=true;line=line.slice(13);}
    else if(!quoted&&line.startsWith('&gt; ')){quoted=true;line=line.slice(5);}
    const target=quoted?quote:out;
    if(target!==listTarget)flushList();
    if(!quoted)flushQuote();
    const heading=/^(#{1,3}) (.+)$/.exec(line),sub=/^-# (.+)$/.exec(line),item=/^\s*[-*] (.+)$/.exec(line);
    if(item){listTarget=target;list.push(`<li>${inline(item[1]!)}</li>`);continue;}
    flushList();
    if(heading)target.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    else if(sub)target.push(`<small class="sub">${inline(sub[1]!)}</small>`);
    else target.push(inline(line));
  }
  flushList();flushQuote();
  let html=out.join('\n').replace(/\n?(<\/?(?:h[1-3]|ul|blockquote|small class="sub")[^>]*>|<\/small>)\n?/g,'$1');
  for(let pass=0;pass<4&&html.includes('\0');pass++)html=html.replace(/\0(\d+)\0/g,(_,index:string)=>slots[Number(index)]??'');
  return html;
}
