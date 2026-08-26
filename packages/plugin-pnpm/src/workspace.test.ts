import { describe, expect, it } from 'vitest';
import { assertOnlyPruned, parseLockfile, reachablePatches } from './lockfile.ts';
import {
  overridePackages,
  overrideTarget,
  publicWorkspaceYaml,
  toPackages,
  workspaceDependencyNames,
  workspaceDirs,
} from './workspace.ts';

describe('workspaceDirs', () => {
  it('matches pnpm globs against manifest dirs, negations honoured', () => {
    const files = [
      'packages/a/package.json',
      'projects/x/packages/b/package.json',
      'projects/x/package.json',
      'spikes/s/package.json',
      'package.json',
    ];
    expect(workspaceDirs(['packages/*', 'projects/*/packages/*', '!spikes/**'], files)).toEqual([
      'packages/a',
      'projects/x/packages/b',
    ]);
  });
});

describe('workspaceDependencyNames', () => {
  it('accepts * ^ ~ and refuses alias and path forms', () => {
    expect(
      workspaceDependencyNames({
        dependencies: { a: 'workspace:*', b: 'workspace:^', c: '^1.0.0' },
      }),
    ).toEqual(['a', 'b']);
    expect(() => workspaceDependencyNames({ dependencies: { a: 'workspace:other@*' } })).toThrow(
      /alias/,
    );
    expect(() => workspaceDependencyNames({ dependencies: { a: 'workspace:../a' } })).toThrow(
      /alias/,
    );
  });
});

describe('toPackages', () => {
  it('resolves dependsOn by name and refuses duplicates', () => {
    const packages = toPackages(
      new Map([
        ['packages/a', { name: '@x/a', dependencies: { '@x/b': 'workspace:*' } }],
        ['packages/b', { name: '@x/b' }],
      ]),
    );
    expect(packages.find(p => p.name === '@x/a')?.dependsOn).toEqual(['packages/b']);
    expect(() =>
      toPackages(
        new Map([
          ['p/a', { name: 'dup' }],
          ['p/b', { name: 'dup' }],
        ]),
      ),
    ).toThrow(/two/);
  });
});

describe('overrideTarget', () => {
  it('takes the last selector segment without its range', () => {
    expect(overrideTarget('@types/node')).toBe('@types/node');
    expect(overrideTarget('docs>vite')).toBe('vite');
    expect(overrideTarget('foo@1>@scope/bar@^2')).toBe('@scope/bar');
    expect(overridePackages('foo@1>@scope/bar@^2')).toEqual(['foo', '@scope/bar']);
  });
});

describe('publicWorkspaceYaml', () => {
  const source = {
    packages: ['packages/*'],
    catalog: { vite: '^8', zod: '^4', unused: '1' },
    catalogs: { web: { react: '^19', unused: '1' } },
    overrides: { '@types/node': 'catalog:' },
    minimumReleaseAge: 10080,
    catalogMode: 'strict',
  };

  it('keeps only referenced catalog entries and the portable settings', () => {
    const out = publicWorkspaceYaml(
      { ...source, catalog: { ...source.catalog, '@types/node': '^24' } },
      ['packages/a'],
      [{ dependencies: { vite: 'catalog:' }, devDependencies: { react: 'catalog:web' } }],
      { overrides: source.overrides, allowBuilds: { '@types/node': true, gone: false } },
    );
    expect(out).toEqual({
      packages: ['packages/a'],
      minimumReleaseAge: 10080,
      catalogMode: 'strict',
      overrides: { '@types/node': 'catalog:' },
      allowBuilds: { '@types/node': true, gone: false },
      catalog: { '@types/node': '^24', vite: '^8' },
      catalogs: { web: { react: '^19' } },
    });
  });

  it('refuses an unclassified setting, an unsupported one, and honours keep/drop', () => {
    const empty = { overrides: {}, allowBuilds: {} };
    expect(() => publicWorkspaceYaml({ ...source, mystery: 1 }, [], [], empty)).toThrow(
      /not classified/,
    );
    expect(() => publicWorkspaceYaml({ ...source, pnpmfile: 'x' }, [], [], empty)).toThrow(
      /not supported/,
    );
    expect(
      publicWorkspaceYaml({ ...source, mystery: 1 }, [], [], empty, { keep: ['mystery'] }),
    ).toMatchObject({ mystery: 1 });
    expect(
      publicWorkspaceYaml({ ...source, pnpmfile: 'x' }, [], [], empty, { drop: ['pnpmfile'] }),
    ).not.toHaveProperty('pnpmfile');
    expect(
      publicWorkspaceYaml({ ...source, publicHoistPattern: ['x'] }, [], [], empty),
    ).toMatchObject({ publicHoistPattern: ['x'] });
    expect(publicWorkspaceYaml(source, ['pub/a'], [], empty, { keep: ['packages'] })).toMatchObject(
      {
        packages: ['pub/a'],
      },
    );
  });

  it('fails on a missing catalog entry', () => {
    expect(() =>
      publicWorkspaceYaml(source, [], [{ dependencies: { ghost: 'catalog:' } }], {
        overrides: {},
        allowBuilds: {},
      }),
    ).toThrow(/ghost/);
  });
});

