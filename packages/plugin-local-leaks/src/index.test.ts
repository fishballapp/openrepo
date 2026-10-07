import { describe, expect, it } from 'vitest';
import { findLocalLeaks, localLeaks } from './index.ts';

const machine = {
  homedir: '/Users/testuser',
  repoRoot: '/Users/testuser/work/fishballapps',
};

describe('findLocalLeaks', () => {
  describe('path', () => {
    it('detects machine homedir and repoRoot', () => {
      const leaks = findLocalLeaks(
        [
          {
            path: 'a.txt',
            content: 'path is /Users/testuser/work/fishballapps/projects/openrepo\nclean line',
          },
          {
            path: 'b.txt',
            content: 'user home is /Users/testuser/something',
          },
        ],
        machine,
      );

      expect(leaks).toEqual([
        {
          path: 'a.txt',
          line: 1,
          rule: 'path',
          isSecret: false,
          excerpt: '/Users/testuser/work/fishballapps',
        },
        {
          path: 'b.txt',
          line: 1,
          rule: 'path',
          isSecret: false,
          excerpt: '/Users/testuser',
        },
      ]);
    });

    it('detects generic home dirs on macOS, Linux, and Windows', () => {
      const leaks = findLocalLeaks(
        [
          {
            path: 'paths.ts',
            content: [
              'const mac = "/Users/alice/project";',
              'const linux = "/home/bob/project";',
              'const win1 = "C:\\\\Users\\\\charlie\\\\project";',
              'const win2 = "C:/Users/david/project";',
            ].join('\n'),
          },
        ],
        { homedir: '', repoRoot: '' },
      );

      expect(leaks).toEqual([
        { path: 'paths.ts', line: 1, rule: 'path', isSecret: false, excerpt: '/Users/alice' },
        { path: 'paths.ts', line: 2, rule: 'path', isSecret: false, excerpt: '/home/bob' },
        {
          path: 'paths.ts',
          line: 3,
          rule: 'path',
          isSecret: false,
          excerpt: 'C:\\\\Users\\\\charlie',
        },
        { path: 'paths.ts', line: 4, rule: 'path', isSecret: false, excerpt: 'C:/Users/david' },
      ]);
    });

    it('detects paths as JSON escapes them, and non-ASCII user names', () => {
      const leaks = findLocalLeaks(
        [{ path: 'a.json', content: ['"\\/Users\\/alice\\/repo"', '"/home/zoë/repo"'].join('\n') }],
        { homedir: '', repoRoot: '' },
      );

      expect(leaks.map(leak => leak.excerpt)).toEqual(['\\/Users\\/alice', '/home/zoë']);
    });

    it('does not fire on false positives', () => {
      const leaks = findLocalLeaks(
        [
          {
            path: 'clean.ts',
            content: [
              "const a = '/Users/';",
              "const b = '/home/';",
              "const c = 'docs/Users/guide.md';",
              "const d = 'C:\\\\Users\\\\';",
              "const e = 'C:/Users/';",
            ].join('\n'),
          },
        ],
        { homedir: '/', repoRoot: '/' },
      );

      expect(leaks).toEqual([]);
    });

    it('skips empty or root homedir/repoRoot', () => {
      const leaks = findLocalLeaks(
        [
          {
            path: 'clean.ts',
            content: 'const root = "/";\nconst empty = "";',
          },
        ],
        { homedir: '/', repoRoot: '' },
      );

      expect(leaks).toEqual([]);
    });
  });

  describe('env-file', () => {
    it('detects .env and .env.* files', () => {
      const leaks = findLocalLeaks(
        [
          { path: '.env', content: '' },
          { path: '.env.local', content: '' },
          { path: 'packages/core/.env.production', content: '' },
        ],
        { homedir: '', repoRoot: '' },
      );

      expect(leaks).toEqual([
        { path: '.env', line: 1, rule: 'env-file', isSecret: false, excerpt: '.env' },
        { path: '.env.local', line: 1, rule: 'env-file', isSecret: false, excerpt: '.env.local' },
        {
          path: 'packages/core/.env.production',
          line: 1,
          rule: 'env-file',
          isSecret: false,
          excerpt: '.env.production',
        },
      ]);
    });

    it('allows safe env templates and schemas', () => {
      const leaks = findLocalLeaks(
        [
          { path: '.env.example', content: '' },
          { path: '.env.sample', content: '' },
          { path: '.env.template', content: '' },
          { path: '.env.schema', content: '' },
          { path: 'packages/core/.env.example', content: '' },
          { path: 'packages/core/.env.schema', content: '' },
          { path: 'src/environment.ts', content: 'export const env = {};' },
          { path: '.environment', content: 'foo' },
        ],
        { homedir: '', repoRoot: '' },
      );

      expect(leaks).toEqual([]);
    });

    it('names a binary .env file too', () => {
      const leaks = findLocalLeaks([{ path: '.env.binary', content: '\u0000' }], {
        homedir: '',
        repoRoot: '',
      });

      expect(leaks).toEqual([
        { path: '.env.binary', line: 1, rule: 'env-file', isSecret: false, excerpt: '.env.binary' },
      ]);
    });
  });
});

describe('localLeaks', () => {
  it('scans for the private repo root it is handed', async () => {
    const files = [{ path: 'a.txt', content: 'see /srv/private-repo/projects/x' }];
    expect(
      await localLeaks().scan?.({ files, source: { root: '/srv/private-repo', sha: 'abc' } }),
    ).toEqual([
      { path: 'a.txt', line: 1, rule: 'path', excerpt: '/srv/private-repo', isSecret: false },
    ]);
  });
});
