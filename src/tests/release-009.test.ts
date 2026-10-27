import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../compiler/parser.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {analyze,definition} from '../editor/service.js';
import {formatSource} from '../compiler/format.js';
import {formatFiles} from '../cli/format.js';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Storage} from '../storage/sqlite.js';
import {dataApi,guildDataApi,memberDataScope} from '../runtime/stdlib.js';
import {ROLE_MENU,record,type RuntimeComponent} from '../runtime/interpreter.js';
import {PAGE_ID,startPages,turnPage} from '../discord/pages.js';
import {roleChanges,roleSummary} from '../discord/roles.js';
import {ComponentRegistry,statefulComponentIds} from '../discord/components.js';

async function run(source:string,values:Record<string,Value>={}):Promise<Value>{
  let result:Value=null;
  await execute(parse(source).statements,{values,onReturn:value=>{result=value;}});
  return result;
}

const plain=(value:Value):unknown=>JSON.parse(JSON.stringify(value));

test('break and continue control for and while loops',async()=>{
  assert.deepEqual(await run('let out = []\nfor i in range(10):\n    if i % 2 == 1:\n        continue\n    if i > 6:\n        break\n    out[len(out)] = i\nreturn out\n'),[0,2,4,6]);
  assert.equal(await run('let n = 0\nwhile true:\n    n += 1\n    if n == 3:\n        break\nreturn n\n'),3);
  assert.throws(()=>parse('break\n'),/break only works inside for or while/);
  assert.throws(()=>parse('for x in [1]:\n    function f():\n        continue\n'),/continue only works inside for or while/);
  assert.throws(()=>parse('for x in [1]:\n    after "later" 5 seconds:\n        break\n'),/break only works/);
});

test('break passes through try blocks to the loop',async()=>{
  assert.equal(await run('let n = 0\nfor i in range(5):\n    try:\n        n = i\n        break\n    catch error:\n        n = 99\nreturn n\n'),0);
});

test('modulo follows the divisor sign and rejects zero',async()=>{
  assert.equal(await run('return 7 % 3\n'),1);
  assert.equal(await run('return -1 % 3\n'),2);
  await assert.rejects(run('return 1 % 0\n'),/Cannot use % with 0/);
});

test('compound assignment works on names, fields, and list items',async()=>{
  assert.equal(await run('let total = 2\ntotal += 3\ntotal *= 4\ntotal -= 1\ntotal /= 2\nreturn total\n'),9.5);
  assert.equal(await run('let text = "a"\ntext += "b"\nreturn text\n'),'ab');
  assert.deepEqual(plain(await run('let counts = {}\nfor word in ["a", "b", "a"]:\n    counts[word] += 1\nreturn counts\n')),{a:2,b:1});
  assert.deepEqual(plain(await run('let player = {"hp": 10}\nplayer.hp -= 4\nplayer.name = "Kit"\nreturn player\n')),{hp:6,name:'Kit'});
  assert.deepEqual(await run('let items = ["a"]\nitems[0] = "b"\nitems[1] = "c"\nreturn items\n'),['b','c']);
  await assert.rejects(run('missing += 1\n'),/Undefined name missing/);
});

test('assignment refuses built-in values and bad targets',async()=>{
  await assert.rejects(run('user.name = "x"\n',{user:Object.freeze({name:'n'})}),/Cannot change built-in value user/);
  await assert.rejects(run('let a = null\na.b = 1\n'),/Cannot change a field on null/);
  await assert.rejects(run('let a = [1]\na[5] = 2\n'),/List index 5 is out of range/);
  await assert.rejects(run('let a = [1]\na["x"] = 2\n'),/number index/);
  assert.throws(()=>parse('len(x) = 1\n'),/Only names, fields, and list items can be assigned/);
});

test('in and not in check lists, map keys, and text',async()=>{
  assert.equal(await run('return 2 in [1, 2] and "k" in {"k": 1} and "ell" in "hello"\n'),true);
  assert.equal(await run('return "z" not in ["a"] and not ("a" not in ["a"])\n'),true);
  await assert.rejects(run('return 1 in 5\n'),/in needs a list, map, or text/);
});