describe('parseLockfile', () => {
  it('refuses a lockfile that is not v9', () => {
    expect(() => parseLockfile({ lockfileVersion: '6.0' })).toThrow(/only 9\.x/);
    expect(() => parseLockfile({ lockfileVersion: '9.0' })).not.toThrow();
  });
});

describe('assertOnlyPruned', () => {
  const before = parseLockfile({
    packages: { 'a@1': { x: 1 }, 'b@1': { x: 1 } },
    snapshots: { 'a@1': {}, 'b@1': {} },
  });
  it('accepts a subset', () => {
    expect(() =>
      assertOnlyPruned(
        before,
        parseLockfile({ packages: { 'a@1': { x: 1 } }, snapshots: { 'a@1': {} } }),
      ),
    ).not.toThrow();
  });
  it('refuses a new or changed entry', () => {
    expect(() =>
      assertOnlyPruned(before, parseLockfile({ packages: { 'c@1': {} }, snapshots: {} })),
    ).toThrow(/new/);
    expect(() =>
      assertOnlyPruned(before, parseLockfile({ packages: { 'a@1': { x: 2 } }, snapshots: {} })),
    ).toThrow(/changed/);
  });
});

describe('assertOnlyPruned importers', () => {
  const before = parseLockfile({
    importers: {
      'projects/x/packages/a': {
        dependencies: {
          zod: { specifier: '^4', version: '4.1.0' },
          '@f/s': { specifier: 'workspace:*', version: 'link:../../../../packages/s' },
        },
      },
    },
    packages: { 'zod@4.1.0': {}, 'zod@4.2.0': {} },
    snapshots: { 'zod@4.1.0': {}, 'zod@4.2.0': {} },
  });
  const importerOf = (pub: string) => (pub === 'packages/a' ? 'projects/x/packages/a' : undefined);
  it('allows moved workspace links and refuses a re-resolved registry version', () => {
    const ok = parseLockfile({
      importers: {
        'packages/a': {
          dependencies: {
            zod: { specifier: '^4', version: '4.1.0' },
            '@f/s': { specifier: 'workspace:*', version: 'link:../s' },
          },
        },
      },
      packages: { 'zod@4.1.0': {} },
      snapshots: { 'zod@4.1.0': {} },
    });
    expect(() => assertOnlyPruned(before, ok, importerOf)).not.toThrow();
    const switched = parseLockfile({
      importers: { 'packages/a': { dependencies: { zod: { specifier: '^4', version: '4.2.0' } } } },
      packages: { 'zod@4.2.0': {} },
      snapshots: { 'zod@4.2.0': {} },
    });
    expect(() => assertOnlyPruned(before, switched, importerOf)).toThrow(/re-resolved zod/);
  });
});

describe('reachablePatches', () => {
  it('finds a patched version in the pruned packages', () => {
    const after = parseLockfile({
      packages: { 'lib@1.2.3(peer@1)': {}, 'other@1': {} },
      snapshots: {},
    });
    expect(reachablePatches(after, { 'lib@1.2.3': 'p.patch', 'gone@1': 'g.patch' })).toEqual([
      'lib@1.2.3',
    ]);
  });
});
