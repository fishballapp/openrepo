import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { Finding, Plugin, ScannedFile } from '@openrepo/cli';

// /Users/<name>, /home/<name>, C:\Users\<name> and C:/Users/<name>, each separator also as a JSON or
// JS string escapes it (`\/`, `\\`). Not preceded by a word character, so a URL path such as
// `example.com/home/about` stays clean.
const HOME_DIR = /(?<!\w)(?:\\?\/(?:Users|home)|[A-Za-z]:\\?[/\\]Users)\\?[/\\][\p{L}\p{N}._-]+/u;

// Committed on purpose: they hold names or placeholders, never values.
const SAFE_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template', '.env.schema']);

const isEnvFile = (path: string): boolean => {
  const name = basename(path);
  return (name === '.env' || name.startsWith('.env.')) && !SAFE_ENV_FILES.has(name);
};

// This machine's own paths, matched literally. A root path trims to nothing and is skipped: it
// would match every line.
const literal = (path: string): RegExp | undefined => {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? undefined : new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
};

/** Every local path and `.env` file in `files`, one finding per line. */
export const findLocalLeaks = (
  files: readonly ScannedFile[],
  machine: { homedir: string; repoRoot: string },
): Finding[] => {
  const localPaths = [
    ...[machine.repoRoot, machine.homedir].flatMap(path => literal(path) ?? []),
    HOME_DIR,
  ];

  return files.flatMap(({ path, content }) => {
    // Neither is a secret: shown in full, so the error says exactly what to fix.
    const leaks: Finding[] = isEnvFile(path)
      ? [{ path, line: 1, rule: 'env-file', excerpt: basename(path), isSecret: false }]
      : [];
    for (const [index, text] of content.split(/\r?\n/).entries()) {
      const match = localPaths.map(regex => regex.exec(text)).find(found => found !== null);
      if (match) {
        leaks.push({ path, line: index + 1, rule: 'path', excerpt: match[0], isSecret: false });
      }
    }
    return leaks;
  });
};

/**
 * Stop an eject that would publish a path from this machine (`local-leaks/path`) or a `.env` file
 * (`local-leaks/env-file`).
 */
export const localLeaks = (): Plugin => ({
  name: 'local-leaks',
  scan: async ({ files, source }) =>
    findLocalLeaks(files, { homedir: homedir(), repoRoot: source.root }),
});
