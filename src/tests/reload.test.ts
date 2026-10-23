import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReloadableProject} from '../project/reload.js';
import type {CompiledProject} from '../project/discovery.js';
test('reload preserves last good generation after compile error',()=>{const first:CompiledProject={commands:[],events:[]},second:CompiledProject={commands:[],events:[]};let fail=true;const registry=new ReloadableProject(first,()=>{if(fail)throw new Error('invalid script');return second;});assert.equal(registry.reload().ok,false);assert.equal(registry.value,first);fail=false;assert.equal(registry.reload().ok,true);assert.equal(registry.value,second);});
