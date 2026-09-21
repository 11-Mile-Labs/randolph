import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const firstQuestionButton = /^First question(?: \d+ unread events)?$/;
const secondQuestionButton = /^Second question(?: \d+ unread events)?$/;

test('chat transport keeps concurrent streams isolated, reconnects, stops, and replays recorded messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-chat-transport-'));
  const home = join(root, 'home');
  const project = join(root, 'sample-project');
  const bin = join(root, 'bin');
  const turns = join(root, 'turns.log');
  const releaseFirst = join(root, 'release-first');
  const stopSeen = join(root, 'stop-seen');
  for (const directory of [home, project, bin]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Chat transport fixture\n');
  writeFileSync(turns, '');

  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\n` +
      `
const { createInterface } = require('node:readline');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const turns = ${JSON.stringify(turns)};
const releaseFirst = ${JSON.stringify(releaseFirst)};
const stopSeen = ${JSON.stringify(stopSeen)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let stopping = false;
let activeTurn = 0;
let activeThreadId = '';
if (process.argv.includes('--version')) { console.log('codex-cli chat-transport-fixture'); process.exit(0); }
const interrupted = () => { stopping = true; if (activeTurn === 3) writeFileSync(stopSeen, 'seen'); process.exit(130); };
process.on('SIGTERM', interrupted);
process.on('SIGINT', interrupted);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
  else if (message.method === 'model/list') send({ id: message.id, result: { data: [{ model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] } });
  else if (message.method === 'thread/start') { activeThreadId = 'chat-transport-thread-' + Math.random(); send({ id: message.id, result: { thread: { id: activeThreadId } } }); }
  else if (message.method === 'turn/start') {
    const turnNumber = readFileSync(turns, 'utf8').trim().split('\\n').filter(Boolean).length + 1;
    activeTurn = turnNumber;
    appendFileSync(turns, turnNumber + '\\n');
    const turnId = 'chat-transport-turn-' + turnNumber;
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (turnNumber === 1) {
      send({ method: 'item/reasoning/delta', params: { threadId: activeThreadId, turnId, itemId: 'reasoning', delta: 'PRIVATE_REASONING_MUST_NOT_BE_ASSISTANT_TEXT' } });
      send({ method: 'item/toolCall/delta', params: { threadId: activeThreadId, turnId, itemId: 'tool', delta: 'PRIVATE_TOOL_RESULT_MUST_NOT_BE_ASSISTANT_TEXT' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId, itemId: 'first-answer', delta: 'First stream: ' } });
      const wait = () => {
        if (stopping) return;
        if (!existsSync(releaseFirst)) return setTimeout(wait, 10);
        send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId, itemId: 'first-answer', delta: 'completed.' } });
        send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: turnId, status: 'completed' } } });
        activeTurn = 0;
      };
      wait();
    } else if (turnNumber === 2) {
      send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId, itemId: 'second-answer', delta: 'Second stream: independent.' } });
      send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: turnId, status: 'completed' } } });
      activeTurn = 0;
    } else {
      const wait = () => { if (!stopping) setTimeout(wait, 10); };
      wait();
    }
  } else send({ id: message.id, result: {} });
});
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
  let page;
  if (process.env.RANDOLPH_TEST_EXECUTABLE)
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('exe'))).toBe(
      process.env.RANDOLPH_TEST_EXECUTABLE,
    );

  try {
    page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: 'Add your first project' }).click();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
      'fixture-model',
    );

    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('First question');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('First stream:', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Run activity', exact: true })).toContainText(
      'Codex · Active',
    );
    await expect(page.locator('article.message.assistant')).not.toContainText(
      'PRIVATE_REASONING_MUST_NOT_BE_ASSISTANT_TEXT',
    );
    await expect(page.locator('article.message.assistant')).not.toContainText(
      'PRIVATE_TOOL_RESULT_MUST_NOT_BE_ASSISTANT_TEXT',
    );

    const projectNavigation = page.getByRole('navigation', {
      name: 'Project conversations',
      exact: true,
    });
    await projectNavigation
      .getByRole('button', { name: 'New conversation in sample-project', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Second question');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Second stream: independent.', { exact: true })).toBeVisible();

    await projectNavigation.getByRole('button', { name: firstQuestionButton }).click();
    await expect(page.getByText('First stream:', { exact: true })).toBeVisible();
    await page.reload();
    await projectNavigation.getByRole('button', { name: firstQuestionButton }).click();
    await expect(page.getByText('First stream:', { exact: true })).toBeVisible();
    expect(readFileSync(turns, 'utf8')).toBe('1\n2\n');
    writeFileSync(releaseFirst, 'release');
    await expect(page.getByText('First stream: completed.', { exact: true })).toBeVisible();
    await expect(page.locator('article.message.assistant')).toHaveCount(1);
    expect(readFileSync(turns, 'utf8')).toBe('1\n2\n');

    await projectNavigation.getByRole('button', { name: secondQuestionButton }).click();
    writeFileSync(stopSeen, '');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Long question');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await expect(page.locator('.status-row').filter({ hasText: 'Status' })).toContainText(
      'interrupted',
    );
    await expect.poll(() => readFileSync(stopSeen, 'utf8')).toBe('seen');
    expect(readFileSync(turns, 'utf8')).toBe('1\n2\n3\n');

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Your projects, in one place.' })).toBeVisible();
    const retainedConversation = page.getByRole('button', { name: firstQuestionButton });
    await retainedConversation.focus();
    await expect(retainedConversation).toBeFocused();
    await retainedConversation.press('Enter');
    await expect(page.getByText('First stream: completed.', { exact: true })).toBeVisible();
    expect(readFileSync(turns, 'utf8')).toBe('1\n2\n3\n');
    expect(pageErrors).toEqual([]);
  } finally {
    // A failed assertion can leave the first fixture turn waiting forever. Let the
    // app's ordinary shutdown own process cleanup; the dialog stub guarantees it
    // can choose Stop instead of leaving the Electron close confirmation pending.
    if (!existsSync(releaseFirst)) writeFileSync(releaseFirst, 'release');
    try {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      });
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
