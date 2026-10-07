import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Plugin, PostExportContext } from '@openrepo/cli';

export type Author = { name: string; email: string };

export type GitCommitOptions = {
  remote: string;
  branch: string;
  /**
   * The checkout the snapshot is committed into. Relative to the private repo root, or absolute.
   * Cloned from `remote` when missing; when present it must be a clean clone of that remote.
   * Default: a dir named after the remote under the OS temp dir.
   */
  dir?: string;
  /** The commit message, or a function of the context plus the branch tip it lands on. */
  message:
    | string
    | ((ctx: PostExportContext & { previous: { sha: string; message: string } | null }) => string);
  /** Who the snapshot is by: the first is the commit author, the rest are `Co-authored-by:` trailers. */
  authors: readonly [Author, ...Author[]];
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });

const tryGit = (cwd: string, args: readonly string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const remoteHeads = (cwd: string): { defaultBranch: string | null; branches: Set<string> } => {
  const out = git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? null;
  const branches = new Set([...out.matchAll(/\trefs\/heads\/(\S+)$/gm)].map(m => m[1] ?? ''));
  return { defaultBranch, branches };
};

const slug = (remote: string): string =>
  remote
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-');

/** A clone of `remote` at `dir`, on `branch`, fast-forwarded to the remote if it has the branch. */
const prepareCheckout = (dir: string, remote: string, branch: string): void => {
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    git(dirname(dir), ['clone', '-q', remote, dir]);
  } else {
    const origin = tryGit(dir, ['remote', 'get-url', 'origin'])?.trim();
    if (origin !== remote) {
      throw new Error(`${dir} is not a clone of ${remote} (origin: ${origin ?? 'none'})`);
    }
    if (git(dir, ['status', '--porcelain']).trim() !== '') {
      throw new Error(`${dir} has uncommitted changes; commit or discard them first`);
    }
  }
  git(dir, ['fetch', '-q', 'origin']);
  const { defaultBranch, branches } = remoteHeads(dir);
  const hasLocal = tryGit(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) !== null;
  if (hasLocal) {
    git(dir, ['checkout', '-q', branch]);
    // Local commits from an earlier eject that is not pushed yet stay; a diverged remote is an error.
    if (branches.has(branch)) git(dir, ['merge', '-q', '--ff-only', `origin/${branch}`]);
    return;
  }
  if (branches.has(branch)) {
    git(dir, ['checkout', '-q', '-b', branch, `origin/${branch}`]);
    return;
  }
  if (defaultBranch !== null && branches.has(defaultBranch)) {
    git(dir, ['checkout', '-q', '-b', branch, `origin/${defaultBranch}`]);
    return;
  }
  git(dir, ['checkout', '-q', '--orphan', branch]);
};

export const gitCommit = ({
  remote,
  branch,
  dir: dirOption,
  message,
  authors,
}: GitCommitOptions): Plugin => ({
  name: 'git-commit',
  postExport: async ctx => {
    execFileSync('git', ['check-ref-format', '--branch', branch]);
    const dir =
      dirOption === undefined
        ? join(tmpdir(), 'openrepo', slug(remote))
        : resolve(ctx.source.root, dirOption);
    prepareCheckout(dir, remote, branch);
    const headSha = tryGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim();
    const previous =
      headSha === undefined
        ? null
        : { sha: headSha, message: git(dir, ['log', '-1', '--format=%B']).trim() };

    const text = typeof message === 'string' ? message : message({ ...ctx, previous });
    const [author, ...coAuthors] = authors;
    const trailers = coAuthors.map(({ name, email }) => `Co-authored-by: ${name} <${email}>`);
    const body = trailers.length === 0 ? text : `${text}\n\n${trailers.join('\n')}`;
    // The message and author go public with the tree, but the tree scan never saw them. Checked
    // before the checkout changes, so a fixed message can simply be retried.
    const leaks = await ctx.scan([
      { path: 'commit message', content: `${body}\n${author.name} <${author.email}>` },
    ]);
    if (leaks.length > 0) {
      const found = leaks.map(({ rule, excerpt }) => `${rule} ${excerpt}`).join(', ');
      throw new Error(`the commit message would leak: ${found}`);
    }

    git(dir, ['rm', '-rfq', '--ignore-unmatch', '.']);
    for (const file of ctx.files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(ctx.outDir, file), join(dir, file));
    }
    // Exactly the manifest, forced past any `.gitignore` the tree itself ships.
    const list = join(dir, '.git', 'openrepo-pathspec');
    writeFileSync(list, ctx.files.join('\0'));
    git(dir, ['add', '-f', '--pathspec-from-file', list, '--pathspec-file-nul']);
    rmSync(list, { force: true });

    console.log(`repo: ${dir} (${branch})`);
    const pushHint = `push with: git -C ${dir} push origin ${branch}`;
    if (git(dir, ['status', '--porcelain']).trim() === '') {
      console.log('nothing to commit: the branch already holds this tree');
      // No remote branch yet means every local commit is unpushed.
      const unpushed = (
        tryGit(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]) ??
        tryGit(dir, ['rev-list', '--count', 'HEAD']) ??
        '0'
      ).trim();
      if (unpushed !== '0') console.log(`${unpushed} unpushed commit(s); ${pushHint}`);
      return;
    }
    git(dir, [
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      '-q',
      '-m',
      body,
    ]);
    console.log(`committed ${git(dir, ['rev-parse', '--short', 'HEAD']).trim()}`);
    console.log(pushHint);
  },
});
