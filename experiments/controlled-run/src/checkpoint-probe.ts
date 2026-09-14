import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { CodexClient, cleanEnvironment, hash, nativeVersion } from './codex.js';
import { Journal } from './evidence.js';
import { EvidenceOwner } from './ownership.js';
import { captureCheckpoint, verifyCheckpoint } from './checkpoint.js';
import {
  createFixture,
  git,
  removeFixture,
  validateFixturePaths,
  type Fixture,
} from './fixture.js';
import { restartFromCheckpoint, appendRunEvent } from './restart.js';
import { retainedRunState } from './lifecycle.js';
import { validateEffectivePolicy } from './validation.js';
import { matchesCommand } from './scripted-git.js';

type Json = Record<string, any>;
export async function runCheckpointProbe(
  dataDir: string,
  fixtureRoot: string,
  model: string,
  effort: string,
): Promise<number> {
  const destination = `${fixtureRoot}-restored`;
  validateFixturePaths(fixtureRoot, dataDir);
  validateFixturePaths(destination, dataDir);
  const owner = EvidenceOwner.open(dataDir, false);
  const journal = new Journal(dataDir);
  const source = new Journal(join(dataDir, 'source-run'));
  const next = new Journal(join(dataDir, 'restarted-run'));
  const checkpointDir = join(dataDir, 'checkpoint');
  const conversationId = 'fixture-conversation';
  const previousRunId = 'source-run';
  const marker = 'EMPTY_QUERY_RETURNS_ALL';
  const checks: Record<string, Json> = {};
  const record = (name: string, passed: boolean, evidence: Json): void => {
    checks[name] = { verdict: passed ? 'passed' : 'unverified', evidence };
    journal.append('check', name, checks[name]!);
    process.stdout.write(`${name}: ${checks[name]!.verdict}\n`);
  };
  let fixture: Fixture | undefined;
  let restoredIdentity: { dev: number; ino: number } | undefined;
  let client: CodexClient | undefined;
  let failure: string | null = null;
  journal.append(
    'experiment.authorization',
    'Explicit checkpoint restore and one subscription-backed Restart authorized',
    {
      model,
      effort,
      maxModelTurns: 1,
      sourceRepositoryWillBeDeleted: true,
      containment: 'Known lifecycle release blocker; bounded foreground verification only',
    },
  );
  try {
    const version = nativeVersion();
    if (version !== 'codex-cli 0.149.0')
      throw new Error('Requires inspected Codex version 0.149.0');
    fixture = await createFixture(fixtureRoot, dataDir);
    writeFileSync(
      join(fixture.worktree, 'src/filter.mjs'),
      'export function searchFilter(items, query) {\n  if (!query.trim()) return items;\n  return items.filter((item) => item.includes(query));\n}\n',
    );
    writeFileSync(
      join(fixture.worktree, 'decision.json'),
      JSON.stringify({ marker, outcome: 'empty query returns the complete list' }),
    );
    writeFileSync(join(fixture.worktree, 'executable.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fixture.worktree, 'executable.sh'), 0o755);
    execFileSync(process.execPath, ['--test', 'test/filter.test.mjs'], {
      cwd: fixture.worktree,
      env: cleanEnvironment(process.env),
      stdio: 'pipe',
      timeout: 5_000,
    });
    const metadata = {
      runId: previousRunId,
      conversationId,
      config: { model, effort },
      description: 'Synthetic search-filter checkpoint verification',
      decisions: [{ marker, meaning: 'An empty query returns all items' }],
      completed: ['Repair empty query behavior', 'Run both regression tests'],
      pending: ['Verify restored work in a clean session'],
      externalActions: [],
      context: 'Preserve the completed fix; verify it without editing or delivering.',
    };
    source.append('lifecycle.state', 'Quiescent completed step before checkpoint', {
      state: 'stopped',
      runId: previousRunId,
    });
    await captureCheckpoint({
      worktree: fixture.worktree,
      checkpointDir,
      baseRef: 'HEAD',
      metadata,
      journal: source,
    });
    const saved = await verifyCheckpoint(checkpointDir, source);
    const sourceBaseline = fixture.baseline;
    const sourceDigest = hash(readFileSync(source.path, 'utf8'));
    await removeFixture(fixture);
    fixture = undefined;
    record('source-removed', !existsSync(fixtureRoot), {
      entireRepositoryAndRemoteRemoved: !existsSync(fixtureRoot),
      baseline: sourceBaseline,
    });
    const reopened = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./lifecycle-reopen.js', import.meta.url)), source.directory],
      { encoding: 'utf8', timeout: 2_000 },
    ).trim();
    record(
      'reopen-read-only',
      reopened === 'stopped' &&
        next.records.filter((event) => event.type === 'turn.reserved').length === 0 &&
        !existsSync(destination),
      { state: reopened, restoredDirectoryAbsent: !existsSync(destination), modelTurns: 0 },
    );
    const checkpointDigest = hash(readFileSync(join(checkpointDir, 'manifest.json'), 'utf8'));
    const newRunId = await restartFromCheckpoint({
      checkpointDir,
      source,
      next,
      destination,
      conversationId,
      previousRunId,
      approval: {
        action: 'restart',
        source: 'human',
        decision: 'approved',
        conversationId,
        previousRunId,
        checkpointDigest,
      },
      launch: async (restored, runId) => {
        next.limitTurns(1);
        const stat = lstatSync(destination);
        restoredIdentity = { dev: stat.dev, ino: stat.ino };
        const baselineMatches = git(restored.worktree, ['rev-parse', 'HEAD']) === sourceBaseline;
        const tests = execFileSync(process.execPath, ['--test', 'test/filter.test.mjs'], {
          cwd: restored.worktree,
          env: cleanEnvironment(process.env),
          encoding: 'utf8',
          timeout: 5_000,
        });
        const binaryPreserved = readFileSync(join(restored.worktree, 'artifact.bin')).equals(
          Buffer.from([0, 1, 2, 3, 255]),
        );
        const executableMode = lstatSync(join(restored.worktree, 'executable.sh')).mode & 0o777;
        const ignoredScratchAbsent = !existsSync(join(restored.worktree, 'scratch'));
        const metadataMatches =
          JSON.stringify(saved.metadata) === JSON.stringify(restored.manifest.metadata);
        record(
          'restored-content',
          baselineMatches &&
            tests.includes('empty query returns every item') &&
            binaryPreserved &&
            executableMode === 0o755 &&
            ignoredScratchAbsent &&
            metadataMatches,
          {
            baselineMatches,
            binaryPreserved,
            executableMode,
            ignoredScratchAbsent,
            metadataMatches,
          },
        );
        if (checks['restored-content']?.verdict !== 'passed')
          throw new Error('Restored content failed verification before native launch');
        client = new CodexClient(next, restored.worktree);
        await client.start();
        const account = await client.rpc('account/read', { refreshToken: false });
        const models = await client.rpc('model/list', { limit: 100, includeHidden: false });
        const selected = models.data?.some(
          (entry: Json) =>
            (entry.model === model || entry.id === model) &&
            entry.supportedReasoningEfforts?.some(
              (value: Json) => value.reasoningEffort === effort,
            ),
        );
        if (account.account?.type !== 'chatgpt' || !selected)
          throw new Error('Requested subscription model/effort unavailable; no fallback');
        const thread = await client.startThread(model);
        const policy = validateEffectivePolicy(
          thread,
          restored.worktree,
          version,
          client.instructionInventory,
        );
        record('native-restart-session', policy.matches, {
          version,
          subscription: 'chatgpt',
          model,
          effort,
          cleanThread: true,
          policy: policy.evidence,
        });
        if (!policy.matches) throw new Error('Unexpected restart policy');
        const events = await client.turn(
          thread.thread.id,
          model,
          effort,
          `Explicitly restarted synthetic run ${runId} from a durable checkpoint after the original repository was deleted. Retained context: ${JSON.stringify(restored.manifest.metadata)}\nVerify the restored completed work: run node --test test/filter.test.mjs once using your native shell tool. Do not edit, delegate, launch background work, commit, or push. After execution report the test result and the retained decision marker from context. This is a bounded verification, not a new project workflow.`,
        );
        const commands = events
          .filter(
            (event) =>
              event.method === 'item/completed' && event.params?.item?.type === 'commandExecution',
          )
          .map((event) => event.params.item);
        const messages = events
          .filter(
            (event) =>
              event.method === 'item/completed' && event.params?.item?.type === 'agentMessage',
          )
          .map((event) => String(event.params.item.text ?? ''))
          .join('\n');
        const executed =
          commands.length === 1 &&
          commands.every(
            (item) =>
              item.exitCode === 0 &&
              item.cwd === restored.worktree &&
              matchesCommand(item.command, 'node --test test/filter.test.mjs') &&
              String(item.aggregatedOutput).includes('empty query returns every item') &&
              String(item.aggregatedOutput).includes('non-empty query filters items'),
          );
        const recalled = messages.includes(marker);
        record('native-restored-verification', executed && recalled, {
          executedTests: executed,
          retainedDecisionRecalled: recalled,
          commandEvidence: commands.map((item) => ({
            command: item.command,
            cwd: item.cwd,
            exitCode: item.exitCode,
            output: item.aggregatedOutput,
          })),
          modelTurns: next.records.filter((event) => event.type === 'turn.reserved').length,
        });
        if (!executed || !recalled)
          throw new Error('Restored native execution or retained context not verified');
      },
    });
    let lateRejected = false;
    try {
      appendRunEvent(next, newRunId, { runId: previousRunId, type: 'old-completion', details: {} });
    } catch {
      lateRejected = true;
    }
    record(
      'linked-history',
      newRunId !== previousRunId &&
        lateRejected &&
        hash(readFileSync(source.path, 'utf8')) === sourceDigest &&
        retainedRunState(next) === 'stopped',
      {
        distinctRun: newRunId !== previousRunId,
        sameConversation: conversationId,
        lateRejected,
        originalHistoryUnchanged: hash(readFileSync(source.path, 'utf8')) === sourceDigest,
      },
    );
  } catch (error) {
    failure =
      error instanceof Error && !('stdout' in error)
        ? error.message
        : 'Checkpoint probe failed; subprocess output omitted';
    journal.append('probe.error', 'Checkpoint verification stopped without automatic retry', {
      reason: failure,
    });
  } finally {
    let cleanup = true;
    if (client) {
      const result = await client.close();
      cleanup = result.serverExited && result.groupEmpty;
    }
    if (fixture) await removeFixture(fixture);
    if (restoredIdentity && cleanup) {
      const stat = lstatSync(destination);
      if (
        !stat.isSymbolicLink() &&
        stat.dev === restoredIdentity.dev &&
        stat.ino === restoredIdentity.ino
      )
        rmSync(destination, { recursive: true });
      else cleanup = false;
    }
    record('cleanup', cleanup && !existsSync(fixtureRoot) && !existsSync(destination), {
      ownedNativeGroupExited: cleanup,
      fixtureAbsent: !existsSync(fixtureRoot),
      restoredFixtureAbsent: !existsSync(destination),
    });
    const required = [
      'source-removed',
      'reopen-read-only',
      'restored-content',
      'native-restart-session',
      'native-restored-verification',
      'linked-history',
      'cleanup',
    ];
    const verdict =
      !failure && required.every((name) => checks[name]?.verdict === 'passed')
        ? 'passed'
        : 'unverified';
    writeFileSync(
      join(dataDir, 'results.json'),
      JSON.stringify(
        {
          verdict,
          failure,
          checks,
          modelTurns: next.records.filter((event) => event.type === 'turn.reserved').length,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    owner.seal();
  }
  return !failure && Object.values(checks).every((check) => check.verdict === 'passed') ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        run: { type: 'boolean' },
        'data-dir': { type: 'string' },
        'fixture-root': { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
    });
    if (
      !values.run ||
      !values['data-dir'] ||
      !values['fixture-root'] ||
      !values.model ||
      !values.effort
    )
      throw new Error('Explicit run, directories, model and effort required');
    process.exitCode = await runCheckpointProbe(
      values['data-dir'],
      values['fixture-root'],
      values.model,
      values.effort,
    );
  } catch {
    process.stderr.write('Checkpoint probe refused or failed.\n');
    process.exitCode = 1;
  }
}
