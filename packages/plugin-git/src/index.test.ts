import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScannedFile } from '@openrepo/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCommit } from './index.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let remote: string;
let outDir: string;
let repo: string;
const ctx = (files: Record<string, string>, source = { root, sha: 'abc' }) => {
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(outDir, path, '..'), { recursive: true });
    writeFileSync(join(outDir, path), content);
  }
  return {
    outDir,
    files: Object.keys(files).toSorted(),
    source,
    packages: [],
    // Stands in for the scan plugins: anything saying `/Users/alice` leaks.
    scan: async (texts: readonly ScannedFile[]) =>
      texts
        .filter(({ content }) => content.includes('/Users/alice'))
        .map(({ path }) => ({ path, line: 1, rule: 'fake/path', excerpt: '/Users/alice' })),
  };
};
const AUTHORS = [
  { name: 'Test Author', email: 'test@example.com' },
  { name: 'Second', email: 'second@example.com' },
] as const;
const commit = (
  branch: string,
  message: Parameters<typeof gitCommit>[0]['message'] = 'v1',
  content = 'a',
) =>
  gitCommit({ remote, branch, dir: 'repo', message, authors: AUTHORS }).postExport?.(
    ctx({ 'a.txt': content, '.gitignore': 'ignored.txt', 'ignored.txt': 'kept' }),
  );
const log = (ref: string) => git(repo, 'log', '--format=%s', ref);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openrepo-git-test-'));
  remote = join(root, 'remote.git');
  outDir = join(root, 'out');
  repo = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gitCommit', () => {
  it('clones an empty remote, commits the manifest past its own .gitignore, and does not push', async () => {
    await commit('main');
    expect(log('HEAD')).toBe('v1');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>%n%b')).toBe(
      'Test Author <test@example.com>\nref-hash: abc\nCo-authored-by: Second <second@example.com>',
    );
    expect(git(repo, 'ls-files').split('\n').toSorted()).toEqual([
      '.gitignore',
      'a.txt',
      'ignored.txt',
    ]);
    expect(git(root, 'ls-remote', '--heads', remote)).toBe('');
  });

  it('stacks a second snapshot on the unpushed first and hands the previous tip to message()', async () => {
    await commit('main');
    await commit(
      'main',
      ({ previous }) => `v2 after ${previous?.message.split('\n')[0]}`,
      'changed',
    );
    expect(log('HEAD')).toBe('v2 after v1\nv1');
  });

  it('hands message() the private commit the tip was ejected from, and refuses its own ref-hash', async () => {
    await commit('main');
    let source: string | null | undefined;
    await commit(
      'main',
      ({ previous }) => {
        source = previous?.source;
        return 'v2';
      },
      'changed',
    );
    expect(source).toBe('abc');
    await expect(commit('main', 'v3\n\nref-hash: abc', 'again')).rejects.toThrow(/ref-hash/);
  });

  it('fast-forwards an existing checkout to the remote and bases a new branch on the default', async () => {
    await commit('main');
    git(repo, 'push', '-q', 'origin', 'main');
    rmSync(repo, { recursive: true, force: true });
    await commit('release', 'v2', 'changed');
    expect(log('HEAD')).toBe('v2\nv1');
    expect(git(repo, 'branch', '--show-current')).toBe('release');
  });

  it('is a no-op when the branch already holds the tree', async () => {
    await commit('main');
    await commit('main', 'v1 again');
    expect(log('HEAD')).toBe('v1');
  });

  it('refuses a dirty checkout and a checkout of another remote', async () => {
    await commit('main');
    writeFileSync(join(repo, 'stray.txt'), 'x');
    await expect(commit('main', 'v2', 'changed')).rejects.toThrow(/uncommitted/);
    rmSync(repo, { recursive: true, force: true });
    git(root, 'init', '-q', 'repo');
    git(repo, 'remote', 'add', 'origin', 'git@example.com:other.git');
    await expect(commit('main')).rejects.toThrow(/not a clone/);
  });

  it('refuses a commit message a scan plugin flags, and a fixed one then commits', async () => {
    await expect(commit('main', 'fix: read /Users/alice/private-repo')).rejects.toThrow(
      /commit message would leak: fake\/path \/Users\/alice/,
    );
    expect(git(repo, 'rev-list', '--all', '--count')).toBe('0');
    await commit('main', 'fix: read the private repo');
    expect(git(repo, 'rev-list', '--all', '--count')).toBe('1');
  });

  it('defaults dir to a temp dir named after the remote', async () => {
    const expected = join(
      tmpdir(),
      'openrepo',
      remote.replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/-git$/, ''),
    );
    rmSync(expected, { recursive: true, force: true });
    await gitCommit({ remote, branch: 'main', message: 'v1', authors: AUTHORS }).postExport?.(
      ctx({ 'a.txt': 'a' }),
    );
    expect(existsSync(join(expected, 'a.txt'))).toBe(true);
    rmSync(expected, { recursive: true, force: true });
  });
});

