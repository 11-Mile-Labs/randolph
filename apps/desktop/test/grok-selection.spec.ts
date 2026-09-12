import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('Grok discovery blocks unverified execution and a Codex override uses the matching executable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-grok-e2e-'));
  const home = join(root, 'home'); const project = join(root, 'project'); const bin = join(root, 'bin');
  for (const path of [home, project, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Grok fixture\n');
  const calls = join(root, 'calls.jsonl');
  const executable = join(bin, 'grok');
  const codex = join(bin, 'codex');
  writeFileSync(executable, `#!${process.execPath}\n` + `
const {createInterface}=require('node:readline'); const {appendFileSync}=require('node:fs');
const calls=${JSON.stringify(calls)}; const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const models={currentModelId:'grok-4.6',availableModels:[{modelId:'grok-4.6',name:'Grok 4.6',_meta:{reasoningEfforts:[{id:'low',default:true},{id:'high',default:false}]}}]};
if(process.argv.includes('--version')){console.log('grok 1.0.25 (f7e67d6988e2) [stable]');process.exit(0);}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(calls,JSON.stringify({method:m.method,params:m.params})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:'1.0.25',defaultAuthMethodId:'cached_token',modelState:models}}});
 else if(m.method==='authenticate')send({id:m.id,result:{_meta:{auth_mode:'Oidc',backend_billed:false,subscription_tier:'SuperGrok Heavy'}}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native-session',models,configOptions:[{id:'reasoning_effort',currentValue:m.params._meta.reasoningEffort}]}});
 else if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Grok read-only response'}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
});
`, { mode: 0o700 });
  writeFileSync(codex, `#!${process.execPath}\nconst r=require('node:readline').createInterface({input:process.stdin});const s=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(process.argv.includes('--version')){console.log('codex-cli 0.149.0');process.exit(0);}r.on('line',l=>{const m=JSON.parse(l);if(m.method==='account/read')s({id:m.id,result:{account:{type:'chatgpt'}}});else if(m.method==='model/list')s({id:m.id,result:{data:[{model:'codex-model',displayName:'Codex model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}});else if(m.method==='thread/start')s({id:m.id,result:{thread:{id:'codex-thread'}}});else if(m.method==='turn/start'){s({id:m.id,result:{turn:{id:'codex-turn'}}});s({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Codex override response'}});s({method:'turn/completed',params:{turn:{id:'codex-turn',status:'completed'}}});}else if(m.id)s({id:m.id,result:{}});});`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, RANDOLPH_DATA_DIR: join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RANDOLPH_TEST_EXECUTABLE, args: process.env.RANDOLPH_TEST_EXECUTABLE ? [] : [resolve('.')], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await page.getByRole('navigation', { name: 'Project conversations', exact: true }).getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Harness', exact: true }).selectOption('grok');
    await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue('grok-4.6');
    await expect(page.getByText('Execution compatibility pending', {exact:false})).toBeVisible();
    await expect(page.getByText('Read-only; Code compatibility unverified', {exact:false})).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Grok CLI', exact: true }).selectOption(executable);
    await page.getByRole('button', { name: 'Save project defaults', exact: true }).click();
    await expect(page.getByText('Project defaults saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Conversation harness', exact: true })).toHaveValue('grok');
    await expect(page.getByRole('option', { name: 'Code', exact: true })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect with Grok');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert').filter({hasText:'Grok execution is unavailable'})).toBeVisible();
    const denied = await page.evaluate(async () => {
      const bridge = (window as unknown as { randolph: DesktopBridge }).randolph;
      const snapshot = await bridge.snapshot();
      try { await bridge.send({conversationId:snapshot.conversations[0]!.id,text:'Attempt direct IPC'}); return 'unexpected success'; }
      catch (cause) { return String(cause); }
    });
    expect(denied).toContain('Grok execution is unavailable');
    expect(readFileSync(calls, 'utf8')).not.toContain('session/prompt');
    await page.getByRole('combobox', { name: 'Conversation harness', exact: true }).selectOption('codex');
    await expect(page.getByRole('combobox', { name: 'Conversation harness', exact: true })).toHaveValue('codex');
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('codex-model');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use Codex override');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Codex override response', { exact: true })).toBeVisible();
    const overridden = await page.evaluate(async () => await (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    expect(overridden.runs.at(-1)!.harness).toBe('codex');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
