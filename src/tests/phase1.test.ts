import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../compiler/parser.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {jsonApi,mathApi,timeApi} from '../runtime/stdlib.js';
import {analyze,completion} from '../editor/service.js';
import {WispError} from '../diagnostics.js';

async function run(source:string,values:Record<string,Value>={}):Promise<string[]> {
  const replies:string[]=[];
  await execute(parse(source,'phase1.wisp').statements,{values,reply:async body=>{replies.push(body.content??'');},file:'phase1.wisp'});
  return replies;
}

test('collections support mutation, callbacks, ranges, and map entry loops',async()=>{
  const source=`function double(item):
    return item * 2
function even(item):
    return item / 2 == math.floor(item / 2)
let items = range(1, 5)
items.insert(0, 0)
items.remove(3)
let last = items.pop()
items.append(last)
let doubled = items.map(double)
let selected = doubled.filter(even)
let found = selected.find(even)
let has = selected.contains(4)
let index = selected.index(4)
let part = selected.slice(1, 3)
let data = {"a": 1, "b": 2}
let total = 0
for entry in data:
    total = total + entry.value
let keys = data.keys()
let entries = data.entries()
reply "{selected.join(',')}:{found}:{has}:{index}:{part.join(',')}:{total}:{keys.join(',')}:{entries[0].key}"
`;
  assert.deepEqual(await run(source,{math:mathApi()}),['0,2,4,8:0:true:2:2,4:3:a,b:a']);
  assert.deepEqual(await run('let items = range(5, 0, -2)\nitems.reverse()\nitems.sort()\nreply items.join(",")\n'),['1,3,5']);
});

test('strings expose literal, formatting, padding, and bounded regex methods',async()=>{
  const source=`let words = "  Red,Blue  ".trim().split(",")
let first = words[0].lower()
let second = words[1].upper()
let text = "%1/%2".format(first, second)
let edited = text.replace("/", ":").pad_end(10, ".")
let matched = edited.regex_match("^red:BLUE")
let changed = edited.regex_replace("[.]", "!")
reply "{edited}:{matched}:{changed}:{first.starts_with('r')}:{second.ends_with('E')}:{edited.substring(0, 3)}:{edited.contains(':')}"
`;
  assert.deepEqual(await run(source),['red:BLUE..:true:red:BLUE!!:true:true:red:true']);
  await assert.rejects(()=>run('reply "aaaa!".regex_match("(a+)+$")\n'),/unsafe regex/);
});

test('math, time, and JSON are available through allowlisted APIs',async()=>{
  const source=`let parsed = json.parse("{{\\"count\\":3}}")
let text = json.stringify(parsed)
let stamp = time.parse("2024-01-02T03:04:05Z")
let next = time.add(stamp, 60)
let shown = time.format(next, "YYYY-MM-DD HH:mm:ss")
let discord = time.discord(stamp, "R")
let pick = math.randomChoice([7])
reply "{text}:{shown}:{time.diff(next, stamp)}:{discord}:{math.clamp(12, 0, 10)}:{pick}"
`;
  assert.deepEqual(await run(source,{json:jsonApi(),time:timeApi(),math:mathApi()}),['{"count":3}:2024-01-02 03:05:05:60:<t:1704164645:R>:10:7']);
  await assert.rejects(()=>run('json.parse("{")\n',{json:jsonApi()}),/Invalid JSON/);
});

test('default parameters, closures, try catch, and raise preserve locations',async()=>{
  const source=`function make(base):
    function add(value = base):
        return base + value
    return add
let add = make(4)
try:
    raise "bad input"
catch error:
    reply "{error.code}:{error.message}:{error.line}:{add()}:{add(3)}"
`;
  assert.deepEqual(await run(source),['RUNTIME008:bad input:7:8:7']);
  await assert.rejects(()=>run('raise "bad"\n'),error=>{assert.ok(error instanceof WispError);assert.equal(error.file,'phase1.wisp');assert.equal(error.line,1);return true;});
  assert.throws(()=>parse('function f(a = 1, b):\n    return b\n'),/Required parameters must precede/);
});

test('Phase 1 limits reject oversized ranges and concatenated strings',async()=>{
  await assert.rejects(()=>run('let values = range(0, 10001)\n'),/Range exceeds/);
  await assert.rejects(()=>run('let text = large + large\n',{large:'x'.repeat(40000)}),/String exceeds/);
  await assert.rejects(()=>run('let text = "a".pad_start(1000000000)\n'),/Padding exceeds/);
  await assert.rejects(()=>run('let text = "aaaa".replace("a", long)\n',{long:'x'.repeat(20000)}),/String exceeds/);
  await assert.rejects(()=>run('json.stringify(math)\n',{json:jsonApi(),math:mathApi()}),/not JSON-compatible/);
  const source='function same(item):\n    return item\nlet result = [1, 2, 3].map(same)\n';
  await assert.rejects(()=>execute(parse(source).statements,{values:{},maxLoops:2}),/Loop limit/);
});

test('editor completes Phase 1 APIs and diagnoses missing names in catch blocks',()=>{
  const source='let data = json.parse("{}")\nlet word = "abc"\ntry:\n    raise "bad"\ncatch error:\n    log.warn(error.message)\n    log.warn(missing)\n';
  const analysis=analyze(source);
  assert.ok(analysis.diagnostics.some(item=>item.message.includes('missing')));
  assert.ok(!analysis.diagnostics.some(item=>item.message.includes('error')));
  assert.ok(completion(analysis,{line:0,character:16}).some(item=>item.label==='parse'));
  const stringAnalysis=analyze('let word = "abc"\nword.split(",")\n');
  assert.ok(completion(stringAnalysis,{line:1,character:5}).some(item=>item.label==='split'));
});