describe('gitCommit tag', () => {
  let priv: string;
  const privGit = (...args: string[]) => git(priv, ...args);
  const privCommit = (subject: string) => {
    privGit(
      '-c',
      'user.name=P',
      '-c',
      'user.email=p@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      subject,
    );
    return privGit('rev-parse', 'HEAD');
  };
  const publicLog = (ref = 'main') => git(remote, 'log', '--first-parent', '--format=%s', ref);
  // Ejects `files` as private commit `sha` onto public main, pushing it like the CI does, and
  // tags it `name` when asked.
  const run = async (
    sha: string,
    files: Record<string, string>,
    { tag }: { tag?: string } = {},
  ) => {
    await gitCommit({
      remote,
      branch: 'main',
      dir: repo,
      message: `eject ${Object.values(files).join('')}`,
      authors: AUTHORS,
      ...(tag === undefined ? {} : { tag: { name: tag, reachableFrom: 'main' } }),
    }).postExport?.(ctx(files, { root: priv, sha }));
    git(repo, 'push', '-q', 'origin', 'main', ...(tag === undefined ? [] : [`refs/tags/${tag}`]));
  };
  const publicTag = (name: string) => git(remote, 'rev-parse', `refs/tags/${name}^{commit}`);
  const publicCount = () => git(remote, 'rev-list', '--count', 'main');
  const A = { 'a.txt': 'A' };
  const B = { 'a.txt': 'B' };
  const C = { 'a.txt': 'C' };

  beforeEach(() => {
    priv = join(root, 'priv');
    git(root, 'init', '-q', '--initial-branch=main', priv);
  });

  it('commits the tree first when public main has not got it yet, then tags it', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    await run(c2, B, { tag: 'v1.0.0' });
    expect(publicLog()).toBe('eject B\neject A');
    expect(publicTag('v1.0.0')).toBe(git(remote, 'rev-parse', 'main'));
    expect(git(remote, 'show', 'main:a.txt')).toBe('B');
    expect(git(remote, 'log', '-1', '--format=%b', 'main')).toContain(`ref-hash: ${c2}`);
  });

  it('tags the tip when the commit changed nothing public, and commits nothing', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    await run(c2, A, { tag: 'v1.0.0' });
    expect(publicCount()).toBe('1');
    expect(publicTag('v1.0.0')).toBe(git(remote, 'rev-parse', 'main'));
  });

  it('tags the commit ejected from it once public main has moved past, and commits nothing', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    await run(c2, B);
    const c3 = privCommit('c3');
    await run(c3, C);
    const before = git(remote, 'rev-parse', 'main');
    await run(c2, B, { tag: 'v1.0.0' });
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
    expect(publicTag('v1.0.0')).toBe(git(remote, 'rev-parse', 'main~1'));
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('tags the newest ejected ancestor when the commit changed nothing public and main has moved past', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    const c3 = privCommit('c3');
    await run(c3, B);
    await run(c2, A, { tag: 'v1.0.0' });
    expect(publicCount()).toBe('2');
    expect(publicTag('v1.0.0')).toBe(git(remote, 'rev-parse', 'main~1'));
  });

  it('refuses to tag a commit whose own eject never reached public main, and leaves the checkout clean', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    const c3 = privCommit('c3');
    await run(c3, C);
    await expect(run(c2, B, { tag: 'v1.0.0' })).rejects.toThrow(/moved past .* does not hold/);
    expect(publicCount()).toBe('2');
    expect(git(repo, 'tag')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('never commits an older tree on top of a newer one', async () => {
    const c1 = privCommit('c1');
    const c2 = privCommit('c2');
    await run(c2, B);
    await expect(run(c1, A, { tag: 'v1.0.0' })).rejects.toThrow(/no commit .* ejected from/);
    expect(publicCount()).toBe('1');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is a no-op when the tag is already on the right commit, and fails when it is on another', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    await run(c2, B, { tag: 'v1.0.0' });
    const tagged = publicTag('v1.0.0');
    await run(c2, B, { tag: 'v1.0.0' });
    const c3 = privCommit('c3');
    await run(c3, C);
    await run(c2, B, { tag: 'v1.0.0' });
    expect(publicTag('v1.0.0')).toBe(tagged);
    expect(publicCount()).toBe('3');

    await expect(run(c3, C, { tag: 'v1.0.0' })).rejects.toThrow(/already on/);
    await expect(run(c1, A, { tag: 'v1.0.0' })).rejects.toThrow(/already on/);
    expect(publicTag('v1.0.0')).toBe(tagged);
  });

  it('refuses a tag that exists on another commit before committing the snapshot', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    git(repo, 'tag', 'v1.0.0');
    git(repo, 'push', '-q', 'origin', 'refs/tags/v1.0.0');
    const c2 = privCommit('c2');
    await expect(run(c2, B, { tag: 'v1.0.0' })).rejects.toThrow(/already on/);
    expect(publicCount()).toBe('1');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses a commit that is not reachable from the named ref', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    privGit('switch', '-q', '-c', 'side');
    const side = privCommit('side');
    privGit('switch', '-q', 'main');
    await expect(run(side, B, { tag: 'v1.0.0' })).rejects.toThrow(/not reachable from main/);
    expect(publicCount()).toBe('1');
  });

  it('refuses when public main does not say where its tip came from', async () => {
    const c1 = privCommit('c1');
    await commit('main', 'hand-made');
    git(
      repo,
      '-c',
      'user.name=H',
      '-c',
      'user.email=h@example.com',
      'commit',
      '-q',
      '--amend',
      '-m',
      'hand-made, no trailer',
    );
    git(repo, 'push', '-q', 'origin', 'main');
    await expect(run(c1, B, { tag: 'v1.0.0' })).rejects.toThrow(/no commit .* ejected from/);
  });

  it('keeps an annotated tag already on the right commit, so the push leaves it alone', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    git(
      repo,
      '-c',
      'user.name=P',
      '-c',
      'user.email=p@example.com',
      'tag',
      '-a',
      'v1.0.0',
      '-m',
      'by hand',
      'main',
    );
    git(repo, 'push', '-q', 'origin', 'refs/tags/v1.0.0');
    const annotated = git(remote, 'rev-parse', 'refs/tags/v1.0.0');
    git(repo, 'tag', '-d', 'v1.0.0');
    await run(c1, A, { tag: 'v1.0.0' });
    expect(git(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(annotated);
  });

  it('never moves public main back to an older commit when no tag is asked for', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    const c2 = privCommit('c2');
    await run(c2, B, { tag: 'v1.0.0' });
    await run(c1, A);
    expect(git(remote, 'show', 'main:a.txt')).toBe('B');
    expect(publicCount()).toBe('2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('lets another branch rewind to an older commit', async () => {
    const c1 = privCommit('c1');
    const c2 = privCommit('c2');
    const onBranch = (sha: string, files: Record<string, string>) =>
      gitCommit({
        remote,
        branch: 'pr/1',
        dir: repo,
        message: 'pending',
        authors: AUTHORS,
      }).postExport?.(ctx(files, { root: priv, sha }));
    await run(c1, A);
    await onBranch(c2, B);
    await onBranch(c1, A);
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('A');
  });

  it('places no tag unless asked', async () => {
    const c1 = privCommit('c1');
    await run(c1, A);
    expect(git(remote, 'tag')).toBe('');
    expect(git(repo, 'tag')).toBe('');
  });
});
