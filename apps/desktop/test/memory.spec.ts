import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('memory UI reviews versions and resolves stale pins without launching model work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-memory-ui-'));
  const project = join(root, 'project'); const bin = join(root, 'bin'); const home = join(root, 'home');
  for (const path of [project, bin, home]) mkdirSync(path);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + `
if(process.argv.includes('--version')) {console.log('codex-cli 0.149.0');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 if(m.method==='turn/start')throw Error('Memory actions must never start a model');
 const result=m.method==='account/read'?{account:{type:'chatgpt'}}:m.method==='model/list'?{data:[{model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, RANDOLPH_DATA_DIR: join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('.')], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await page.getByRole('navigation', { name: 'Project conversations', exact: true }).getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByRole('textbox', { name: 'Lesson title', exact: true }).fill('Preserve migration evidence');
    await page.getByRole('textbox', { name: 'Lesson text', exact: true }).fill('Retain the database verification result.');
    await page.getByRole('button', { name: 'Create lesson' }).click();
    await expect(page.getByText('project · v1 · draft', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve lesson', exact: true }).click();
    await page.getByRole('button', { name: 'Pin this version', exact: true }).click();
    await expect(page.getByText('project · v1 · approved · pinned', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Lesson text', exact: true }).fill('Retain updated database verification evidence.');
    await expect(page.getByRole('button', { name: 'Approve lesson', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Save new version', exact: true }).click();
    await expect(page.getByText('project · v2 · draft · pinned', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve lesson', exact: true }).click();
    await page.getByRole('button', { name: 'Update pin to v2', exact: true }).click();
    await page.getByRole('button', { name: 'Version history', exact: true }).click();
    await expect(page.getByText('Version 1 · superseded', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), 'randolph-memory.png') });
    await page.getByRole('button', { name: 'Close memory' }).click();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
