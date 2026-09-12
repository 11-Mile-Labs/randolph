import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('code work stays isolated until checked and explicitly approved in the desktop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-code-ui-'));
  const project = join(root, 'project'); const home = join(root, 'home'); const bin = join(root, 'bin');
  for (const dir of [project, home, bin]) mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(project, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(project, 'value.txt'), 'before\n');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.8.0', scripts: { test: 'node --test' } }));
  git('add', '.'); git('commit', '-m', 'seed');
  const base = git('rev-parse', 'HEAD');
  const turns = join(root, 'turns.log');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + `
const {createInterface}=require('node:readline');
const {writeFileSync,appendFileSync}=require('node:fs');
const {join}=require('node:path');
if(process.argv.includes('--version')) { console.log('codex-cli 0.149.0'); process.exit(0); }
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let cwd='';let code=false;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return; const p=m.params||{};
 if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}});
 else if(m.method==='thread/start'){
  cwd=p.cwd;code=p.sandbox==='workspace-write';
  send({id:m.id,result:{thread:{id:'fixture-thread'},cwd,approvalPolicy:'never',sandbox:code?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly'}}});
 }else if(m.method==='turn/start'){
  if(code&&p.sandboxPolicy?.type==='workspaceWrite')writeFileSync(join(cwd,'value.txt'),'after\\n');
  appendFileSync(${JSON.stringify(turns)},'turn\\n');
  send({id:m.id,result:{turn:{id:'fixture-turn'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Updated value.txt. Ready for review.'}});
  send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});
 }else if(m.method==='command/exec'){
  if(p.sandboxPolicy?.type!=='workspaceWrite'||p.sandboxPolicy.networkAccess!==false)throw Error('unsafe verification policy');
  send({method:'command/exec/outputDelta',params:{processId:p.processId,stream:'stdout',capReached:false,deltaBase64:Buffer.from('Fixture check is running').toString('base64')}});
  setTimeout(()=>send({id:m.id,result:{exitCode:0,stdout:'Fixture checks passed.',stderr:''}}),1000);
 }else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, RANDOLPH_DATA_DIR: join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: [resolve('.')], env });
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await page.getByRole('combobox', { name: 'Conversation mode' }).selectOption('code');
    await expect(page.getByRole('combobox', { name: 'Conversation mode' })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Update the value');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Updated value.txt. Ready for review.', { exact: true })).toBeVisible();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText('completed');
    expect(readFileSync(join(project, 'value.txt'), 'utf8')).toBe('before\n');
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review changes' })).toBeVisible();
    await expect(page.getByText('value.txt', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve commit and merge', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Run project checks', exact: true }).click();
    await expect(page.getByLabel('Live check output')).toContainText('Fixture check is running');
    await expect(page.getByRole('button', { name: 'Approve commit and merge', exact: true })).toBeDisabled();
    await expect(page.getByText('Checks passed', { exact: true })).toBeVisible();
    expect(git('rev-parse', 'HEAD')).toBe(base);
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Apply fixture update');
    await page.getByRole('checkbox', { name: 'I reviewed the changes and checks' }).check();
    await page.screenshot({ path: join(tmpdir(), 'randolph-code-review.png') });
    await page.getByRole('button', { name: 'Approve commit and merge', exact: true }).click();
    await expect(page.getByText('Local delivery complete', { exact: true })).toBeVisible();
    const snapshot = await page.evaluate(() => (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    expect(snapshot.reviews[0]!.status).toBe('delivered');
    expect(snapshot.reviews[0]!.cleaned).toBe(true);
    expect(existsSync(snapshot.runs[0]!.workspace)).toBe(false);
    expect(readFileSync(join(project, 'value.txt'), 'utf8')).toBe('after\n');
    expect(git('rev-parse', 'HEAD^')).toBe(base);
    await app.close();
    app = await electron.launch({ args: [resolve('.')], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Update the value', exact: true }).click();
    await expect(page.getByText('Updated value.txt. Ready for review.', { exact: true })).toBeVisible();
    expect(git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(readFileSync(turns, 'utf8')).toBe('turn\n');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
