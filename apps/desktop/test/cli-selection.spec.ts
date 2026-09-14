import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '@randolph/runtime/contracts';

test('project CLI selection changes discovered models and dispatches only the selected executable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-cli-')));
  const home = join(root, 'home'),
    project = join(root, 'project'),
    first = join(root, 'first'),
    second = join(root, 'second');
  for (const path of [home, project, first, second]) mkdirSync(path);
  const calls = join(root, 'turns.log');
  for (const [directory, name] of [
    [first, 'first'],
    [second, 'second'],
  ] as const)
    writeFileSync(
      join(directory, 'codex'),
      `#!${process.execPath}\n` +
        `
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
if(process.argv.includes('--version')) { console.log('codex-cli ${name}'); process.exit(0); }
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{model:'${name}-model',displayName:'${name} model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture'}}});
 else if(m.method==='turn/start'){
  appendFileSync(${JSON.stringify(calls)},'${name}\\n');
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'answer',delta:'Response from ${name} CLI'}});
  send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
 }else send({id:m.id,result:{}});
});
`,
      { mode: 0o700 },
    );
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${first}:${second}:/usr/bin:/bin`,
    RANDOLPH_DATA_DIR: join(root, 'data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.RANDOLPH_TEST_EXECUTABLE,
    args: process.env.RANDOLPH_TEST_EXECUTABLE ? [] : [resolve('.')],
    env,
  });
  if (process.env.RANDOLPH_TEST_EXECUTABLE)
    expect(await app.evaluate(({ app }) => app.getPath('exe'))).toBe(
      process.env.RANDOLPH_TEST_EXECUTABLE,
    );
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await page
      .getByRole('navigation', { name: 'Project conversations', exact: true })
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Codex CLI', exact: true })
      .selectOption(join(second, 'codex'));
    await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue(
      'second-model',
    );
    await page.getByRole('button', { name: 'Save project defaults', exact: true }).click();
    await expect(page.getByText('Project defaults saved.', { exact: true })).toBeVisible();
    expect(readFileSync(join(project, 'config.harness.yaml'), 'utf8')).toContain(
      join(second, 'codex'),
    );
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
      'second-model',
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Response from second CLI', { exact: true })).toBeVisible();
    expect(readFileSync(calls, 'utf8')).toBe('second\n');
    const snapshot = await page.evaluate(() =>
      (window as unknown as { randolph: DesktopBridge }).randolph.snapshot(),
    );
    expect(snapshot.runs[0]?.executable).toBe(join(second, 'codex'));
    await page
      .getByRole('navigation', { name: 'Project conversations', exact: true })
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await expect(page.getByRole('combobox', { name: 'Codex CLI', exact: true })).toHaveValue(
      join(second, 'codex'),
    );
    await page.getByRole('combobox', { name: 'Codex CLI', exact: true }).selectOption('');
    await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue(
      'first-model',
    );
    await page.getByRole('button', { name: 'Save project defaults', exact: true }).click();
    await expect(page.getByText('Project defaults saved.', { exact: true })).toBeVisible();
    expect(readFileSync(join(project, 'config.harness.yaml'), 'utf8')).toContain(
      'executable: null',
    );
    expect(readFileSync(calls, 'utf8')).toBe('second\n');
    await page.getByRole('button', { name: 'Set project CLI permissions', exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: `Allow codex · ${join(first, 'codex')}`, exact: true }),
    ).toBeChecked();
    await page
      .getByRole('checkbox', { name: `Allow codex · ${join(first, 'codex')}`, exact: true })
      .uncheck();
    await page.getByRole('button', { name: 'Save project defaults', exact: true }).click();
    await expect(page.getByText('Project defaults saved.', { exact: true })).toBeVisible();
    expect(readFileSync(join(project, 'config.harness.yaml'), 'utf8')).toContain(
      'enabledRoutes: []',
    );
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('This route is disabled');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.getByText(/^Message was not sent:.*This harness CLI is not enabled for this project/),
    ).toBeVisible();
    expect(readFileSync(calls, 'utf8')).toBe('second\n');
    await page
      .getByRole('navigation', { name: 'Project conversations', exact: true })
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await expect(
      page.getByRole('checkbox', { name: `Allow codex · ${join(first, 'codex')}`, exact: true }),
    ).not.toBeChecked();
    await page.locator('.route-permissions').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('project-cli-permissions.png') });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
