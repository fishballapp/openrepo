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
  for (const priv of selected) if (!(priv in files)) add(stripRoot(root, priv), priv);
  for (const [priv, pub] of Object.entries(files)) add(pub, priv);
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
