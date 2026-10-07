import { matchesGlob, posix } from 'node:path';
import type { Package } from '@openrepo/cli';
import { z } from 'zod';

const Catalog = z.record(z.string(), z.string());

export const WorkspaceYamlSchema = z.looseObject({
  packages: z.array(z.string()).default([]),
  catalog: Catalog.optional(),
  catalogs: z.record(z.string(), Catalog).optional(),
  overrides: Catalog.optional(),
  allowBuilds: z.record(z.string(), z.boolean()).optional(),
  patchedDependencies: Catalog.optional(),
});
export type WorkspaceYaml = z.infer<typeof WorkspaceYamlSchema>;

export const ManifestSchema = z.looseObject({
  name: z.string().optional(),
  dependencies: Catalog.optional(),
  devDependencies: Catalog.optional(),
  peerDependencies: Catalog.optional(),
  optionalDependencies: Catalog.optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// Every field's entries, not one merged record: a package can name the same dependency twice (a
// `^4` peer and the `catalog:` dev copy it builds against), and each spec counts.
export const allDependencies = (m: Manifest): [name: string, spec: string][] =>
  [m.dependencies, m.devDependencies, m.peerDependencies, m.optionalDependencies].flatMap(
    dependencies => Object.entries(dependencies ?? {}),
  );

/**
 * How each `pnpm-workspace.yaml` key travels. Install policy copies verbatim; keys this plugin
 * computes are owned; keys that cannot mean the same thing in a snapshot are refused; anything
 * else is refused too, with the `settings` option as the way to classify it without a release.
 */
export type SettingsPolicy = { keep?: readonly string[]; drop?: readonly string[] };

const COMPUTED = [
  'packages',
  'catalog',
  'catalogs',
  'overrides',
  'allowBuilds',
  'patchedDependencies',
];
const PORTABLE = [
  'autoInstallPeers',
  'strictPeerDependencies',
  'dedupePeerDependents',
  'resolvePeersFromWorkspaceRoot',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'catalogMode',
  'cleanupUnusedCatalogs',
  'nodeLinker',
  'shamefullyHoist',
  'hoist',
  'hoistPattern',
  'publicHoistPattern',
  'hoistWorkspacePackages',
  'engineStrict',
  'packageExtensions',
  'onlyBuiltDependencies',
  'neverBuiltDependencies',
  'ignoredBuiltDependencies',
  'strictDepBuilds',
  'dangerouslyAllowAllBuilds',
  'linkWorkspacePackages',
  'preferWorkspacePackages',
  'saveWorkspaceProtocol',
  'savePrefix',
  'saveExact',
  'preferFrozenLockfile',
  'lockfileIncludeTarballUrl',
  'useNodeVersion',
  'enablePrePostScripts',
  'shellEmulator',
  'verifyDepsBeforeRun',
  'trustPolicy',
  'ignorePnpmfile',
];
const UNSUPPORTED: Readonly<Record<string, string>> = {
  pnpmfile: 'a pnpmfile is code outside the tree; nothing runs it on the public side',
  sharedWorkspaceLockfile: 'the lockfile prune assumes one workspace lockfile',
  useLockfile: 'the eject is built around pruning the lockfile',
  configDependencies: 'config dependencies are fetched at install time and cannot be pruned',
  injectWorkspacePackages: 'injected workspace packages are not re-linked after the layout moves',
};

const classify = (
  key: string,
  { keep = [], drop = [] }: SettingsPolicy,
): 'keep' | 'drop' | 'computed' => {
  // What the plugin computes cannot be overridden: copying the private `packages` globs or
  // catalogs verbatim would silently undo the eject.
  if (COMPUTED.includes(key)) return 'computed';
  if (keep.includes(key)) return 'keep';
  if (drop.includes(key)) return 'drop';
  if (PORTABLE.includes(key)) return 'keep';
  const why = UNSUPPORTED[key];
  if (why !== undefined) {
    throw new Error(
      `pnpm-workspace.yaml: \`${key}\` is not supported (${why}). Pass pnpm({ settings: { drop: ['${key}'] } }) to leave it out, or keep: [...] if you know it works for your tree.`,
    );
  }
  throw new Error(
    `pnpm-workspace.yaml: openrepo has not classified \`${key}\`. Pass pnpm({ settings: { keep: ['${key}'] } }) to copy it verbatim or drop: ['${key}'] to leave it out, and please open an issue so it gets a default.`,
  );
};

/** Dirs of every manifest a pnpm `packages` glob list selects (negations honoured). */
export const workspaceDirs = (globs: readonly string[], files: readonly string[]): string[] => {
  const manifestDirs = files.filter(f => f.endsWith('/package.json')).map(f => posix.dirname(f));
  const positive = globs.filter(g => !g.startsWith('!'));
  const negative = globs.filter(g => g.startsWith('!')).map(g => g.slice(1));
  const hit = (dir: string, glob: string) => matchesGlob(dir, glob.replace(/\/$/, ''));
  return manifestDirs.filter(
    dir => positive.some(g => hit(dir, g)) && !negative.some(g => hit(dir, g)),
  );
};

// pnpm's workspace protocol: `workspace:*` / `^` / `~` / a range name the dependency by its key;
// `workspace:alias@range` and `workspace:../path` do not, and are refused rather than guessed.
export const workspaceDependencyNames = (m: Manifest): string[] => [
  ...new Set(
    allDependencies(m).flatMap(([name, spec]) => {
      if (!spec.startsWith('workspace:')) return [];
      const rest = spec.slice('workspace:'.length);
      // `*`, `^`, `~` or a range keep the dependency's own name; alias and path forms rename it.
      if (rest === '' || rest.includes('@') || rest.includes('/') || rest.includes('\\')) {
        throw new Error(
          `${m.name ?? '?'} depends on ${name} as "${spec}"; alias and path forms are not supported`,
        );
      }
      return [name];
    }),
  ),
];

export const toPackages = (manifests: ReadonlyMap<string, Manifest>): Package[] => {
  const dirByName = new Map<string, string>();
  for (const [dir, m] of manifests) {
    if (m.name === undefined) continue;
    const existing = dirByName.get(m.name);
    if (existing !== undefined) {
      throw new Error(`two workspace packages are named ${m.name}: ${existing}, ${dir}`);
    }
    dirByName.set(m.name, dir);
  }
  return [...manifests].map(([dir, m]) => ({
    dir,
    manifest: `${dir}/package.json`,
    name: m.name ?? dir,
    dependsOn: workspaceDependencyNames(m).map(name => {
      const depDir = dirByName.get(name);
      if (depDir === undefined) {
        throw new Error(`${m.name ?? dir} depends on ${name}, which is not a workspace package`);
      }
      return depDir;
    }),
  }));
};

const packageOf = (selector: string): string => {
  const trimmed = selector.trim();
  const at = trimmed.indexOf('@', 1);
  return at === -1 ? trimmed : trimmed.slice(0, at);
};

/** Every package an override selector names: `docs>vite@1` → `['docs', 'vite']`. */
export const overridePackages = (key: string): string[] => key.split('>').map(packageOf);

// pnpm resolves `catalog:` in an override by the overridden package: `a>b@1` → `b`.
export const overrideTarget = (key: string): string => overridePackages(key).at(-1) ?? key;

const catalogNameOf = (spec: string): string | null => {
  if (spec === 'catalog:') return 'default';
  if (spec.startsWith('catalog:')) return spec.slice('catalog:'.length);
  return null;
};

const pick = (source: Record<string, string> | undefined, names: Iterable<string>, label: string) =>
  Object.fromEntries(
    [...names].toSorted().map(name => {
      const value = source?.[name];
      if (value === undefined) throw new Error(`${label} has no entry for ${name}`);
      return [name, value];
    }),
  );

/**
 * The public pnpm-workspace.yaml: an explicit package list, only the catalog entries the ejected
 * manifests and the kept overrides reference, the portable settings, and nothing else.
 */
/** Per-package install policy that only makes sense for packages the pruned graph still has. */
export type KeptPolicy = {
  overrides: Readonly<Record<string, string>>;
  allowBuilds: Readonly<Record<string, boolean>>;
};

export const publicWorkspaceYaml = (
  source: WorkspaceYaml,
  packageDirs: readonly string[],
  manifests: readonly Manifest[],
  { overrides, allowBuilds }: KeptPolicy,
  settings: SettingsPolicy = {},
): Record<string, unknown> => {
  const kept = Object.keys(source).filter(key => classify(key, settings) === 'keep');
  const specs = [
    ...manifests.flatMap(allDependencies),
    ...Object.entries(overrides).map(([key, spec]) => [overrideTarget(key), spec] as const),
  ];
  const wanted = Map.groupBy(
    specs.flatMap(([name, spec]) => {
      const cat = catalogNameOf(spec);
      return cat === null ? [] : [{ cat, name }];
    }),
    ({ cat }) => cat,
  );
  const names = (cat: string) => (wanted.get(cat) ?? []).map(({ name }) => name);
  const named = [...wanted.keys()].filter(cat => cat !== 'default').toSorted();
  return {
    packages: packageDirs.toSorted(),
    ...Object.fromEntries(kept.map(k => [k, source[k]])),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(wanted.has('default')
      ? { catalog: pick(source.catalog, names('default'), 'catalog') }
      : {}),
    ...(named.length > 0
      ? {
          catalogs: Object.fromEntries(
            named.map(cat => [cat, pick(source.catalogs?.[cat], names(cat), `catalogs.${cat}`)]),
          ),
        }
      : {}),
  };
};
