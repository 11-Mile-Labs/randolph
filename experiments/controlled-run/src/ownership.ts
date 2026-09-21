import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const marker = '.randolph-evidence.json';
function identity(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error('Evidence must contain only owned directories and regular unlinked files');
  }
  return `${stat.dev}:${stat.ino}`;
}
function inventory(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      if (!relative && name === marker) continue;
      const key = join(relative, name);
      const path = join(directory, key);
      const id = identity(path);
      if (lstatSync(path).isDirectory()) {
        files[key] = id;
        walk(key);
      } else files[key] = id + ':' + createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk('');
  return files;
}

export class EvidenceOwner {
  private constructor(
    readonly directory: string,
    private readonly token: string,
    private readonly root: string,
  ) {}

  static open(directory: string, corrected: boolean): EvidenceOwner {
    if (!corrected) {
      mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
      mkdirSync(directory, { mode: 0o700 }); // Exclusive: never adopt an existing directory.
      const owner = new EvidenceOwner(
        realpathSync.native(directory),
        randomUUID(),
        identity(directory),
      );
      writeFileSync(
        join(directory, marker),
        JSON.stringify({ token: owner.token, root: owner.root, sealed: false }),
        { flag: 'wx', mode: 0o600 },
      );
      return owner;
    }
    const root = identity(directory);
    if (!lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o777) !== 0o700)
      throw new Error('Evidence directory mode or type changed');
    identity(join(directory, marker));
    const saved = JSON.parse(readFileSync(join(directory, marker), 'utf8'));
    if (
      saved.root !== root ||
      typeof saved.token !== 'string' ||
      !saved.sealed ||
      JSON.stringify(saved.files) !== JSON.stringify(inventory(directory))
    )
      throw new Error('Evidence ownership or contents changed');
    return new EvidenceOwner(realpathSync.native(directory), saved.token, root);
  }

  seal(): void {
    if (identity(this.directory) !== this.root)
      throw new Error('Evidence directory identity changed');
    identity(join(this.directory, marker));
    const saved = JSON.parse(readFileSync(join(this.directory, marker), 'utf8'));
    if (saved.token !== this.token || saved.root !== this.root)
      throw new Error('Evidence ownership changed');
    writeFileSync(
      join(this.directory, marker),
      JSON.stringify({
        token: this.token,
        root: this.root,
        sealed: true,
        files: inventory(this.directory),
      }),
      { mode: 0o600 },
    );
  }
}
