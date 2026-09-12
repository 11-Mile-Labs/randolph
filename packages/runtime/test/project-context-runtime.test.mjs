import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { readProjectContext, writeProjectContext } from '../dist/project-context.js';

function fixture(t, result = 'completed') {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'randolph-context-runtime-')));
 const project=join(root,'project');
 execFileSync('/usr/bin/git',['init','-b','main',project],{stdio:'ignore'});
 writeFileSync(join(project,'README.md'),'Fixture\n');
 for(const args of [['add','README.md'],['commit','-m','base']])execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',project,...args],{stdio:'ignore'});
 const calls=[];const adapter={async installations(){return[{executable:'/fixture'}];},async discover(){return{available:true,authenticated:true,executable:'/fixture',version:'1',models:[{id:'fixture',name:'Fixture',efforts:['low'],defaultEffort:'low'}],executionModes:['read-only']};},async run(input){calls.push(input);return{status:result};}};
 const data=join(root,'data');const runtime=new Runtime(adapter,data);const registered=runtime.addProject(project);let closed=false;
 t.after(async()=>{if(!closed)await runtime.close();rmSync(root,{recursive:true,force:true});});
 return {project,runtime,calls,registered,data,close:async()=>{if(!closed){closed=true;await runtime.close();}}};
}
async function settle(runtime){for(let i=0;i<200&&runtime.hasActiveWork();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(runtime.hasActiveWork(),false);}

test('runs retain approved context revisions and checkpoint reruns use them after configuration changes',async t=>{
 const f=fixture(t);const before=writeProjectContext(f.project,{purpose:'Original purpose',instructions:'First guidance',documents:[]},null);
 const conversation=f.runtime.createConversation(f.registered.id);
 const run=await f.runtime.send({conversationId:conversation.id,text:'Inspect'});await settle(f.runtime);
 assert.equal(run.projectContext.revision,before.revision);
 assert.ok(f.calls[0].messages[0].text.includes('Original purpose'));
 const checkpoint=new Checkpoints(f.runtime.store).capture(f.runtime.snapshot().runs.find(item=>item.id===run.id),'completed-turn');
 const after=writeProjectContext(f.project,{purpose:'Updated purpose',instructions:'Later guidance',documents:[]},before.revision);
 const rerun=await f.runtime.rerunFromCheckpoint({runId:run.id,checkpointDigest:checkpoint.digest});await settle(f.runtime);
 assert.equal(rerun.run.projectContext.revision,before.revision);
 assert.ok(f.calls[1].messages[0].text.includes('Original purpose'));
 assert.equal(f.calls[1].messages.some(message=>message.text.includes('Updated purpose')),false);
 const next=await f.runtime.send({conversationId:conversation.id,text:'Inspect again'});await settle(f.runtime);
 assert.equal(next.projectContext.revision,after.revision);
 assert.equal(readProjectContext(f.project).value.purpose,'Updated purpose');
});

test('invalid approved context prevents native dispatch without recording a run',async t=>{
 const f=fixture(t);writeFileSync(join(f.project,'config.project.yaml'),'schemaVersion: 1\npurpose: [broken\n');
 const conversation=f.runtime.createConversation(f.registered.id);
 await assert.rejects(f.runtime.send({conversationId:conversation.id,text:'Inspect'}),/valid YAML/);
 assert.equal(f.calls.length,0);assert.equal(f.runtime.snapshot().runs.length,0);
});

test('frozen approved context survives runtime close and explicit same-conversation restart',async t=>{
 const f=fixture(t,'interrupted');const before=writeProjectContext(f.project,{purpose:'Original purpose',instructions:'First guidance',documents:[]},null);
 const conversation=f.runtime.createConversation(f.registered.id);
 const original=await f.runtime.send({conversationId:conversation.id,text:'Resume this work'});await settle(f.runtime);
 const source=f.runtime.snapshot().runs.find(item=>item.id===original.id);
 assert.equal(source.status,'interrupted');assert.equal(source.projectContext.revision,before.revision);
 await f.close();
 writeProjectContext(f.project,{purpose:'New purpose',instructions:'New guidance',documents:[]},before.revision);
 const reopened=new Runtime(f.runtime.adapter,f.data);
 t.after(async()=>{await reopened.close();});
 const result=await reopened.restartRun({runId:source.id,checkpointDigest:source.checkpoints[0].digest});await settle(reopened);
 assert.equal(result.conversation.id,conversation.id);
 assert.equal(result.run.projectContext.revision,before.revision);
 assert.equal(result.run.projectContext.value.purpose,'Original purpose');
 assert.equal(f.calls.length,2);
 assert.ok(f.calls[1].messages.some(message=>message.text.includes('Original purpose')));
 assert.equal(f.calls[1].messages.some(message=>message.text.includes('New purpose')),false);
});

test('legacy checkpoint without project context does not inject newer settings on rerun',async t=>{
 const f=fixture(t);const conversation=f.runtime.createConversation(f.registered.id);
 const run=await f.runtime.send({conversationId:conversation.id,text:'Legacy retained work'});await settle(f.runtime);
 const source=f.runtime.snapshot().runs.find(item=>item.id===run.id);
 delete source.projectContext;
 f.runtime.store.putRun(source);f.runtime.store.exportRun(source);
 const checkpoint=new Checkpoints(f.runtime.store).capture(source,'completed-turn');
 writeProjectContext(f.project,{purpose:'New purpose',instructions:'New guidance',documents:[]},null);
 const result=await f.runtime.rerunFromCheckpoint({runId:source.id,checkpointDigest:checkpoint.digest});await settle(f.runtime);
 assert.equal(result.run.projectContext,undefined);
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].messages.some(message=>message.text.includes('New purpose')),false);
 assert.deepEqual(result.run.recoveryMessages,[{role:'user',text:'Legacy retained work'}]);
});
