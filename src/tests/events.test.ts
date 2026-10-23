import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventGate} from '../discord/events.js';
test('event concurrency gate rejects overflow and releases capacity after failure',async()=>{const gate=new EventGate(1);let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});const first=gate.run(async()=>{await pending;});assert.equal(gate.count,1);assert.equal(await gate.run(async()=>{}),false);release();assert.equal(await first,true);assert.equal(gate.count,0);await assert.rejects(()=>gate.run(async()=>{throw new Error('handler failed');}),/handler failed/);assert.equal(gate.count,0);});
