import { execFile } from 'node:child_process';
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packager } from '@electron/packager';

const runFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(repositoryRoot, 'apps', 'desktop');
const outputRoot = join(repositoryRoot, 'dist', 'macos');
const finalApp = join(outputRoot, 'Randolph.app');
const sourceIcon = join(repositoryRoot, 'randolph.png');

if (process.platform !== 'darwin') throw new Error('The macOS application must be packaged on macOS.');
if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error(`Unsupported macOS architecture: ${process.arch}`);

async function run(command, args, options = {}) {
  try {
    return await runFile(command, args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${command} failed: ${detail}`);
  }
}

async function runPnpm(args, extra = {}) {
  const options = { env: { ...process.env, CI: 'true' } };
  Object.assign(options, extra);
  if (process.env.npm_execpath) return await run(process.execPath, [process.env.npm_execpath, ...args], options);
  return await run('pnpm', args, options);
}

async function createMacIcon(iconset, destination) {
  await mkdir(iconset, { recursive: true });
  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, pixels] of sizes) {
    await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(pixels), String(pixels), sourceIcon, '--out', join(iconset, name)]);
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', destination]);
}

async function removeWorkspaceSelfLink(stage) {
  const path = join(stage, 'node_modules', '.pnpm', 'node_modules', '@randolph', 'desktop');
  try {
    if ((await lstat(path)).isSymbolicLink()) await rm(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function createDeployStage(temporary, stage) {
  const workspace = join(temporary, 'workspace');
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await mkdir(workspace, { recursive: true });
    await copyFile(join(repositoryRoot, name), join(workspace, name));
  }
  for (const packagePath of ['apps/desktop', 'packages/runtime', 'packages/harness-codex', 'packages/harness-grok']) {
    const source = join(repositoryRoot, packagePath);
    const destination = join(workspace, packagePath);
    await mkdir(destination, { recursive: true });
    await copyFile(join(source, 'package.json'), join(destination, 'package.json'));
    await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
  }
  await runPnpm(['--filter', '@randolph/desktop', 'deploy', '--prod', '--legacy', stage], { cwd: workspace });
}

async function assertContainedSymlinks(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = await realpath(isAbsolute(target) ? target : resolve(dirname(path), target));
      if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`Packaging dependency escapes its staging directory: ${relative(root, path)}`);
    } else if (entry.isDirectory()) {
      await assertContainedSymlinks(root, path);
    }
  }
}

await mkdir(outputRoot, { recursive: true });
const temporary = await mkdtemp(join(repositoryRoot, 'dist', '.randolph-package-'));
try {
  const stage = join(temporary, 'stage');
  const packageStage = join(temporary, 'package-stage');
  const iconset = join(temporary, 'Randolph.iconset');
  const icon = join(temporary, 'Randolph.icns');
  const packagedOutput = join(temporary, 'packaged');

  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const electronVersion = desktopPackage.devDependencies?.electron;
  if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('Desktop package must pin an exact Electron version.');
  for (const path of ['dist/main.js', 'dist/preload.cjs', 'dist/renderer/index.html', 'dist/renderer/randolph.png']) {
    if (!(await lstat(join(desktopRoot, path))).isFile()) throw new Error(`Desktop build output is missing: ${path}`);
  }

  await Promise.all([
    createMacIcon(iconset, icon),
    createDeployStage(temporary, stage),
  ]);
  await removeWorkspaceSelfLink(stage);
  await assertContainedSymlinks(stage);
  // ASAR cannot preserve pnpm's nested dependency links reliably. Materialize
  // the validated production tree before the packager traverses it.
  await cp(stage, packageStage, { recursive: true, dereference: true });
  // Workspace packages are copied out of pnpm's virtual store by deploy.
  // Their external imports therefore need ordinary top-level resolution.
  const dependencies = new Set();
  for (const packagePath of ['packages/runtime', 'packages/harness-codex', 'packages/harness-grok']) {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, packagePath, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!String(version).startsWith('workspace:')) dependencies.add(name);
    }
  }
  for (const name of dependencies) {
    const source = await realpath(join(stage, 'node_modules', '.pnpm', 'node_modules', name));
    const destination = join(packageStage, 'node_modules', name);
    await cp(source, destination, { recursive: true, dereference: true });
    await readFile(join(destination, 'package.json'), 'utf8');
  }

  const outputs = await packager({
    dir: packageStage,
    name: 'Randolph',
    executableName: 'Randolph',
    platform: 'darwin',
    arch: process.arch,
    electronVersion,
    out: packagedOutput,
    overwrite: true,
    quiet: true,
    prune: false,
    asar: true,
    icon,
    appBundleId: 'co.11mile.randolph',
    helperBundleId: 'co.11mile.randolph.helper',
    appCategoryType: 'public.app-category.developer-tools',
    appVersion: desktopPackage.version,
    buildVersion: desktopPackage.version,
  });
  if (outputs.length !== 1) throw new Error(`Expected one packaged application, received ${outputs.length}.`);
  const packagedApp = join(outputs[0], 'Randolph.app');
  if (!(await lstat(packagedApp)).isDirectory()) throw new Error('Electron Packager did not produce Randolph.app.');

  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', packagedApp]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', packagedApp]);
  await rm(finalApp, { recursive: true, force: true });
  await rename(packagedApp, finalApp);
  process.stdout.write(`Packaged ${finalApp}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
