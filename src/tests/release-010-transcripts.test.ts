import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'discord.js';
import {discordApi} from '../discord/api.js';
import {renderMarkdown,plainMentions,type MentionContext} from '../discord/markdown.js';
import type {ImageFetcher} from '../discord/transcript.js';
import type {HostFunction} from '../runtime/interpreter.js';

const C='111111111111111111',G='222222222222222222',U1='333333333333333333',U2='444444444444444444',U3='555555555555555555',R1='666666666666666666',CH2='777777777777777777';
const at=(minute:number,second=0)=>new Date(Date.UTC(2026,9,27,14,minute,second)).toISOString();
const kuro={id:U1,username:'kuro',global_name:'Kuro',avatar:'abc123'},helper={id:U2,username:'helper',global_name:'Helper'},ticketBot={id:U3,username:'ticketbot',bot:true};
/** Oldest first; the fake API serves it newest first like Discord. */
export function sampleMessages(){
  const greeting={id:'1002',type:0,content:`**Hello** <@${U2}>, see <#${CH2}> and <@&${R1}> <:fox:888888888888888888> ||secret|| \`code\` [site](https://example.com) [bad](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror=alert(1)>`,timestamp:at(1),author:kuro,mentions:[helper],reactions:[{emoji:{name:'👍'},count:3},{emoji:{id:'888888888888888888',name:'fox'},count:1}]};
  return [
    {id:'1001',type:7,content:'',timestamp:at(0),author:helper},
    greeting,
    {id:'1003',type:0,content:'second line',timestamp:at(1,30),author:kuro,edited_timestamp:at(2)},
    {id:'1004',type:19,content:'>>> quoted\nmore',timestamp:at(3),author:helper,message_reference:{message_id:'1002'},referenced_message:greeting,attachments:[{filename:'shot.png',content_type:'image/png',url:'https://cdn.discordapp.com/attachments/1/2/shot.png',proxy_url:'https://media.discordapp.net/attachments/1/2/shot.png',size:2048},{filename:'notes.pdf',content_type:'application/pdf',url:'https://cdn.discordapp.com/attachments/1/3/notes.pdf',size:3145728}]},
    {id:'1005',type:20,content:'',timestamp:at(4),author:ticketBot,interaction:{name:'ticket',user:kuro},embeds:[{title:'Ticket',url:'https://example.com/t',color:0x5865f2,author:{name:'Support',icon_url:'https://cdn.discordapp.com/a.png'},description:'Use the buttons',fields:[{name:'Status',value:'Open',inline:true},{name:'Priority',value:'High',inline:true},{name:'Notes',value:'Long text'}],image:{url:'https://evil.example/track.png'},footer:{text:'Ticket bot'},timestamp:at(4)}],components:[{type:1,components:[{type:2,style:4,label:'Close'},{type:2,style:5,label:'Docs',url:'https://example.com/docs'}]}]},
    {id:'1006',type:6,content:'',timestamp:at(5),author:kuro},
    {id:'1007',type:0,content:'vote please',timestamp:at(6),author:kuro,poll:{question:{text:'Fix it?'},answers:[{answer_id:1,poll_media:{text:'Yes'}},{answer_id:2,poll_media:{text:'No'}}],results:{answer_counts:[{id:1,count:4}]}},thread:{name:'follow-up',message_count:3},sticker_items:[{id:'999999999999999999',name:'wave',format_type:1}]},
    {id:'1008',type:0,content:'',flags:32768,timestamp:at(20),author:ticketBot,components:[{type:17,accent_color:0x23a55a,components:[{type:10,content:'## Status\nAll good'},{type:14},{type:9,components:[{type:10,content:'Side note'}],accessory:{type:11,media:{url:'https://cdn.discordapp.com/t.png'}}}]}]}
  ];
}
export function sampleClient(messages=sampleMessages()){
  const calls:{method:string;route:string;files:string[]}[]=[];
  const routes:Record<string,unknown>={
    [`/channels/${C}`]:{id:C,name:'ticket-0042',topic:'Help with **billing**',guild_id:G},
    [`/guilds/${G}`]:{id:G,name:'Fox Den',icon:'iconhash'},
    [`/guilds/${G}/roles`]:[{id:R1,name:'Mod',color:0xe91e63,position:5},{id:'1',name:'Member',color:0,position:1}],
    [`/guilds/${G}/channels`]:[{id:CH2,name:'rules'}],
    [`/guilds/${G}/members/${U1}`]:{nick:'Kuro the Fox',roles:[R1],user:kuro}
  };
  const client={rest:{request:async(input:{method:string;fullRoute:string;query?:URLSearchParams;files?:{name:string}[]})=>{
    calls.push({method:input.method,route:input.fullRoute,files:(input.files??[]).map(file=>file.name)});
    if(input.method==='GET'&&input.fullRoute===`/channels/${C}/messages`){
      const query=Object.fromEntries(input.query??[]),newest=[...messages].reverse(),start=query.before?newest.findIndex(message=>message.id===query.before)+1:0;
      return newest.slice(start,start+Number(query.limit));
    }
    if(input.method==='GET'&&input.fullRoute in routes)return routes[input.fullRoute];
    if(input.method==='GET')throw Object.assign(new Error('Unknown Member'),{status:404,code:10007});
    return {id:'900000000000000000'};
  }}} as unknown as Client;
  return {client,calls};
}
const api=(client:Client,fetchImage:ImageFetcher|null=null)=>discordApi(client,undefined,undefined,undefined,{fetchImage}) as Record<string,HostFunction>;

