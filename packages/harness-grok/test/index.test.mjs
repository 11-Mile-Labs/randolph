import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokAdapter } from '../dist/index.js';
import { GrokProtocol } from '../dist/protocol.js';

function fixture(mode = 'normal', version = 'grok 1.0.30 (04b7ffed98c6) [stable]') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-grok-test-')));
  const workspace = join(root, 'project'); mkdirSync(workspace);
  const executable = join(root, 'grok'); const calls = join(root, 'calls.jsonl');
  writeFileSync(calls, ''); writeFileSync(join(workspace, 'README.md'), 'Project fixture');
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE');
  symlinkSync(join(root, 'outside.txt'), join(workspace, 'escape.txt'));
  writeFileSync(join(workspace, 'large.txt'), Buffer.alloc(1_048_577, 65));
  writeFileSync(executable, `#!${process.execPath}\n` + `
const {createInterface}=require('node:readline');
const {appendFileSync,readFileSync}=require('node:fs');

const mode=${JSON.stringify(mode)},calls=${JSON.stringify(calls)},workspace=${JSON.stringify(workspace)},root=${JSON.stringify(root)};
const version=${JSON.stringify(version)};
if(process.argv.includes('--version')){console.log(version);process.exit(0);}
const profile=readFileSync(process.argv[process.argv.indexOf('--agent-profile')+1],'utf8');
const code=profile.includes('tools: [read_file, write]');
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const models={currentModelId:'grok-4.6',availableModels:[{modelId:'grok-4.6',name:'Grok 4.6',_meta:{reasoningEfforts:[{id:'low',default:true},{id:'high',default:false}]}}]};
let turn,clientFs={};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(calls,JSON.stringify(m)+'\\n');
 if(!m.method){if(m.id===105)send({id:turn,result:{stopReason:'end_turn'}});return;}
 if(m.method==='initialize'){
  const result={id:m.id,result:{protocolVersion:1,authMethods:[{id:mode==='api'?'xai.api_key':'cached_token'}],_meta:{agentVersion:'1.0.30',defaultAuthMethodId:mode==='api'?'xai.api_key':'cached_token',modelState:models}}};
  clientFs=m.params.clientCapabilities.fs;
  if(mode==='delayed-init')setTimeout(()=>send(result),50);else send(result);
 }
 else if(m.method==='authenticate')send({id:m.id,result:{_meta:{auth_mode:'Oidc',backend_billed:mode==='billed',subscription_tier:'Test subscription'}}});
 else if(m.method==='session/new'){
  const result={id:m.id,result:{sessionId:'native-session',models,configOptions:[{id:'reasoning_effort',currentValue:mode==='wrong-effort'?'high':m.params._meta.reasoningEffort}]}};
  if(mode!=='missing-catalog')send({method:'session/update',params:{sessionId:mode==='wrong-catalog-session'?'other':'native-session',update:{sessionUpdate:'available_commands_update',_meta:{tools:mode==='extra-tool'?['read_file','use_tool']:mode==='duplicate-tool'?['read_file','read_file']:code?['write','read_file']:['read_file']}}}});
  if(mode==='delayed-session')setTimeout(()=>send(result),50);else send(result);
 }
 else if(m.method==='session/prompt'){
  turn=m.id;
  if(mode==='late-catalog'){
   process.stdout.write([
    {method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'available_commands_update',_meta:{tools:['read_file','write','unapproved__mutate']}}}},
    {id:104,method:'fs/write_text_file',params:{sessionId:'native-session',path:workspace+'/README.md',content:'CHANGED'}}
   ].map(m=>JSON.stringify({jsonrpc:'2.0',...m})+'\\n').join(''));
   return;
  }
  if(mode==='requests'||mode==='code-requests'){
   if(clientFs.readTextFile!==true||clientFs.writeTextFile!==true){require('node:fs').writeFileSync(workspace+'/README.md','LOCAL ROUTE');return;}
   for(const [id,path] of [[100,workspace+'/README.md'],[101,root+'/outside.txt'],[102,workspace+'/escape.txt'],[103,workspace+'/large.txt']])send({id,method:'fs/read_text_file',params:{sessionId:'native-session',path}});
   send({id:104,method:'fs/write_text_file',params:{sessionId:'native-session',path:workspace+'/README.md',content:'CHANGED'}});
   if(mode==='code-requests'){
    for(const [id,path] of [[106,workspace+'/created/new.txt'],[107,root+'/outside.txt'],[108,workspace+'/.git/config'],[109,workspace+'/escape.txt']])send({id,method:'fs/write_text_file',params:{sessionId:'native-session',path,content:'NEW FILE'}});
    send({id:110,method:'fs/write_text_file',params:{sessionId:'other',path:workspace+'/wrong.txt',content:'WRONG'}});
   }
   send({id:105,method:'session/request_permission',params:{sessionId:'native-session',options:[{optionId:'allow',kind:'allow_always'}]}});
   return;
  }
  send({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG'}}}});
  send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'REASONING'}}}});
  send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Read fixture',kind:'read',status:'in_progress'}}});
  send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}});
  if(mode!=='waiting'){send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:' Grok'}}}});send({id:m.id,result:{stopReason:mode==='failure'?'refusal':'end_turn'}});}
 }
 else if(m.method==='session/cancel')send({id:turn,result:{stopReason:'cancelled'}});
});
`, {mode:0o700});
  return {root,workspace,executable,calls,adapter:new GrokProtocol({executable,readConfig:()=>undefined}),close:()=>rmSync(root,{recursive:true,force:true})};
}
const input = f => ({workspace:f.workspace,model:'grok-4.6',effort:'low',messages:[{role:'user',text:'Inspect'}],signal:new AbortController().signal,onEvent:()=>{}});