test('match picks the first equal branch, with several values per when',async()=>{
  const source=(value:string)=>`let label = "none"\nmatch ${value}:\n    when "red", "pink":\n        label = "warm"\n    when "blue":\n        label = "cool"\n    else:\n        label = "other"\nreturn label\n`;
  assert.equal(await run(source('"pink"')),'warm');
  assert.equal(await run(source('"blue"')),'cool');
  assert.equal(await run(source('"green"')),'other');
  assert.equal(await run('let hit = false\nmatch 3:\n    when 1:\n        hit = true\nreturn hit\n'),false);
  assert.throws(()=>parse('match 1:\n    let y = 2\n'),/Each match branch starts with when or else/);
  assert.throws(()=>parse('match 1:\n    else:\n        let y = 1\n    when 1:\n        let y = 2\n'),/else must be the last branch/);
  assert.equal(await run('let match = 2\nmatch += 1\nreturn match\n'),3);
});

test('friendly parse errors explain common mistakes',()=>{
  assert.throws(()=>parse('if x = 1:\n    let y = 2\n'),/Use == to compare/);
  assert.throws(()=>parse('if true\n    let y = 2\n'),/Expected : at the end of the line/);
});

test('editor understands the new statements',()=>{
  const source='let counts = {}\nfor word in ["a"]:\n    counts[word] += 1\n    if word == "a":\n        continue\nmatch len(counts):\n    when 1:\n        let one = counts\n    else:\n        let other = counts\n';
  assert.deepEqual(analyze(source,'lang.wisp').diagnostics,[]);
  assert.deepEqual(analyze('missing += 1\n','lang.wisp').diagnostics.map(item=>item.code),['EDITOR001']);
});

async function withStorage(work:(db:Storage)=>Promise<void>):Promise<void>{
  const root=mkdtempSync(join(tmpdir(),'wisp-009-')),db=new Storage(join(root,'data.db'));
  try{await work(db);}finally{db.close();rmSync(root,{recursive:true,force:true});}
}
const member=(db:Storage,id:string)=>record({id,data:dataApi(db,memberDataScope('g1',id))}) as Value;

test('user.data reads, writes, deletes, and counts from zero',()=>withStorage(async db=>{
  const user=member(db,'u1'),guild=record(guildDataApi(db,'g1')) as Value;
  assert.equal(await run('user.data.coins += 5\nuser.data.coins -= 1\nuser.data.name = "Kit"\nuser.data["title"] = "Fox"\nreturn user.data.coins\n',{user}),4);
  assert.equal(db.get(memberDataScope('g1','u1'),'name'),'Kit');
  assert.equal(await run('return user.data.missing ?? "none"\n',{user}),'none');
  assert.equal(await run('user.data.name = null\nreturn user.data.name\n',{user}),null);
  assert.equal(db.has(memberDataScope('g1','u1'),'name'),false);
  assert.equal(await run('guild.data.prefix = "!"\nreturn guild.data.prefix + user.data.title\n',{user,guild}),'!Fox');
}));

test('user.data += is atomic across concurrent handlers',()=>withStorage(async db=>{
  await Promise.all(Array.from({length:25},()=>run('user.data.coins += 1\n',{user:member(db,'u1')})));
  assert.equal(db.get(memberDataScope('g1','u1'),'coins'),25);
}));

test('user.data rejects nested writes and non-data values',()=>withStorage(async db=>{
  const user=member(db,'u1');
  await assert.rejects(run('user.data.stats = {"wins": 1}\nuser.data.stats.wins += 1\n',{user}),/Data fields are one level deep; save the whole map with user\.data\.stats = \{\.\.\.\}/);
  assert.equal(await run('let stats = user.data.stats\nstats.wins += 1\nuser.data.stats = stats\nreturn user.data.stats.wins\n',{user}),2);
  await assert.rejects(run('user.data.copy = user.data\n',{user}),/Data fields hold text, numbers/);
}));

test('guild.top ranks members by a numeric data field',()=>withStorage(async db=>{
  for(const [id,coins] of [['a',5],['b',12],['c',7],['d',12]] as const)db.set(memberDataScope('g1',id),'coins',coins);
  db.set(memberDataScope('g1','e'),'coins','lots');
  db.set(memberDataScope('g2','x'),'coins',99);
  const guild=record(guildDataApi(db,'g1')) as Value;
  const top=await run('return guild.top("coins", 3)\n',{guild}) as Record<string,Value>[];
  assert.deepEqual(top.map(row=>[row.rank,row.id,row.value,row.mention]),[[1,'b',12,'<@b>'],[2,'d',12,'<@d>'],[3,'c',7,'<@c>']]);
  await assert.rejects(run('return guild.top("coins", 0)\n',{guild}),/top count must be 1 to 100/);
}));

