import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('desktop sends through IPC, shows native activity and reopens durable history without repeating work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-desktop-'));
  const home = join(root, 'home'); const project = join(root, 'sample-project'); const bin = join(root, 'bin');
  for (const path of [home, project, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Sample project\nA test workspace.\n');
  const calls = join(root, 'turns.log');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + `
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
if(process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture'}}});
 else if(m.method==='turn/start'){
  appendFileSync(${JSON.stringify(calls)},'turn\\n');
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  send({method:'item/started',params:{item:{id:'inspect',type:'commandExecution',command:'read README.md'}}});
  setTimeout(()=>send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'I can see the fixture project.'}}),250);
  setTimeout(()=>send({method:'turn/completed',params:{turn:{id:'turn-fixture',status:'completed'}}}),500);
 }else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, RANDOLPH_DATA_DIR: join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [resolve('.')], env });
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Bring a project into focus' })).toBeVisible();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('fixture-model');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Describe the project');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('I can see the fixture project.', { exact: true })).toBeVisible();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText('completed');
    const snapshot = await page.evaluate(async () => await (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(2);
    expect(readFileSync(join(snapshot.runs[0]!.logsPath!, 'events.jsonl'), 'utf8')).toContain('message.delta');
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
    expect(errors).toEqual([]);
    await app.close();
    app = await electron.launch({ args: [resolve('.')], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Describe the project', exact: true }).click();
    await expect(page.getByText('I can see the fixture project.', { exact: true })).toBeVisible();
    expect(readFileSync(calls, 'utf8')).toBe('turn\n');
    await page.screenshot({ path: join(tmpdir(), 'randolph-desktop-workspace.png') });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