test('native discovery requires cached subscription auth and exposes the actual model/effort catalog', async()=>{
 const f=fixture();try{const info=await f.adapter.discover();assert.equal(info.authenticated,true);assert.deepEqual(info.executionModes,[]);assert.deepEqual(info.models[0].efforts,['low','high']);assert.equal(info.executable,f.executable);}finally{f.close();}
 for(const mode of ['api','billed']){const f=fixture(mode);try{const info=await f.adapter.discover();assert.equal(info.authenticated,false);await assert.rejects(f.adapter.run(input(f)),/subscription|API/i);assert.equal(readFileSync(f.calls,'utf8').includes('session/prompt'),false);}finally{f.close();}}
});

test('ACP streams only this session assistant text and preserves separate tool activity',async()=>{
 const f=fixture();try{const events=[];const result=await f.adapter.run({...input(f),onEvent:event=>events.push(event)});assert.equal(result.status,'completed');assert.equal(events.filter(e=>e.type==='message.delta').map(e=>e.data.text).join(''),'Hello Grok');assert.ok(events.some(e=>e.type==='tool.started'));assert.ok(events.some(e=>e.type==='session.started'&&e.data.sessionId==='native-session'));}finally{f.close();}
});

test('cancellation addresses the native session and waits for owned process cleanup',async()=>{
 const f=fixture('waiting');try{const signal=new AbortController();const result=await f.adapter.run({...input(f),signal:signal.signal,onEvent:event=>{if(event.type==='message.delta')signal.abort();}});assert.equal(result.status,'interrupted');assert.ok(readFileSync(f.calls,'utf8').includes('session/cancel'));}finally{f.close();}
});

test('changed executable versions, unavailable models, and API overrides cannot dispatch',async()=>{
 const f=fixture();try{
 await assert.rejects(f.adapter.run({...input(f),executableVersion:'old'}),/version changed/);
 await assert.rejects(f.adapter.run({...input(f),model:'other'}),/model|effort/);
 const overridden=new GrokProtocol({executable:f.executable,readConfig:()=> '[model."grok-4.6"]\nbase_url="https://example.invalid"\n'});
 await assert.rejects(overridden.run(input(f)),/override|provider/i);
 assert.equal(readFileSync(f.calls,'utf8').includes('session/prompt'),false);
 }finally{f.close();}
});

test('only the verified Grok 1.0.30 build can dispatch',async()=>{
 const f=fixture('normal','grok 1.0.31 (drifted) [stable]');try{
  await assert.rejects(f.adapter.run(input(f)),/not been verified/);
  assert.equal(readFileSync(f.calls,'utf8'),'');
 }finally{f.close();}
});

