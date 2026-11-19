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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// This machine's own paths, matched literally. A root path trims to nothing and is skipped: it
// would match every line.
const literal = (path: string): RegExp | undefined => {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? undefined : new RegExp(escapeRegExp(trimmed));
};

// A private term, as a whole word in any letter case: `acme` is not found in `acmetool`, and
// `Acme` is found.
const wholeWord = (term: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu');

/**
 * Every local path, `.env` file and private term in `files`, one finding per line. A term is also
 * looked for in each file's path (reported as line 0).
 */
export const findLocalLeaks = (
  files: readonly ScannedFile[],
  machine: { homedir: string; repoRoot: string; terms?: readonly string[] },
): Finding[] => {
  const termPatterns = (machine.terms ?? []).map(wholeWord);
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
    for (const [line, text] of [path, ...content.split(/\r?\n/)].entries()) {
      const match = termPatterns.map(regex => regex.exec(text)).find(found => found !== null);
      if (match) {
        leaks.push({ path, line, rule: 'private-term', excerpt: match[0], isSecret: true });
      }
    }
    return leaks;
  });
};

export type LocalLeaksOptions = {
  /**
   * Words that must not appear in the public tree, in any file or path: the names of other private
   * work, an employer. Keep the list out of the tree, since it would leak them itself. A finding
   * shows the first four characters of the term only.
   */
  terms?: readonly string[];
};

/**
 * Stop an eject that would publish a path from this machine (`local-leaks/path`), a `.env` file
 * (`local-leaks/env-file`) or one of `terms` (`local-leaks/private-term`).
 */
export const localLeaks = ({ terms = [] }: LocalLeaksOptions = {}): Plugin => ({
  name: 'local-leaks',
  scan: async ({ files, source }) =>
    findLocalLeaks(files, { homedir: homedir(), repoRoot: source.root, terms }),
});