test('reply pages renders every line and splits it into pages',async()=>{
  let body:Record<string,unknown>|undefined;
  const source='let shop = []\nfor i in range(1, 8):\n    shop[len(shop)] = {"name": "Item {i}", "price": i * 10}\nreply pages:\n    items: shop\n    per_page: 3\n    title: "Shop"\n    each item:\n        "{index}. **{item.name}** costs {item.price}"\n';
  await execute(parse(source).statements,{values:{},reply:async result=>{body=result as Record<string,unknown>;}});
  const pages=(body?.pages as {pages:string[];title:string});
  assert.equal(pages.title,'Shop');
  assert.equal(pages.pages.length,3);
  assert.equal(pages.pages[0],'1. **Item 1** costs 10\n2. **Item 2** costs 20\n3. **Item 3** costs 30');
  assert.equal(pages.pages[2],'7. **Item 7** costs 70');
  assert.equal(body?.ephemeral,false);
  let empty:Record<string,unknown>|undefined;
  await execute(parse('reply pages:\n    items: []\n    empty: "No items"\n    each item:\n        item\n').statements,{values:{},reply:async result=>{empty=result as Record<string,unknown>;}});
  assert.deepEqual((empty?.pages as {pages:string[]}).pages,['No items']);
  await assert.rejects(execute(parse('reply pages:\n    items: [1]\n    each item:\n        item\n').statements,{values:{},reply:async()=>{}}),/each must produce text/);
  await assert.rejects(execute(parse('reply pages:\n    items: ["a"]\n    per_page: 50\n    each item:\n        item\n').statements,{values:{},reply:async()=>{}}),/per_page must be a whole number from 1 to 25/);
  assert.throws(()=>parse('reply pages:\n    items: [1]\n'),/needs an each item: line/);
  assert.throws(()=>parse('reply pages:\n    items: [1]\n    size: 3\n    each item:\n        "x"\n'),/Unknown pages field size/);
});

test('saved page lists turn pages for their owner only',()=>withStorage(async db=>{
  const list={title:'Shop',pages:['one','two','three']};
  const first=await startPages(db,list,'g1','u1');
  assert.deepEqual(first.embed,{title:'Shop',description:'one',footer:'Page 1 of 3'});
  const buttons=((first.components![0] as Record<string,Value>).components as Record<string,Value>[]);
  assert.deepEqual(buttons.map(button=>button.disabled),[true,false]);
  const next=buttons[1]!.custom_id as string;
  assert.match(next,PAGE_ID);
  assert.deepEqual(statefulComponentIds(first.components),[`ss:${PAGE_ID.exec(next)![1]}`]);
  const second=await turnPage(db,next,'g1','u1');
  assert.equal(second.embed.description,'two');
  await assert.rejects(turnPage(db,next,'g1','u2'),/belongs to someone else/);
  await assert.rejects(turnPage(db,next,'g2','u1'),/scope mismatch/);
  await db.deleteComponentsFor('guild',['g1']);
  await assert.rejects(turnPage(db,next,'g1','u1'),/This list has expired/);
  assert.equal((await startPages(db,{pages:['only']},'g1','u1')).components,undefined);
  await assert.rejects(startPages(db,{pages:['x'.repeat(9000),'y'.repeat(9000)]},'g1','u1'),/too large to save/);
}));

test('roles menus become a stateless select and pick changes roles',()=>withStorage(async db=>{
  let body:Record<string,unknown>|undefined;
  const source='reply:\n    text: "Pick your pings"\n    roles:\n        "News": "111111111111111111"\n        "Events": "222222222222222222"\n    pick: many\n';
  await execute(parse(source).statements,{values:{},reply:async result=>{body=result as Record<string,unknown>;}});
  const [menu]=body?.components as RuntimeComponent[];
  assert.equal(menu!.name,ROLE_MENU);
  assert.deepEqual(menu!.fields,{placeholder:'Choose your roles',min:0,max:2});
  assert.deepEqual(menu!.choices!.map(choice=>[choice.value,choice.fields.label]),[['111111111111111111','News'],['222222222222222222','Events']]);
  const rows=await new ComponentRegistry(db,'g1','u1').buildRows([menu!]);
  assert.equal((rows[0]!.toJSON().components[0] as {custom_id:string}).custom_id,`sl:select:${ROLE_MENU}`);
  await assert.rejects(execute(parse('reply:\n    roles:\n        "News": "news"\n').statements,{values:{},reply:async()=>{}}),/must be a role ID/);
  assert.throws(()=>parse('reply:\n    text: "x"\n    pick: one\n'),/pick needs a roles: menu/);
  assert.deepEqual(roleChanges(['a','b','c'],['a','x'],['b','z']),{add:['a'],remove:['b']});
  assert.equal(roleSummary({add:['a'],remove:['b']},id=>id.toUpperCase()),'Added A, removed B');
  assert.equal(roleSummary({add:[],remove:['b']},id=>id),'Removed b');
  assert.equal(roleSummary({add:[],remove:[]},id=>id),'No changes; you already have those roles');
}));

