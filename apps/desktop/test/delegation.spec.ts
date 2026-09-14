import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../../../packages/runtime/dist/index.js';
import { Checkpoints } from '../../../packages/runtime/dist/checkpoints.js';
import { retainedDelegationBasis } from '../../../packages/runtime/dist/delegation-basis.js';
import { DelegationControls } from '../../../packages/runtime/dist/delegation-control.js';
import { NativeOperationRecords } from '../../../packages/runtime/dist/native-operation-records.js';
import { DelegationRecords } from '../../../packages/runtime/dist/delegation-records.js';
import { workspaceIdentity } from '../../../packages/runtime/dist/workspace-identity.js';

const createdAt = '2026-09-12T00:00:00.000Z';
const mainModel = 'fixture-model';
const gridColumns = (element: Element) =>
  new Set([...element.querySelectorAll('label')].map((label) => (label as HTMLElement).offsetLeft))
    .size;
const scrollToPanelTop = (element: Element) => element.scrollIntoView({ block: 'start' });

function git(project: string, ...args: string[]): void {
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      project,
      ...args,
    ],
    { stdio: 'ignore' },
  );
}

function assignment(
  id: string,
  role: 'worker' | 'main-synthesis',
  source: 'run-basis' | `output:${string}`,
  dependencies: string[],
  producesSource = false,
) {
  return {
    id,
    task: `${id} task`,
    role,
    harness: 'codex' as const,
    executable: '',
    executableVersion: 'codex-cli 0.154.0',
    model: mainModel,
    effort: 'low',
    rationale: `${id} rationale`,
    dependencies,
    source,
    mode: 'read-only' as const,
    deliverables: [`${id} output`],
    completionCriteria: [`${id} complete`],
    ...(producesSource ? { producesSource: true } : {}),
  };
}

function plan(executable: string) {
  return {
    schemaVersion: 1 as const,
    id: 'fixture-plan',
    revision: 1,
    limits: { maxWorkers: 4, maxParallel: 2, maxAttempts: 2, activeMinutes: 30 },
    assignments: [
      { ...assignment('worker', 'worker', 'run-basis', [], true), executable },
      { ...assignment('synthesis', 'main-synthesis', 'output:worker', ['worker']), executable },
    ],
  };
}

function writeFixtureCli(path: string): void {
  writeFileSync(
    path,
    `#!${process.execPath}\nconst { createInterface } = require('node:readline');\nif (process.argv.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }\nconst send = value => process.stdout.write(JSON.stringify(value) + '\\n');\ncreateInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); if (!message.id) return; if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } }); else if (message.method === 'model/list') send({ id: message.id, result: { data: [{ model: '${mainModel}', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] } }); else send({ id: message.id, result: {} }); });\n`,
    { mode: 0o700 },
  );
}

function seed(retainedActivity: boolean | 'cleanup-only' = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-delegation-desktop-')));
  const home = join(root, 'home'),
    project = join(root, 'fixture-project'),
    bin = join(root, 'bin'),
    data = join(root, 'data');
  for (const path of [home, bin]) mkdirSync(path, { recursive: true });
  execFileSync('/usr/bin/git', ['init', '-b', 'main', project], { stdio: 'ignore' });
  writeFileSync(join(project, 'README.md'), '# Delegation fixture\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-m', 'fixture');
  const executable = join(bin, 'codex');
  writeFixtureCli(executable);
  const runtime = new Runtime({}, data);
  const registered = runtime.addProject(project);
  const conversation = runtime.createConversation(registered.id);
  runtime.store.putConversation({ ...conversation, title: 'Delegation fixture' });
  const run = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: registered.id,
    conversationId: conversation.id,
    status: 'completed' as const,
    cleanupUnconfirmed: false,
    harness: 'codex' as const,
    executable,
    executableVersion: 'codex-cli 0.154.0',
    enabledHarnessRoutes: [{ harness: 'codex' as const, executable }],
    harnessAuthorizationRevision: 'fixture-route',
    workspaceIdentity: workspaceIdentity(project),
    model: mainModel,
    effort: 'low',
    executionMode: 'read-only' as const,
    workspace: project,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
  };
  runtime.store.putRun(run);
  mkdirSync(runtime.store.runDirectory(run), { recursive: true });
  new Checkpoints(runtime.store).capture(run, 'completed-turn');
  const records = new DelegationRecords(runtime.store);
  const recorded = records.recordPlan({
    runId: run.id,
    revision: 1,
    requestId: 'fixture-request',
    source: 'proposal',
    basis: retainedDelegationBasis(runtime.store, run),
    plan: plan(executable),
  });
  records.readyPlan({
    runId: run.id,
    planId: recorded.id,
    digest: recorded.digest,
    basisDigest: recorded.basisDigest,
  });
  if (retainedActivity === true) {
    const exact = {
      runId: run.id,
      planId: recorded.id,
      digest: recorded.digest,
      basisDigest: recorded.basisDigest,
    };
    const authorization = records.authorize({ ...exact, decision: 'user', presetSaved: false });
    records.createTasks({ runId: run.id, authorizationId: authorization.id });
    const controls = new DelegationControls(runtime.store);
    controls.create(run.id, authorization.id);
    controls.command(run.id, 1, 'pause');
    const operations = new NativeOperationRecords(runtime.store);
    operations.create({
      id: 'retained-native',
      owner: { kind: 'run', id: run.id },
      runId: run.id,
      harness: 'codex',
      purpose: 'model-turn',
      generation: 1,
      origin: {},
      capacity: { role: 'main' },
    });
    operations.admit({ id: 'retained-native', expectedGeneration: 1 });
  }
  if (retainedActivity === 'cleanup-only')
    runtime.store.putRun({ ...run, status: 'interrupted', cleanupUnconfirmed: true });
  runtime.store.exportRun(runtime.store.runs().find((item) => item.id === run.id)!);
  return {
    root,
    home,
    project,
    data,
    conversationId: conversation.id,
    runId: run.id,
    original: recorded,
    close: () => runtime.close(),
  };
}