test('native effort mismatch cannot dispatch a prompt',async()=>{
 const f=fixture('wrong-effort');try{await assert.rejects(f.adapter.run(input(f)),/confirm.*effort/);assert.equal(readFileSync(f.calls,'utf8').includes('session/prompt'),false);}finally{f.close();}
});

for(const mode of ['missing-catalog','wrong-catalog-session','extra-tool','duplicate-tool'])test(`unverified native tool catalog (${mode}) prevents model dispatch`,async()=>{
 const f=fixture(mode);try{
  const adapter=new GrokProtocol({executable:f.executable,readConfig:()=>undefined,rpcTimeoutMs:500});
  await assert.rejects(adapter.run(input(f)),/catalog|tools/);
  assert.equal(readFileSync(f.calls,'utf8').includes('session/prompt'),false);
 }finally{f.close();}
});

test('ACP advertises both filesystem handlers, stays bounded in the workspace, and denies writes without mutation',async()=>{
 const f=fixture('requests');try{
  const events=[];
  assert.equal((await f.adapter.run({...input(f),onEvent:event=>events.push(event)})).status,'completed');
  const replies=readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse).filter(m=>!m.method);
  const initialize=readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse).find(m=>m.method==='initialize');
  assert.deepEqual(initialize.params.clientCapabilities.fs,{readTextFile:true,writeTextFile:true});
  assert.equal(replies.find(m=>m.id===100).result.content,'Project fixture');
  for(const id of [101,102,103,104])assert.ok(replies.find(m=>m.id===id).error);
  assert.equal(replies.find(m=>m.id===105).result.outcome.outcome,'cancelled');
  assert.ok(events.some(event=>event.type==='approval.denied'&&event.data.method==='fs/write_text_file'));
  assert.equal(readFileSync(join(f.workspace,'README.md'),'utf8'),'Project fixture');
 }finally{f.close();}
});

for(const mode of ['delayed-init','delayed-session'])test(`workspace redirection during ${mode} aborts before prompt`,async()=>{
 const f=fixture(mode);try{
  const pending=f.adapter.run(input(f));
  await new Promise(resolve=>setTimeout(resolve,10));
  const redirected=join(f.root,'redirected');
  mkdirSync(redirected); writeFileSync(join(redirected,'README.md'),'REDIRECTED');
  rmSync(f.workspace,{recursive:true}); symlinkSync(redirected,f.workspace);
  await assert.rejects(pending,/workspace directory changed|canonical workspace/);
  assert.equal(readFileSync(f.calls,'utf8').includes('session/prompt'),false);
 }finally{f.close();}
});

test('the public adapter refuses all native execution while the workspace boundary is unverified',async()=>{
 const f=fixture();try{
  const adapter=new GrokAdapter({executable:f.executable,readConfig:()=>undefined});
  await assert.rejects(adapter.run(input(f)),/Grok execution is unavailable/);
  assert.equal(readFileSync(f.calls,'utf8'),'');
 }finally{f.close();}
});

 test('Code writes edit and create files but cannot write outside scope or across sessions',async()=>{
 const f=fixture('code-requests');try{
  const events=[];
  assert.equal((await f.adapter.run({...input(f),executionMode:'code',onEvent:e=>events.push(e)})).status,'completed');
  const replies=readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse).filter(m=>!m.method);
  assert.deepEqual(replies.find(m=>m.id===104).result,{});
  assert.deepEqual(replies.find(m=>m.id===106).result,{});
  for(const id of [107,108,109,110])assert.ok(replies.find(m=>m.id===id).error);
  assert.equal(readFileSync(join(f.workspace,'README.md'),'utf8'),'CHANGED');
  assert.equal(readFileSync(join(f.workspace,'created/new.txt'),'utf8'),'NEW FILE');
  assert.equal(readFileSync(join(f.root,'outside.txt'),'utf8'),'OUTSIDE');
  assert.ok(events.some(e=>e.type==='session.started'&&e.data.executionMode==='code'));
 }finally{f.close();}
});

test('late native tool expansion terminates the run before accepting further writes',async()=>{
 const f=fixture('late-catalog');try{
  await assert.rejects(f.adapter.run({...input(f),executionMode:'code'}),/tool catalog changed/);
  assert.equal(readFileSync(join(f.workspace,'README.md'),'utf8'),'Project fixture');
 }finally{f.close();}
});
