import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../compiler/parser.js';
import {execute} from '../runtime/interpreter.js';
import {WispError} from '../diagnostics.js';

test('nested runtime failures retain source-aware call frames and suggestions',async()=>{
  const file='commands/failure.wisp',source='function inner():\n    reply null.name\nfunction outer():\n    inner()\nouter()\n';
  await assert.rejects(()=>execute(parse(source,file).statements,{values:{},file,reply:async()=>{}}),error=>{
    assert.ok(error instanceof WispError);
    assert.match(error.message,/Cannot access property "name" on null/);
    assert.ok(error.frames.length>=3);
    assert.match(error.format(source),/Call stack:/);
    assert.match(error.format(source),/Suggestion:/);
    return true;
  });
});
