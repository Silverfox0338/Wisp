import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../compiler/parser.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {analyze} from '../editor/service.js';

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
