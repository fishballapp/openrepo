import { execFileSync } from 'node:child_process';

const requireTool = <T>(tool: string, run: () => T): T => {
  try {
    return run();
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new Error(`${tool} is not on PATH`);
    throw err;
  }
};

export const git = (cwd: string, args: readonly string[], input?: string): string =>
  requireTool('git', () =>
    execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      ...(input === undefined ? {} : { input }),
    }),
  );

export const repoRoot = (from: string): string =>
  git(from, ['rev-parse', '--show-toplevel']).trim();

export const headSha = (root: string): string => git(root, ['rev-parse', 'HEAD']).trim();

// `--with-tree` lists HEAD's files instead of the index, so pathspec magic (`:!x`, globs) applies
// to the commit rather than to whatever is staged.
export const listTree = (root: string, pathspecs: readonly string[]): string[] =>
  git(root, ['ls-files', '-z', '--with-tree=HEAD', '--', ...pathspecs])
    .split('\0')
    .filter(path => path !== '');

/** Every path at HEAD with its mode; the only source of modes, as `--with-tree` lists none. */
export const treeModes = (root: string): Map<string, string> =>
  new Map(
    git(root, ['ls-tree', '-r', '-z', 'HEAD'])
      .split('\0')
      .filter(line => line !== '')
      .map(line => {
        const match = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) {
          throw new Error(`unexpected ls-tree line: ${line}`);
        }
        return [match[2], match[1]];
      }),
  );

/** Symlinks and submodules cannot be ejected: a link could point anywhere, a gitlink has no bytes. */
export const assertRegular = (
  modes: ReadonlyMap<string, string>,
  paths: Iterable<string>,
): void => {
  for (const path of paths) {
    const mode = modes.get(path);
    if (mode === '120000') throw new Error(`${path} is a symlink; symlinks cannot be ejected`);
    if (mode === '160000') throw new Error(`${path} is a submodule; submodules cannot be ejected`);
  }
};

export const readBlob = (root: string, sha: string, path: string): string =>
  git(root, ['show', `${sha}:${path}`]);

/** Extract committed bytes (modes included) for exactly `paths` into `dest`. */
export const extract = (
  root: string,
  sha: string,
  paths: readonly string[],
  dest: string,
): void => {
  const tar = execFileSync('git', ['archive', '--format=tar', sha, '--', ...paths], {
    cwd: root,
    maxBuffer: 1 << 30,
  });
  requireTool('tar', () => execFileSync('tar', ['-x', '-C', dest], { input: tar }));
};
