import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('workspace and native Settings are discoverable before chat, persist preferences, and reopen from background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-navigation-'));
  const home = join(root, 'home'),
    bin = join(root, 'bin'),
    project = join(root, 'project');
  for (const dir of [home, bin, project]) mkdirSync(dir);
  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\n
if(process.argv.includes('--version')) {console.log('codex-cli 0.149.0');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;if(m.method==='turn/start')throw Error('Navigation must never launch a model.'); const result=m.method==='account/read'?{account:{type:'chatgpt'}}:m.method==='model/list'?{data:[{model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin + ':' + process.env.PATH,
    RANDOLPH_DATA_DIR: join(root, 'data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      executablePath: process.env.RANDOLPH_TEST_EXECUTABLE,
      args: process.env.RANDOLPH_TEST_EXECUTABLE ? [] : [resolve('.')],
      env,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your projects, in one place.' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Application', exact: true })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await page
      .getByRole('checkbox', { name: 'Keep app-managed work running when the window closes' })
      .check();
    await page.getByRole('checkbox', { name: 'Automatically approve new global lessons' }).check();
    await page.getByRole('button', { name: 'Save app settings', exact: true }).click();
    await expect(page.getByText('Application settings saved.', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(
      page.getByRole('checkbox', { name: 'Automatically approve new global lessons' }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Save global lesson policy' }).click();
    await expect(page.getByText('Global lesson policy saved.')).toBeVisible();
    const menu = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!.items[0]!.submenu!.items.map((item) => ({
        label: item.label,
        accelerator: item.accelerator,
      })),
    );
    expect(menu).toContainEqual({ label: 'Settings…', accelerator: 'CommandOrControl+,' });
    expect(menu.some((item) => item.label === 'Quit Randolph')).toBe(true);
    await page
      .getByRole('navigation', { name: 'Application', exact: true })
      .getByRole('button', { name: 'Workspace', exact: true })
      .click();
    await page.keyboard.press('Meta+,');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    ).toBe(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
    const fresh = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.items[0]!.submenu!.items.find(
        (item) => item.label === 'Settings…',
      )!;
      Reflect.apply(item.click, item, [item, undefined, {}]);
    });
    page = await fresh;
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
    await page.screenshot({ path: join(tmpdir(), 'randolph-app-settings.png') });
    await page
      .getByRole('navigation', { name: 'Application', exact: true })
      .getByRole('button', { name: 'Workspace', exact: true })
      .click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
    const projects = page.getByRole('navigation', { name: 'Project conversations', exact: true });
    await projects.getByRole('button', { name: 'Project settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Project settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await projects.getByRole('button', { name: 'Run history', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Run history' })).toBeVisible();
    await page.getByRole('button', { name: 'Close history' }).click();
    await projects.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Memory' })).toBeVisible();
    await app.close();
    expect(readFileSync(join(root, 'data', 'config.app.yaml'), 'utf8')).toContain('theme: dark');
    expect(readFileSync(join(root, 'data', 'config.memory.yaml'), 'utf8')).toContain(
      'autoApprove: true',
    );
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
