import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('project setup requires inspection and explicit approval, preserves edits, and stops without configuring the project',async()=>{
 const root=mkdtempSync(join(tmpdir(),'randolph-setup-e2e-'));const home=join(root,'home'),project=join(root,'project'),bin=join(root,'bin');
 for(const path of [home,project,bin])mkdirSync(path,{recursive:true});
 writeFileSync(join(project,'README.md'),'Uncommitted project idea\n');const calls=join(root,'calls.jsonl');writeFileSync(calls,'');
 const proposal={context:{purpose:'Inspected project purpose',instructions:'Proposed guidance',documents:[{path:'README.md',description:'Project overview'}]},evidence:['Read the existing README.'],questions:['Which milestone comes first?']};
 writeFileSync(join(bin,'codex'),`#!${process.execPath}\n`+`
const {createInterface}=require('node:readline');const {appendFileSync}=require('node:fs');const calls=${JSON.stringify(calls)},proposal=${JSON.stringify(JSON.stringify(proposal))};const s=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.149.0');process.exit(0);}
createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);appendFileSync(calls,JSON.stringify(m)+'\\n');if(m.method==='account/read')s({id:m.id,result:{account:{type:'chatgpt'}}});else if(m.method==='model/list')s({id:m.id,result:{data:[{model:'fixture',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}});else if(m.method==='thread/start')s({id:m.id,result:{thread:{id:'setup-thread'}}});else if(m.method==='turn/start'){s({id:m.id,result:{turn:{id:'setup-turn'}}});if(!JSON.stringify(m.params).includes('Wait for cancellation')){s({method:'item/agentMessage/delta',params:{itemId:'proposal',delta:proposal}});s({method:'turn/completed',params:{turn:{id:'setup-turn',status:'completed'}}});}}else if(m.id)s({id:m.id,result:{}});});
`,{mode:0o700});
 const env={...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,RANDOLPH_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({executablePath:process.env.RANDOLPH_TEST_EXECUTABLE,args:process.env.RANDOLPH_TEST_EXECUTABLE?[]:[resolve('.')],env});
 try{
  const page=await app.firstWindow();await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},project);
  await page.getByRole('button',{name:'Add your first project'}).click();
  await page.getByRole('navigation',{name:'Project conversations',exact:true}).getByRole('button',{name:'Project setup',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Project setup',exact:true});
  await expect(dialog.getByText('No approved purpose yet.',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Inspect project',exact:true})).toBeEnabled();
  expect(readFileSync(calls,'utf8')).not.toContain('turn/start');
  await dialog.getByRole('textbox',{name:'Setup idea or corrections',exact:true}).fill('Inspect this project.');
  await dialog.getByRole('button',{name:'Inspect project',exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:'Proposed purpose',exact:true})).toHaveValue('Inspected project purpose');
  expect(existsSync(join(project,'config.project.yaml'))).toBe(false);
  await dialog.getByRole('textbox',{name:'Proposed instructions',exact:true}).fill('User correction\nKeep it small.');
  await page.evaluate(async()=>{const bridge=(window as unknown as {randolph:DesktopBridge}).randolph;const snapshot=await bridge.snapshot();await bridge.createConversation(snapshot.projects[0]!.id);});
  await expect(dialog.getByRole('textbox',{name:'Proposed instructions',exact:true})).toHaveValue('User correction\nKeep it small.');
  await dialog.getByRole('button',{name:'Approve project context',exact:true}).click();
  await expect.poll(()=>existsSync(join(project,'config.project.yaml'))).toBe(true);
  expect(readFileSync(join(project,'config.project.yaml'),'utf8')).toContain('User correction');
  expect(readFileSync(join(project,'README.md'),'utf8')).toBe('Uncommitted project idea\n');
  await expect(dialog.getByRole('button',{name:'Approve project context',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'Close project setup',exact:true}).click();
  const turns=readFileSync(calls,'utf8').split('\n').filter(line=>line.includes('turn/start')).length;
  await page.getByRole('navigation',{name:'Project conversations',exact:true}).getByRole('button',{name:'Project setup',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Inspect project',exact:true})).toBeEnabled();
  expect(readFileSync(calls,'utf8').split('\n').filter(line=>line.includes('turn/start'))).toHaveLength(turns);
  const saved=readFileSync(join(project,'config.project.yaml'),'utf8');
  await dialog.getByRole('textbox',{name:'Setup idea or corrections',exact:true}).fill('Wait for cancellation');
  await dialog.getByRole('button',{name:'Inspect project',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Stop inspection',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'Stop inspection',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Stop inspection',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Approve project context',exact:true})).toBeDisabled();
  expect(readFileSync(join(project,'config.project.yaml'),'utf8')).toBe(saved);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
