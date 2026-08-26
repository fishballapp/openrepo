import { describe, expect, it } from 'vitest';
import { mapPaths, resolverOf } from './paths.ts';
import { assertClosed, missingDependencies } from './select.ts';

describe('mapPaths', () => {
  it('strips the root prefix and keeps other paths', () => {
    const m = mapPaths(
      ['projects/x/packages/a/index.ts', 'packages/cn/index.ts', 'biome.json'],
      'projects/x',
      {},
    );
    expect([...m]).toEqual([
      ['packages/a/index.ts', 'projects/x/packages/a/index.ts'],
      ['packages/cn/index.ts', 'packages/cn/index.ts'],
      ['biome.json', 'biome.json'],
    ]);
  });

  it('files entries replace the default mapping of their source', () => {
    const m = mapPaths(['.github/workflows/x-ci.yml'], 'projects/x', {
      '.github/workflows/x-ci.yml': '.github/workflows/ci.yml',
    });
    expect([...m]).toEqual([['.github/workflows/ci.yml', '.github/workflows/x-ci.yml']]);
  });

  it('refuses two sources on one public path', () => {
    expect(() =>
      mapPaths(['projects/x/packages/cn/a.ts', 'packages/cn/a.ts'], 'projects/x', {}),
    ).toThrow(/both/);
  });

  it('refuses a public path that escapes the tree', () => {
    expect(() => mapPaths(['a.ts'], 'projects/x', { 'a.ts': '../a.ts' })).toThrow(/outside/);
    expect(() => mapPaths(['a.ts'], 'projects/x', { 'a.ts': '.git/hooks/x' })).toThrow(/outside/);
  });

  it('resolves both ways', () => {
    const paths = resolverOf(mapPaths(['projects/x/a.ts'], 'projects/x', {}));
    expect(paths.toPublic('projects/x/a.ts')).toBe('a.ts');
    expect(paths.toPrivate('a.ts')).toBe('projects/x/a.ts');
    expect(paths.toPublic('nope')).toBeUndefined();
  });
});

const pkg = (dir: string, dependsOn: string[] = []) => ({
  dir,
  manifest: `${dir}/package.json`,
  name: dir,
  dependsOn,
});

describe('missingDependencies', () => {
  it('walks unselected dependencies transitively', () => {
    const packages = [pkg('a', ['b']), pkg('b', ['c']), pkg('c'), pkg('d')];
    expect(missingDependencies(new Set(['a/package.json']), packages)).toEqual(['b', 'c']);
  });

  it('is empty when the selection is closed', () => {
    expect(
      missingDependencies(new Set(['a/package.json', 'b/package.json']), [
        pkg('a', ['b']),
        pkg('b'),
      ]),
    ).toEqual([]);
  });

  it('names an unknown dependency', () => {
    expect(() => missingDependencies(new Set(['a/package.json']), [pkg('a', ['ghost'])])).toThrow(
      /ghost/,
    );
  });
});

describe('assertClosed', () => {
  it('fails when exclude removed a vendored manifest', () => {
    expect(() => assertClosed(new Set(['a/package.json']), [pkg('a', ['b']), pkg('b')])).toThrow(
      /excluded/,
    );
  });
});
