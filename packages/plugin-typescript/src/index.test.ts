import { describe, expect, it } from 'vitest';
import { typescript } from './index.ts';

const paths = (entries: Record<string, string>) => {
  const inverse = new Map(Object.entries(entries).map(([pub, priv]) => [priv, pub]));
  return {
    toPublic: (p: string) => inverse.get(p),
    toPrivate: (p: string) => entries[p],
    publicPaths: Object.keys(entries).toSorted(),
  };
};

const transform = typescript().transform;
if (transform === undefined) throw new Error('no transform');

describe('typescript plugin', () => {
  const resolver = paths({
    'tsconfig.base.json': 'tsconfig.base.json',
    'packages/a/tsconfig.json': 'projects/x/packages/a/tsconfig.json',
    'packages/b/tsconfig.json': 'projects/x/packages/b/tsconfig.json',
    'tsconfig.json': 'projects/x/tsconfig.json',
  });

  it('re-points a relative extends across the stripped root, keeping comments', () => {
    const out = transform(
      {
        privatePath: 'projects/x/packages/a/tsconfig.json',
        publicPath: 'packages/a/tsconfig.json',
        content:
          '{\n  // why\n  "extends": "../../../../tsconfig.base.json",\n  "compilerOptions": {}\n}\n',
      },
      resolver,
    );
    expect(out).toBe(
      '{\n  // why\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": {}\n}\n',
    );
  });

  it('re-points directory references', () => {
    const out = transform(
      {
        privatePath: 'projects/x/tsconfig.json',
        publicPath: 'tsconfig.json',
        content:
          '{ "files": [], "references": [{ "path": "./packages/a" }, { "path": "./packages/b/tsconfig.json" }] }',
      },
      resolver,
    );
    expect(out).toBe(
      '{ "files": [], "references": [{ "path": "./packages/a" }, { "path": "./packages/b/tsconfig.json" }] }',
    );
  });

  it('fails when the target is not ejected', () => {
    expect(() =>
      transform(
        {
          privatePath: 'projects/x/packages/a/tsconfig.json',
          publicPath: 'packages/a/tsconfig.json',
          content: '{ "extends": "../../../../nope.json" }',
        },
        resolver,
      ),
    ).toThrow(/not ejected/);
  });

  it('leaves package specifiers and non-tsconfig files alone', () => {
    const file = {
      privatePath: 'projects/x/packages/a/tsconfig.json',
      publicPath: 'packages/a/tsconfig.json',
      content: '{ "extends": "@tsconfig/node24" }',
    };
    expect(transform(file, resolver)).toBe(file.content);
    expect(transform({ ...file, publicPath: 'packages/a/other.json' }, resolver)).toBe(
      file.content,
    );
  });
});