test('editor understands pages and roles',()=>{
  const source='let shop = []\nreply pages:\n    items: shop\n    each item:\n        "{index}: {item}"\nreply:\n    roles:\n        "News": "1"\n';
  assert.deepEqual(analyze(source,'pages.wisp').diagnostics,[]);
});

test('wisp fmt normalizes spacing, keeps markdown, and is idempotent',()=>{
  const messy='let   x=1+2*-3\nlet m = {"a":1,"b" :[ -1, x ]}\nif (x>=2) and not(x==5):   \n    log.info( "hi  there" )   # keep  this\ncommand "card":\n    description "Card"\n    execute:\n        reply v2:\n            container:\n                markdown:\n                    # Title  \n                    Some   text {x}\n\n\n\non ready:\n    log.info("up")\n';
  const formatted=formatSource(messy,'m.wisp');
  assert.equal(formatted,'let x = 1 + 2 * -3\nlet m = {"a": 1, "b": [-1, x]}\nif (x >= 2) and not (x == 5):\n    log.info("hi  there") # keep  this\n\ncommand "card":\n    description "Card"\n    execute:\n        reply v2:\n            container:\n                markdown:\n                    # Title  \n                    Some   text {x}\n\non ready:\n    log.info("up")\n');
  assert.equal(formatSource(formatted,'m.wisp'),formatted);
  assert.equal(formatSource('if true:\n    let a = 1\nelse:\n    let a = 2\n'),'if true:\n    let a = 1\nelse:\n    let a = 2\n');
  assert.equal(formatSource('let items = [\n    1,2,\n    3,\n]\n'),'let items = [\n    1, 2,\n    3,\n]\n');
  assert.throws(()=>formatSource('let = 1\n'),/Expected IDENT/);
});

test('wisp fmt --check reports files without writing them',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-fmt-'));
  try{
    writeFileSync(join(root,'a.wisp'),'let   x=1\r\n');writeFileSync(join(root,'b.wisp'),'let y = 2\n');
    const checked=formatFiles([],root,true);
    assert.deepEqual([checked.files,checked.changed.length,checked.failed.length],[2,1,0]);
    assert.equal(readFileSync(join(root,'a.wisp'),'utf8'),'let   x=1\r\n');
    formatFiles([],root,false);
    assert.equal(readFileSync(join(root,'a.wisp'),'utf8'),'let x = 1\r\n');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('event and name mistakes suggest the fix',()=>{
  assert.throws(()=>parse('on "ready":\n    log.info("x")\n'),/Event names are not quoted; write on ready:/);
  assert.throws(()=>parse('on member_joni:\n    log.info("x")\n'),/Unsupported event member_joni; did you mean member_join\?/);
  const [typo]=analyze('let user_name = 1\nlet copy = user_nme\n','typo.wisp').diagnostics;
  assert.equal(typo!.message,'Undefined name user_nme; did you mean user_name?');
  assert.deepEqual(typo!.data,{replacement:'user_name'});
});

test('editor finds definitions inside imported modules',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-def-'));
  try{
    writeFileSync(join(root,'wisp.json'),'{}');
    writeFileSync(join(root,'util.wisp'),'export function greet(name):\n    return "Hi {name}"\n');
    const file=join(root,'main.wisp'),analysis=analyze('import "./util.wisp"\nlet text = util.greet("Kit")\n',file);
    const found=definition(analysis,{line:1,character:17});
    assert.equal(found?.file,join(root,'util.wisp'));
    assert.deepEqual(found?.range.start,{line:0,character:16});
  }finally{rmSync(root,{recursive:true,force:true});}
});