async function launch(seedValue: ReturnType<typeof seed>) {
  const env = {
    ...process.env,
    HOME: seedValue.home,
    PATH: `${join(seedValue.root, 'bin')}:${process.env.PATH}`,
    RANDOLPH_DATA_DIR: seedValue.data,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.RANDOLPH_TEST_EXECUTABLE,
    args: process.env.RANDOLPH_TEST_EXECUTABLE ? [] : [resolve('.')],
    env,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
  await page.waitForFunction(() => innerWidth >= 1300);
  await page.getByRole('button', { name: /^Delegation fixture(?: \d+ unread events)?$/ }).click();
  await expect(page.getByRole('heading', { name: 'Plan revision 1' })).toBeVisible();
  const basis = page.getByText('Source and approval basis');
  await basis.click();
  await expect(page.getByText(/"checkpointDigest"/)).toBeVisible();
  await expect(page.getByText(/"sourceTreeOid"/)).toBeVisible();
  await basis.click();
  return { app, page };
}

test('delegation keeps exact revisions, presets, and rejection separate from unavailable execution', async ({
  browserName: _browserName,
}, testInfo) => {
  const fixture = seed();
  const { app, page } = await launch(fixture);
  try {
    const panel = page.locator('.delegation-panel');
    await expect(page.getByLabel('Assignment 1 model')).toHaveValue(mainModel);
    await expect(page.getByLabel('Assignment 1 CLI version')).toHaveValue('codex-cli 0.154.0');
    await expect(page.getByText('Worker execution is not enabled in this build.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Authorize exact plan' })).toBeDisabled();
    await expect(page.locator('.delegation-limits').evaluate(gridColumns)).resolves.toBe(4);
    await expect(page.locator('.delegation-fields').first().evaluate(gridColumns)).resolves.toBe(4);
    await panel.evaluate(scrollToPanelTop);
    await page.screenshot({
      path: testInfo.outputPath('delegation-panel-1360-top.png'),
      fullPage: true,
    });
    await page.locator('.delegation-actions').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('delegation-panel-1360-bottom.png'),
      fullPage: true,
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900));
    await page.waitForFunction(() => innerWidth <= 1000);
    await expect(panel).toHaveJSProperty(
      'scrollWidth',
      await panel.evaluate((element) => element.clientWidth),
    );
    await expect(page.locator('.delegation-limits').evaluate(gridColumns)).resolves.toBe(2);
    await expect(page.locator('.delegation-fields').first().evaluate(gridColumns)).resolves.toBe(2);
    await panel.evaluate(scrollToPanelTop);
    await page.screenshot({
      path: testInfo.outputPath('delegation-panel-960-top.png'),
      fullPage: true,
    });
    await page.locator('.delegation-actions').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('delegation-panel-960-bottom.png'),
      fullPage: true,
    });
    await page.getByLabel('Assignment 1 task').fill('Edited worker task');
    await page.evaluate((id) => window.randolph.markRead(id), fixture.conversationId);
    await expect(page.getByLabel('Assignment 1 task')).toHaveValue('Edited worker task');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.getByRole('heading', { name: 'Plan revision 2' })).toBeVisible();
    await expect(page.getByLabel('Assignment 1 task')).toHaveValue('Edited worker task');
    await page.getByLabel('Preset ID').fill('fixture-preset');
    await page.getByLabel('Preset name').fill('Fixture preset');
    await page.getByRole('button', { name: 'Save preset' }).click();
    await expect(
      page.getByText('Preset saved. Saving a preset does not authorize execution.'),
    ).toBeVisible();
    writeFileSync(
      join(fixture.project, 'config.delegation.yaml'),
      'schemaVersion: 1\nrouting: balanced\ndefaultPresetId: null\npresets: []\n',
    );
    await page.getByLabel('Preset name').fill('Stale settings preset');
    await page.getByRole('button', { name: 'Save preset' }).click();
    await expect(page.getByRole('alert')).toContainText('Delegation settings changed');
    await expect(
      page.evaluate(
        async (input) => {
          try {
            await window.randolph.rejectDelegation(input);
            return 'accepted';
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        {
          runId: fixture.runId,
          planId: fixture.original.id,
          digest: fixture.original.digest,
          basisDigest: fixture.original.basisDigest,
        },
      ),
    ).resolves.not.toBe('accepted');
    await page.getByRole('button', { name: 'Reject plan' }).click();
    await expect(page.getByText('rejected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject plan' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save preset' })).toBeDisabled();
  } finally {
    await app.close();
    await fixture.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('delegation retains an invalid saved graph as an editable draft', async () => {
  const fixture = seed();
  const { app, page } = await launch(fixture);
  try {
    const deliverables = page.getByLabel('Assignment 1 deliverables');
    await deliverables.focus();
    await deliverables.press('End');
    await deliverables.press('Meta+ArrowDown');
    await deliverables.press('Enter');
    await expect(deliverables).toHaveValue('worker output\n');
    await deliverables.pressSequentially('second output');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.getByRole('heading', { name: 'Plan revision 2' })).toBeVisible();
    await expect(deliverables).toHaveValue('worker output\nsecond output');
    await page.getByLabel('Assignment 1 dependencies').fill('missing-assignment');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.getByRole('heading', { name: 'Plan revision 3' })).toBeVisible();
    await expect(page.getByLabel('Assignment 1 dependencies')).toHaveValue('missing-assignment');
    await expect(page.getByLabel('Approval blockers')).toContainText(
      'depends on unknown assignment',
    );
    await expect(page.getByLabel('Assignment 1 task')).toBeEnabled();
  } finally {
    await app.close();
    await fixture.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('run activity shows retained cleanup and tasks without starting execution on reopen', async ({
  browserName: _browserName,
}, testInfo) => {
  const fixture = seed(true);
  await fixture.close();
  const { app, page } = await launch(fixture);
  try {
    const activity = page.getByRole('region', { name: 'Run activity', exact: true });
    await expect(activity).toBeVisible();
    await expect(activity.getByText('interrupted', { exact: true })).toBeVisible();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText(
      'interrupted',
    );
    await expect(activity.getByText('Codex · Cleanup unconfirmed', { exact: true })).toBeVisible();
    await expect(activity.getByText(/App slots 1\/4/)).toBeVisible();
    await activity.getByText('Tasks (2)', { exact: true }).click();
    await expect(activity.getByText('worker task', { exact: true })).toBeVisible();
    await expect(activity.getByText('synthesis task', { exact: true })).toBeVisible();
    await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await activity.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('run-activity-1360.png'), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900));
    await expect(activity).toHaveJSProperty(
      'scrollWidth',
      await activity.evaluate((element) => element.clientWidth),
    );
    await activity.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('run-activity-960.png'), fullPage: true });
    const retained = await page.evaluate(
      (id) => window.randolph.runExecutionSnapshot(id),
      fixture.runId,
    );
    expect(retained.operations).toHaveLength(1);
    expect(retained.operations[0].id).toBe('retained-native');
  } finally {
    await app.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ordinary cleanup remains visible with no task graph or native operation', async () => {
  const fixture = seed('cleanup-only');
  await fixture.close();
  const { app, page } = await launch(fixture);
  try {
    const activity = page.getByRole('region', { name: 'Run activity', exact: true });
    await expect(activity).toBeVisible();
    await expect(
      activity.getByText('Run cleanup has not been confirmed.', { exact: true }),
    ).toBeVisible();
    const snapshot = await page.evaluate(
      (id) => window.randolph.runExecutionSnapshot(id),
      fixture.runId,
    );
    expect(snapshot.cleanupRequired).toBe(true);
    expect(snapshot.tasks).toHaveLength(0);
    expect(snapshot.control).toBeUndefined();
  } finally {
    await app.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
