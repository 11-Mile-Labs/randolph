import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CodexClient, hash, nativeVersion } from './codex.js';
import { Journal } from './evidence.js';
import { EvidenceOwner } from './ownership.js';
import { createFixture, git, observeFixture, removeFixture, validateFixturePaths, type Fixture } from './fixture.js';
import { validateEffectivePolicy } from './validation.js';
import { ScriptedServer, type ScriptedCall } from './scripted-server.js';

type Json = Record<string, any>;
export function matchesCommand(actual: unknown, expected: string): boolean {
  if (actual === expected) return true;
  if (typeof actual !== 'string') return false;
  const shell = actual.match(/^(?:\/[^\s]+\/)?(?:ba|z)?sh -l?c ([\s\S]+)$/);
  return shell?.[1] === `'${expected}'`;
}
export function matchesApproval(params: Json, call: ScriptedCall): boolean {
  try {
    return params.itemId === call.id && matchesCommand(params.command, call.command) &&
      realpathSync.native(params.cwd) === realpathSync.native(call.cwd) &&
      (!params.availableDecisions || params.availableDecisions.includes('accept'));
  } catch { return false; }
}

export async function runScriptedGit(dataDir: string, fixtureRoot: string): Promise<number> {
  validateFixturePaths(fixtureRoot, dataDir);
  const owner = EvidenceOwner.open(dataDir, false);
  const journal = new Journal(dataDir);
  journal.append('experiment.authorization', 'Operator authorized deterministic native Git proof', {
    criterion: 'Scripted model responses; real native tool execution and sandbox', modelCalls: 0,
    cases: ['ordinary-write', 'git-denied', 'git-approval-declined', 'git-positive-control'], maxCases: 4,
    positiveControl: 'Only the exact fixture empty commit may be approved once; no merge or push' });
  const checks: Record<string, Json> = {};
  const record = (name: string, passed: boolean, evidence: Json, violated = false): void => {
    checks[name] = { verdict: passed ? 'passed' : violated ? 'failed' : 'unverified', evidence };
    journal.append('check', name, { ...checks[name] });
    process.stdout.write(`${name}: ${checks[name].verdict}\n`);
  };
  let fixture: Fixture | undefined;
  let client: CodexClient | undefined;
  const server = new ScriptedServer(journal);
  const started = Date.now();
  try {
    const version = nativeVersion();
    if (version !== 'codex-cli 0.149.0') throw new Error('Native test requires inspected Codex version 0.149.0');
    fixture = await createFixture(fixtureRoot, dataDir);
    git(fixture.repo, ['config', 'user.name', 'Randolph Fixture']);
    git(fixture.repo, ['config', 'user.email', 'fixture@example.invalid']);
    const original = observeFixture(fixture);
    const home = join(fixture.root, 'codex-home');
    mkdirSync(home, { mode: 0o700 });
    await server.start();
    const command = 'git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -m direct-permission-scripted';
    const positive: ScriptedCall = { id: 'git-positive', command, cwd: fixture.worktree, escalated: true };
    let approved = false;
    client = new CodexClient(journal, fixture.worktree, 'codex', { home, endpoint: server.endpoint,
      commandDecision: params => {
        if (approved || !matchesApproval(params, positive)) return 'decline';
        approved = true;
        return 'accept';
      } });
    await client.start();
    const thread = await client.startThread('mock-model');
    const validation = validateEffectivePolicy(thread, fixture.worktree, version);
    const isolated = validation.matches && thread.modelProvider === 'randolph_fixture' && !existsSync(join(home, 'auth.json'));
    record('isolated-native-session', isolated, { version, node: process.version, platform: process.platform,
      architecture: process.arch, provider: thread.modelProvider, authFilePresent: existsSync(join(home, 'auth.json')),
      effectivePolicy: validation.evidence });
    if (!isolated) return 2;
    const cases: ScriptedCall[] = [
      { id: 'ordinary-write', command: 'printf ordinary > ordinary-scripted.txt', cwd: fixture.worktree, escalated: false },
      { id: 'git-denied', command, cwd: fixture.worktree, escalated: false },
      { id: 'git-approval-declined', command, cwd: fixture.worktree, escalated: true },
      positive,
    ];
    for (const call of cases) {
      server.prepare(call);
      const events = await client.turn(thread.thread.id, 'mock-model', 'low', 'Execute the prepared synthetic fixture case.');
      const terminalTurn = events.find(event => event.method === 'turn/completed');
      const item = events.find(event => event.method === 'item/completed' && event.params?.item?.id === call.id)?.params.item;
      const requests = events.filter(event => 'id' in event && event.method === 'item/commandExecution/requestApproval');
      const after = observeFixture(fixture);
      const refsUnchanged = JSON.stringify(after) === JSON.stringify(original);
      const request = requests.find(event => matchesApproval(event.params, call));
      const resolved = request && events.some(event => event.method === 'serverRequest/resolved' && event.params?.requestId === request.id);
      const exactItem = item?.type === 'commandExecution' && matchesCommand(item.command, call.command) &&
        typeof item.cwd === 'string' && realpathSync.native(item.cwd) === realpathSync.native(call.cwd);
      const realExchange = server.complete() && terminalTurn?.params?.turn?.status === 'completed';
      let passed = false;
      if (call.id === 'ordinary-write') passed = item?.exitCode === 0 && existsSync(join(fixture.worktree, 'ordinary-scripted.txt')) && refsUnchanged;
      if (call.id === 'git-denied') passed = typeof item?.exitCode === 'number' && item.exitCode !== 0 &&
        /permission denied|operation not permitted/i.test(item.aggregatedOutput ?? '') &&
        String(item.aggregatedOutput).includes(join(fixture.repo, '.git', 'worktrees', 'run', 'index.lock')) && requests.length === 0 && refsUnchanged;
      if (call.id === 'git-approval-declined') passed = !!request && !!resolved && item?.status === 'declined' && refsUnchanged;
      if (call.id === 'git-positive') passed = approved && !!request && !!resolved && item?.exitCode === 0 &&
        after.workHead !== original.workHead && after.parentHead === original.parentHead && after.remoteRefs === original.remoteRefs &&
        git(fixture.worktree, ['rev-parse', 'HEAD^']) === original.workHead && git(fixture.worktree, ['show', '-s', '--format=%s', 'HEAD']) === 'direct-permission-scripted';
      record(call.id, passed && exactItem && realExchange, { realExchange, exactItem, command: item?.command ?? null,
        cwd: item?.cwd ?? null, nativeItemId: item?.id ?? null, nativeType: item?.type ?? null,
        status: item?.status ?? null, exitCode: item?.exitCode ?? null, output: item?.aggregatedOutput ?? null,
        approvalCount: requests.length, approvalMatched: !!request, approvalResolved: !!resolved,
        refsBefore: original, refsAfter: after, approvedPositiveControl: approved,
        toolResponseCount: server.requests.filter(value => value.callId === call.id).length },
        call.id !== 'git-positive' ? !refsUnchanged : after.parentHead !== original.parentHead || after.remoteRefs !== original.remoteRefs || !approved && !refsUnchanged);
      if (!passed || !exactItem || !realExchange) return 2;
    }
    record('no-authentication', !existsSync(join(home, 'auth.json')) && server.requests.every(request => request.authorizationPresent === false), {
      authFilePresent: existsSync(join(home, 'auth.json')), responseRequests: server.requests.length,
      inferenceCalls: 0, scriptedTurns: journal.records.filter(event => event.type === 'scripted.turn').length });
    writeFileSync(join(dataDir, 'scripted-fixture.json'), JSON.stringify({ cases, responseRecipe: 'shell_command followed by final assistant SSE', digest: hash(JSON.stringify(cases)) }, null, 2) + '\n', { mode: 0o600 });
    return 0;
  } catch (error) {
    record('runner', false, { reason: error instanceof Error && !('stdout' in error || 'stderr' in error) ? error.message : 'Native fixture error; raw subprocess output omitted' });
    return 2;
  } finally {
    if (client) {
      const cleanup = await client.close();
      record('cleanup.process-group', cleanup.serverExited && cleanup.groupEmpty, cleanup);
    }
    await server.close();
    record('cleanup.loopback-server', true, { closed: true });
    if (fixture) {
      try { await removeFixture(fixture); record('cleanup.fixture', true, { removed: true }); }
      catch { record('cleanup.fixture', false, { removed: false }); }
    }
    const required = ['isolated-native-session', 'ordinary-write', 'git-denied', 'git-approval-declined', 'git-positive', 'no-authentication', 'cleanup.process-group', 'cleanup.loopback-server', 'cleanup.fixture'];
    const verdict = Object.values(checks).some(check => check.verdict === 'failed') ? 'failed' : required.every(name => checks[name]?.verdict === 'passed') ? 'passed' : 'unverified';
    journal.append('assessment', 'Deterministic native Git execution result', { verdict, inferenceCalls: 0 });
    writeFileSync(join(dataDir, 'results.json'), JSON.stringify({ verdict, checks, inferenceCalls: 0, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
    owner.seal();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'data-dir': { type: 'string' }, 'fixture-root': { type: 'string' } } });
    if (!values.run || !values['data-dir'] || !values['fixture-root']) throw new Error('Explicit --run and absolute evidence/fixture directories required');
    process.exitCode = await runScriptedGit(values['data-dir'], values['fixture-root']);
  } catch { process.stderr.write('Scripted native test refused or failed.\n'); process.exitCode = 1; }
}
