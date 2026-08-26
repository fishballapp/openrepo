import { isContained } from './config.ts';
import type { PathResolver } from './plugin.ts';

const stripRoot = (root: string, path: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

/**
 * public → private for every selected file. `files` entries replace the default mapping of their
 * source. Two sources on one public path, or a public path that escapes the tree, is an error.
 */
export const mapPaths = (
  selected: readonly string[],
  root: string,
  files: Readonly<Record<string, string>>,
): Map<string, string> => {
  const entries = new Map<string, string>();
  const add = (pub: string, priv: string) => {
    if (!isContained(pub)) throw new Error(`${priv} would land at ${pub}, outside the tree`);
    const existing = entries.get(pub);
    if (existing !== undefined && existing !== priv)
      throw new Error(`${pub} would come from both ${existing} and ${priv}`);
    entries.set(pub, priv);
  };
  // A `files` key names a file or a directory; a directory moves with everything under it, and
  // the most specific key wins, so an entry for a sub-path is never shadowed by its parent's.
  const keys = Object.keys(files).toSorted((a, b) => b.length - a.length);
  for (const priv of selected) {
    const key = keys.find(k => priv === k || priv.startsWith(`${k}/`));
    add(key === undefined ? stripRoot(root, priv) : `${files[key]}${priv.slice(key.length)}`, priv);
  }
  return entries;
};

export const resolverOf = (entries: ReadonlyMap<string, string>): PathResolver => {
  const inverse = new Map([...entries].map(([pub, priv]) => [priv, pub]));
  return {
    toPublic: priv => inverse.get(priv),
    toPrivate: pub => entries.get(pub),
    publicPaths: [...entries.keys()].toSorted(),
  };
};