test('markdown renders Discord formatting and keeps HTML out',()=>{
  const ctx:MentionContext={user:id=>id==='1'?{name:'Kuro',color:null}:null,channel:id=>id==='2'?'general':null,role:id=>id==='3'?{name:'Mod',color:'#e91e63'}:null,emoji:id=>`https://cdn.discordapp.com/emojis/${id}.png`};
  const html=renderMarkdown('**b** *i* _i2_ __u__ ~~s~~ ||spoil|| `x<y` <@1> <#2> <@&3> <@9> @everyone <t:0:D>\n# Big\n-# small\n- one\n- two\n> quote\n```js\nlet a = "<b>"\n```\n\\*not italic\\* snake_case_name',ctx);
  for(const part of ['<strong>b</strong>','<em>i</em>','<em>i2</em>','<u>u</u>','<s>s</s>','<span class="spoiler" tabindex="0">spoil</span>','<code>x&lt;y</code>','@Kuro','#general','style="color:#e91e63;background:#e91e6326">@Mod','@Unknown User','@everyone','1 January 1970','<h1>Big</h1>','<small class="sub">small</small>','<ul><li>one</li><li>two</li></ul>','<blockquote>quote</blockquote>','<pre class="code" data-lang="js"><code>let a = &quot;&lt;b&gt;&quot;</code></pre>','*not italic*','snake_case_name'])
    assert.ok(html.includes(part),`missing ${part} in ${html}`);
  for(const attack of ['[x](javascript:alert(1))','<script>alert(1)</script>','<img src=x onerror=alert(1)>','[a" onmouseover="x](https://ok.example/)','https://ok.example/"><script>']){
    const out=renderMarkdown(attack,ctx);
    assert.doesNotMatch(out,/<script|<img src=x|href="javascript|" onmouseover=/i,out);
  }
  assert.match(renderMarkdown('[site](https://example.com) and https://fox.example/a?b=1&c=2.',ctx),/<a href="https:\/\/example\.com" rel="noopener noreferrer">site<\/a> and <a href="https:\/\/fox\.example\/a\?b=1&amp;c=2" rel="noopener noreferrer">https:\/\/fox\.example\/a\?b=1&amp;c=2<\/a>\./);
  assert.equal(plainMentions('<@1> in <#2> <:fox:5> <t:0:d>',ctx),'@Kuro in #general :fox: 1970-01-01');
});

