import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('explicit checkpoint recovery preserves history, restarts in place, and reruns in a linked conversation', async () => {
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
const {writeFileSync,appendFileSync,readFileSync}=require('node:fs');
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
  send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Retained recovery fixture response.'}});
  send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:readFileSync(${JSON.stringify(turns)},'utf8').trim().split('\\n').length===1?'interrupted':'completed'}}});
 }else if(m.method==='command/exec'){
  if(p.sandboxPolicy?.type!=='workspaceWrite'||p.sandboxPolicy.networkAccess!==false)throw Error('unsafe verification policy');
  send({method:'command/exec/outputDelta',params:{processId:p.processId,stream:'stdout',capReached:false,deltaBase64:Buffer.from('Fixture check is running').toString('base64')}});
  setTimeout(()=>send({id:m.id,result:{exitCode:0,stdout:'Fixture checks passed.',stderr:''}}),1000);
 }else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, RANDOLPH_DATA_DIR: join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ executablePath: process.env.RANDOLPH_TEST_EXECUTABLE, args: process.env.RANDOLPH_TEST_EXECUTABLE ? [] : [resolve('.')], env });
  let app = await launch();
  if (process.env.RANDOLPH_TEST_EXECUTABLE) expect(await app.evaluate(({ app }) => app.getPath('exe'))).toBe(process.env.RANDOLPH_TEST_EXECUTABLE);
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await page.getByRole('combobox', { name: 'Conversation mode' }).selectOption('code');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Recover this change');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText('interrupted');
    const original = await page.evaluate(() => (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    const projectNavigation = page.getByRole('navigation', { name: 'Project conversations', exact: true });
    await projectNavigation.getByRole('button', { name: 'Run history', exact: true }).click();
    let history = page.getByRole('dialog', { name: 'Run history' });
    await history.getByRole('button', { name: 'Restart from checkpoint', exact: true }).click();
    await expect(history.getByRole('region', { name: 'Confirm checkpoint execution' })).toContainText('same conversation');
    expect(readFileSync(turns, 'utf8')).toBe('turn\n');
    await history.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
    expect(readFileSync(turns, 'utf8')).toBe('turn\n');
    await history.getByRole('button', { name: 'Restart from checkpoint', exact: true }).click();
    await history.getByRole('button', { name: 'Start linked run', exact: true }).click();
    await expect(history).not.toBeVisible();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText('completed');
    const restarted = await page.evaluate(() => (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    expect(restarted.conversations).toHaveLength(1);
    expect(restarted.runs).toHaveLength(2);
    const restart = restarted.runs.find(run => run.id !== original.runs[0]!.id)!;
    expect(restart.sourceRunId).toBe(original.runs[0]!.id);
    expect(restart.conversationId).toBe(original.conversations[0]!.id);
    expect(restart.workspace).not.toBe(original.runs[0]!.workspace);
    expect(restarted.runs.find(run => run.id === original.runs[0]!.id)!.status).toBe('interrupted');
    await projectNavigation.getByRole('button', { name: 'Run history', exact: true }).click();
    history = page.getByRole('dialog', { name: 'Run history' });
    await expect(history.getByText('Restarted from', { exact: false })).toBeVisible();
    await history.locator('.checkpoint-card').filter({ hasText: 'Completed turn' }).getByRole('button', { name: 'Rerun in new conversation', exact: true }).click();
    await expect(history.getByRole('region', { name: 'Confirm checkpoint execution' })).toContainText('new linked conversation');
    expect(readFileSync(turns, 'utf8')).toBe('turn\nturn\n');
    await history.getByRole('button', { name: 'Start linked run', exact: true }).click();
    await expect(history).not.toBeVisible();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText('completed');
    const rerun = await page.evaluate(() => (window as unknown as { randolph: DesktopBridge }).randolph.snapshot());
    expect(rerun.conversations).toHaveLength(2);
    expect(rerun.runs).toHaveLength(3);
    const linked = rerun.runs.find(run => run.recoveryKind === 'rerun')!;
    expect(linked.sourceRunId).toBe(restart.id);
    expect(linked.conversationId).not.toBe(restart.conversationId);
    expect(rerun.reviews).toHaveLength(0);
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(readFileSync(join(project, 'value.txt'), 'utf8')).toBe('before\n');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your projects, in one place.' })).toBeVisible();
    expect(readFileSync(turns, 'utf8')).toBe('turn\nturn\nturn\n');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
