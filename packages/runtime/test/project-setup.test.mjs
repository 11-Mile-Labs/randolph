import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSetupProposal, setupPrompt } from '../dist/project-setup.js';

const value = {context:{purpose:'A project workspace',instructions:'Keep history.\nAsk before delivery.',documents:[{path:'docs/product-spec.md',description:'Approved behavior'}]},evidence:['README describes the workspace.'],questions:['Which target platform comes next?']};

test('completed proposal parsing retains editable context and a revision tied to the exact response',()=>{
 const raw=JSON.stringify(value);const parsed=parseSetupProposal(raw);
 assert.deepEqual(parsed.value,value);
 assert.match(parsed.revision,/^[a-f0-9]{64}$/);
 assert.deepEqual(parseSetupProposal('```json\n'+raw+'\n```').value,value);
 assert.notEqual(parsed.revision,parseSetupProposal(raw+'\n').revision);
});

test('malformed or unsafe proposals cannot become approvable context',()=>{
 for(const raw of ['not json','Here is a proposal: '+JSON.stringify(value),JSON.stringify({...value,context:{...value.context,documents:[{path:'../outside',description:''}]}}),JSON.stringify({...value,questions:'not a list'}),JSON.stringify({...value,evidence:Array(31).fill('x')}),'x'.repeat(100_001)])assert.throws(()=>parseSetupProposal(raw));
});

test('setup prompts retain approved context and corrections without giving the model write authority',()=>{
 const prompt=setupPrompt({revision:'a'.repeat(64),value:value.context},'Explore macOS support.');
 assert.ok(prompt.includes('Explore macOS support.'));
 assert.ok(prompt.includes('A project workspace'));
 assert.ok(prompt.includes('docs/product-spec.md'));
 assert.match(prompt,/Do not write/i);
 assert.match(prompt,/questions/);
});