test('HTML transcripts look like Discord: names, colors, replies, embeds, components, and system messages',async()=>{
  const {client,calls}=sampleClient();
  const result=await api(client).transcript!.call(C,{images:'link'}) as Record<string,unknown>;
  const page=String(result.text);
  assert.equal(result.messages,8);
  assert.equal(result.channel,'ticket-0042');
  assert.ok(calls.some(call=>call.route===`/guilds/${G}/members/${U2}`),'looks up each author');
  for(const part of [
    '<title>Transcript of #ticket-0042</title>','Fox Den · #ticket-0042','Help with <strong>billing</strong>','8 messages','Participants (3)',
    `src="https://cdn.discordapp.com/icons/${G}/iconhash.png?size=96"`,
    '<span class="name" style="color:#e91e63">Kuro the Fox</span>',`src="https://cdn.discordapp.com/avatars/${U1}/abc123.png?size=64"`,`src="https://cdn.discordapp.com/embed/avatars/`,
    '<strong>Hello</strong> <span class="mention">@Helper</span>','<span class="mention">#rules</span>','<span class="mention" style="color:#e91e63;background:#e91e6326">@Mod</span>',
    'src="https://cdn.discordapp.com/emojis/888888888888888888.png?size=48"','<span class="spoiler" tabindex="0">secret</span>','&lt;script&gt;alert(1)&lt;/script&gt;',
    'class="msg cont" id="m-1003"','<span class="edited">(edited)</span>',
    '<a class="reply" href="#m-1002">','<blockquote>quoted\nmore</blockquote>','src="https://media.discordapp.net/attachments/1/2/shot.png"','<span class="file-name">notes.pdf</span><small>3.0 MB</small>',
    'used <span class="mention">/ticket</span>','<span class="tag">APP</span>','style="border-left-color:#5865f2"','<div class="e-field inline"><div class="e-fname">Priority</div>','<a href="https://example.com/t" rel="noopener noreferrer">Ticket</a>',
    '<span class="button danger">Close</span>','Docs ↗',
    'joined the server.','pinned a message to this channel.',
    '<strong>Fix it?</strong>','<span class="votes">4</span>','# follow-up <small>3 messages</small>','src="https://media.discordapp.net/stickers/999999999999999999.png?size=160"',
    'style="border-left-color:#23a55a"','<h2>Status</h2>','<div class="section">','<div class="reactions"><span class="reaction">👍 3</span>'
  ])assert.ok(page.includes(part),`missing ${part}`);
  assert.doesNotMatch(page,/<script|href="javascript|<img src=x/i);
  assert.ok(page.indexOf('joined the server')<page.indexOf('second line'));
});

test('images are embedded within a budget, only from Discord, and fall back to links',async()=>{
  const {client}=sampleClient();
  const fetched:string[]=[];
  const small:ImageFetcher=async url=>{fetched.push(url);return {type:'image/png',data:Buffer.from('png')};};
  const page=String((await api(client,small).transcript!.call(C) as Record<string,unknown>).text);
  assert.match(page,/src="data:image\/png;base64,cG5n"/);
  assert.ok(fetched.length>5);
  assert.ok(fetched.every(url=>/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url)),'only Discord hosts are fetched');
  assert.ok(page.includes('src="https://evil.example/track.png"'),'other hosts stay links');
  assert.doesNotMatch(page,/kept as links/);
  const huge:ImageFetcher=async()=>({type:'image/png',data:Buffer.alloc(3*1024*1024)});
  const capped=String((await api(sampleClient().client,huge).transcript!.call(C) as Record<string,unknown>).text);
  assert.match(capped,/\d+ images were kept as links/);
  assert.ok(capped.length<9*1024*1024);
  const failing:ImageFetcher=async()=>{throw new Error('offline');};
  assert.match(String((await api(sampleClient().client,failing).transcript!.call(C) as Record<string,unknown>).text),/<h1>Transcript of #ticket-0042<\/h1>/);
});

test('text transcripts have a header, replies, embeds, and system lines',async()=>{
  const {client}=sampleClient();
  const text=String((await api(client).transcript!.call(C,{format:'text'}) as Record<string,unknown>).text);
  for(const part of ['Transcript of #ticket-0042\nServer: Fox Den\nChannel: #ticket-0042','Participants: Kuro the Fox (4), Helper (2), ticketbot (2)','-- Helper joined the server. --',`Kuro the Fox: **Hello** @Helper, see #rules and @Mod :fox:`,'  ↪ replying to Kuro the Fox: Hello @Helper, see #rules','    attachment: shot.png https://cdn.discordapp.com/attachments/1/2/shot.png','  ↪ Kuro the Fox used /ticket','ticketbot [bot]: ','    embed: Ticket - Use the buttons','    Status: Open','    buttons: [Close] [Docs]','    poll: Fix it? - Yes (4), No (0)','    thread: follow-up (3 messages)','    sticker: wave','    reactions: 👍 3, :fox: 1','    | ## Status\n    | All good'])
    assert.ok(text.includes(part),`missing ${part} in\n${text}`);
});

test('lookups that fail still give a plain transcript',async()=>{
  const client={rest:{request:async(input:{fullRoute:string;query?:URLSearchParams})=>{
    if(input.fullRoute.endsWith('/messages'))return [...sampleMessages()].reverse();
    throw Object.assign(new Error('Missing Access'),{status:403,code:50001});
  }}} as unknown as Client;
  const page=String((await api(client).transcript!.call(C) as Record<string,unknown>).text);
  assert.match(page,/<title>Transcript<\/title>/);
  assert.ok(page.includes('<span class="mention">#unknown</span>'));
  assert.ok(page.includes('<span class="mention">@deleted-role</span>'));
  assert.ok(page.includes('<span class="name">Kuro</span>'));
});

test('closeTicket posts to the log, DMs, then deletes, and keeps the ticket when posting fails',async()=>{
  const {client,calls}=sampleClient();
  const result=await api(client).closeTicket!.call(C,{log:'101010101010101010',dm:U1,delete:true,format:'text',reason:'Solved'}) as Record<string,unknown>;
  assert.deepEqual({logged:result.logged,dmed:result.dmed,deleted:result.deleted,dm_error:result.dm_error},{logged:true,dmed:true,deleted:true,dm_error:null});
  const writes=calls.filter(call=>call.method!=='GET');
  assert.deepEqual(writes.map(call=>`${call.method} ${call.route}`),['POST /channels/101010101010101010/messages','POST /users/@me/channels','POST /channels/900000000000000000/messages',`DELETE /channels/${C}`]);
  assert.deepEqual(writes[0]!.files,[`transcript-${C}.txt`]);

  const quiet=sampleClient();
  await api(quiet.client).closeTicket!.call(C,{log:'101010101010101010'});
  assert.deepEqual(quiet.calls.filter(call=>call.method!=='GET').map(call=>call.route),['/channels/101010101010101010/messages']);

  const broken=sampleClient(),post=broken.client.rest.request.bind(broken.client.rest);
  (broken.client.rest as unknown as {request:unknown}).request=async(input:{method:string;fullRoute:string})=>{if(input.method==='POST')throw Object.assign(new Error('Missing Permissions'),{status:403,code:50013});return post(input as never);};
  await assert.rejects(async()=>api(broken.client).closeTicket!.call(C,{log:'101010101010101010',delete:true}),/log channel, so the ticket was kept/);
  assert.ok(!broken.calls.some(call=>call.method==='DELETE'));

  const closedDms=sampleClient(),send=closedDms.client.rest.request.bind(closedDms.client.rest);
  (closedDms.client.rest as unknown as {request:unknown}).request=async(input:{method:string;fullRoute:string})=>{if(input.fullRoute==='/users/@me/channels')throw Object.assign(new Error('Cannot send messages to this user'),{status:403,code:50007});return send(input as never);};
  const dmFailed=await api(closedDms.client).closeTicket!.call(C,{log:'101010101010101010',dm:U1,delete:true}) as Record<string,unknown>;
  assert.equal(dmFailed.dmed,false);assert.equal(dmFailed.deleted,true);assert.match(String(dmFailed.dm_error),/Cannot send messages|50007/);

  await assert.rejects(async()=>api(sampleClient().client).closeTicket!.call(C,{delete:true}),/set "log" or "dm"/);
  await assert.rejects(async()=>api(sampleClient().client).closeTicket!.call(C,{logs:'1'}),/Unknown closeTicket setting logs/);
});
