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
const ctx = (files: Record<string, string>) => {
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(outDir, path, '..'), { recursive: true });
    writeFileSync(join(outDir, path), content);
  }
  return {
    outDir,
    files: Object.keys(files).toSorted(),
    source: { root, sha: 'abc' },
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
      'Test Author <test@example.com>\nCo-authored-by: Second <second@example.com>',
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
