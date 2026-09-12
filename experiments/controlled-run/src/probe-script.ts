import type { Fixture } from './fixture.js';

export function permissionDiagnostic(fixture: Fixture): string {
  return `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const repo = ${JSON.stringify(fixture.repo)};
const worktree = ${JSON.stringify(fixture.worktree)};
const remote = ${JSON.stringify(fixture.remote)};
const results = [];
function command(name, cwd, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Randolph Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', timeout: 3000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  results.push({ name, status: result.status, errorCode: result.error?.code ?? null,
    denied: /operation not permitted|permission denied|denied by/i.test(result.stderr ?? '') });
}
command('commit', worktree, ['commit', '--allow-empty', '-m', 'permission-diagnostic']);
command('ref', repo, ['update-ref', 'refs/heads/probe-unapproved', 'HEAD']);
command('push', worktree, ['push', remote, 'HEAD:refs/heads/probe-push']);
try {
  writeFileSync('protected-metadata/randolph-denial-canary', 'probe');
  results.push({ name: 'symlink', status: 0, errorCode: null, denied: false });
} catch (error) {
  results.push({ name: 'symlink', status: 1, errorCode: error.code, denied: ['EPERM', 'EACCES'].includes(error.code) });
}
writeFileSync('permission-receipts.json', JSON.stringify(results));
console.log('FIXTURE_PERMISSION_DIAGNOSTIC_FINISHED');
`;
}
