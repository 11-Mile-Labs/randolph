import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanEnvironment, launchArguments, workspacePolicy } from '../src/codex.js';

test('child environment excludes inherited control, credentials, shell injection, and Git overrides', () => {
  const env = cleanEnvironment({
    PATH: '/bin',
    HOME: '/example',
    CODEX_APP_TOOLS_PIPE_PATH: 'private',
    CODEX_PERMISSION_PROFILE: 'broad',
    OPENAI_API_KEY: 'private',
    ANTHROPIC_API_KEY: 'private',
    OPENAI_BASE_URL: 'private',
    NODE_OPTIONS: '--require /private',
    BASH_ENV: '/private',
    GIT_DIR: '/private',
    GIT_CONFIG_COUNT: '1',
    HTTPS_PROXY: 'private',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/example');
  for (const key of [
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_PERMISSION_PROFILE',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL',
    'NODE_OPTIONS',
    'BASH_ENV',
    'GIT_DIR',
    'GIT_CONFIG_COUNT',
    'HTTPS_PROXY',
  ]) {
    assert.equal(env[key], undefined, key);
  }
});

test('launch and turn policies exclude broad temp roots and automatic approval', () => {
  const args = launchArguments('/fixture/work', ['example-server']);
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('mcp_servers.example-server.enabled=false'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.deepEqual(workspacePolicy('/fixture/work'), {
    type: 'workspaceWrite',
    writableRoots: ['/fixture/work'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.throws(() => launchArguments('/fixture/work', ['complex.key']), /Unsupported MCP key/);
});
