import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineExport } from './config.ts';
import { eject } from './eject.ts';
import type { Plugin } from './plugin.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const tree = (dir: string): string[] => listing(dir).filter(p => p !== '.openrepo');
const listing = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap(e =>
      e.isDirectory() ? listing(join(dir, e.name)).map(p => `${e.name}/${p}`) : [e.name],
    )
    .toSorted();

// A minimal ecosystem: `deps.txt` in a package dir lists the package dirs it depends on.
const depsPlugin: Plugin = {
  name: 'deps',
  packages: repo =>
    repo.files
      .filter(f => f.endsWith('/deps.txt'))
      .map(f => {
        const dir = f.slice(0, -'/deps.txt'.length);
        return { dir, manifest: f, name: dir, dependsOn: repo.read(f).split('\n').filter(Boolean) };
      }),
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openrepo-eject-test-'));
  git(root, 'init', '-q', '--initial-branch=main');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const commit = (files: Record<string, string>) => {
  write(root, files);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
};

describe('eject', () => {
  it('selects at HEAD, closes over deps, strips root, keeps modes, ignores the working tree', async () => {
    commit({
      'projects/x/README.md': 'x',
      'projects/x/packages/a/deps.txt': 'packages/shared\n',
      'projects/x/packages/a/run.sh': '#!/bin/sh\n',
      'projects/x/AGENTS.md': 'private',
      'packages/shared/deps.txt': '',
      'packages/shared/index.ts': 'export {}',
      'packages/unrelated/deps.txt': '',
      'root.json': '{}',
    });
    chmodSync(join(root, 'projects/x/packages/a/run.sh'), 0o755);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'mode');
    writeFileSync(join(root, 'projects/x/README.md'), 'UNSTAGED EDIT');

    const generated: string[] = [];
    let exported: readonly string[] = [];
    await eject({
      configDir: root,
      dryRun: false,
      config: defineExport({
        root: 'projects/x',
        outDir: 'node_modules/.openrepo/x',
        include: ['projects/x', 'root.json'],
        exclude: ['projects/x/AGENTS.md'],
        plugins: [
          depsPlugin,
          {
            name: 'gen',
            transform: (file, paths) =>
              file.publicPath === 'README.md'
                ? `${file.content} + ${paths.toPrivate('README.md')}`
                : file.content,
            generate: async ({ emit, packages }) => {
              emit({ path: 'generated.txt', content: packages.map(p => p.dir).join(',') });
              generated.push('generated.txt');
            },
            postExport: async ({ files }) => {
              exported = files;
            },
          },
        ],
      }),
    });

    const out = join(root, 'node_modules/.openrepo/x');
    expect(tree(out)).toEqual([
      'README.md',
      'generated.txt',
      'packages/a/deps.txt',
      'packages/a/run.sh',
      'packages/shared/deps.txt',
      'packages/shared/index.ts',
      'root.json',
    ]);
    expect(exported).toEqual(tree(out));
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('x + projects/x/README.md');
    expect(statSync(join(out, 'packages/a/run.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(out, 'generated.txt'), 'utf8').split(',').toSorted()).toEqual([
      'packages/shared',
      'projects/x/packages/a',
    ]);
  });

  it('lets exclude win over closure and names the edge', async () => {
    commit({
      'projects/x/packages/a/deps.txt': 'packages/shared\n',
      'packages/shared/deps.txt': '',
    });
    await expect(
      eject({
        configDir: root,
        dryRun: true,
        config: defineExport({
          root: 'projects/x',
          include: ['projects/x'],
          exclude: ['packages/shared/deps.txt'],
          plugins: [depsPlugin],
        }),
      }),
    ).rejects.toThrow(/excluded/);
  });

  it('empties only a dir it wrote itself, unless emptyOutDir says otherwise', async () => {
    commit({ 'projects/x/a.txt': 'a' });
    const attempt = (outDir: string, emptyOutDir = false) =>
      eject({
        configDir: root,
        dryRun: true,
        config: defineExport({ root: 'projects/x', outDir, emptyOutDir, include: ['projects/x'] }),
      });
    // A dir that exists and is not ours: refused, source intact.
    await expect(attempt('projects')).rejects.toThrow(/emptyOutDir/);
    await expect(attempt('..')).rejects.toThrow(/emptyOutDir/);
    expect(existsSync(join(root, 'projects/x/a.txt'))).toBe(true);
    // A dir that does not exist: created, and marked as ours.
    const out = join(root, 'out');
    await attempt(out);
    expect(existsSync(join(out, '.openrepo'))).toBe(true);
    // Ours: emptied and rewritten on the next eject.
    writeFileSync(join(out, 'stale.txt'), 'x');
    await attempt(out);
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    // Not ours, but explicitly allowed.
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'theirs.txt'), 'x');
    await attempt(foreign, true);
    expect(existsSync(join(foreign, 'theirs.txt'))).toBe(false);
    expect(existsSync(join(foreign, 'a.txt'))).toBe(true);
  });

  it('refuses a generator that overwrites a selected file or leaves undeclared files', async () => {
    commit({ 'projects/x/a.txt': 'a' });
    const attempt = (plugin: Plugin) =>
      eject({
        configDir: root,
        dryRun: true,
        config: defineExport({ root: 'projects/x', include: ['projects/x'], plugins: [plugin] }),
      });
    await expect(
      attempt({
        name: 'over',
        generate: async ({ emit }) => emit({ path: 'a.txt', content: 'x' }),
      }),
    ).rejects.toThrow(/overwrite/);
    await expect(
      attempt({
        name: 'sneak',
        generate: async ({ staging }) => writeFileSync(join(staging, 'sneaky.txt'), 'x'),
      }),
    ).rejects.toThrow(/no one declared/);
  });
});
