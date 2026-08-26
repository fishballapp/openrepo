import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineExport, eject } from '@openrepo/cli';
import { typescript } from '@openrepo/plugin-typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { pnpm } from './index.ts';

// A whole eject of a fixture monorepo through the real pnpm + typescript plugins, ending in a
// frozen offline install of the result. The fixture has no external dependencies, so pnpm never
// needs the network for either lockfile.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const pnpmExec = (cwd: string, ...args: string[]) =>
  execFileSync('pnpm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const pm = `pnpm@${pnpmExec(process.cwd(), '--version').trim()}`;

let root: string;
let out: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openrepo-pnpm-e2e-'));
  out = join(root, 'out'); // must not exist yet: openrepo creates it
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe('pnpm + typescript end to end', () => {
  it('ejects an installable workspace with a pruned lockfile and re-pointed tsconfigs', async () => {
    write(root, {
      'package.json': json({ name: 'mono', private: true, type: 'module', packageManager: pm }),
      'pnpm-workspace.yaml':
        'packages:\n  - packages/*\n  - projects/*/packages/*\nstrictPeerDependencies: false\n',
      'tsconfig.base.json': json({ compilerOptions: { strict: true, noEmit: true } }),
      'packages/shared/package.json': json({
        name: '@f/shared',
        version: '1.0.0',
        type: 'module',
        main: './index.ts',
      }),
      'packages/shared/index.ts': 'export const shared = 1;\n',
      'packages/shared/tsconfig.json': json({
        extends: '../../tsconfig.base.json',
        include: ['*.ts'],
      }),
      'packages/unrelated/package.json': json({
        name: '@f/unrelated',
        version: '1.0.0',
        type: 'module',
      }),
      'projects/x/package.json': json({
        name: 'x-workspace',
        private: true,
        type: 'module',
        packageManager: pm,
      }),
      'projects/x/tsconfig.json': json({ files: [], references: [{ path: './packages/a' }] }),
      'projects/x/packages/a/package.json': json({
        name: '@f/a',
        version: '1.0.0',
        type: 'module',
        dependencies: { '@f/shared': 'workspace:*' },
      }),
      'projects/x/packages/a/index.ts':
        "import { shared } from '@f/shared';\nexport const a = shared;\n",
      'projects/x/packages/a/tsconfig.json': json({
        extends: '../../../../tsconfig.base.json',
        include: ['*.ts'],
      }),
    });
    pnpmExec(root, 'install', '--lockfile-only', '--offline');
    git(root, 'init', '-q', '--initial-branch=main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture');

    await eject({
      configDir: root,
      dryRun: true,
      config: defineExport({
        root: 'projects/x',
        outDir: out,
        include: ['projects/x', 'tsconfig.base.json'],
        plugins: [pnpm(), typescript()],
      }),
    });

    const workspace = parse(readFileSync(join(out, 'pnpm-workspace.yaml'), 'utf8'));
    expect(workspace).toEqual({
      packages: ['packages/a', 'packages/shared'],
      strictPeerDependencies: false,
    });
    const lock = parse(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8'));
    expect(Object.keys(lock.importers).toSorted()).toEqual(['.', 'packages/a', 'packages/shared']);
    expect(JSON.parse(readFileSync(join(out, 'packages/a/tsconfig.json'), 'utf8')).extends).toBe(
      '../../tsconfig.base.json',
    );
    expect(JSON.parse(readFileSync(join(out, 'tsconfig.json'), 'utf8')).references).toEqual([
      { path: './packages/a' },
    ]);
    expect(() => pnpmExec(out, 'install', '--frozen-lockfile', '--offline')).not.toThrow();
  });
});
