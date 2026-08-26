import { z } from 'zod';

const Resolved = z.looseObject({ version: z.string() });
const Importer = z.record(z.string(), z.unknown());
const LockfileSchema = z.looseObject({
  lockfileVersion: z.string().optional(),
  importers: z.record(z.string(), Importer).default({}),
  packages: z.record(z.string(), z.unknown()).default({}),
  snapshots: z.record(z.string(), z.unknown()).default({}),
});
export type Lockfile = z.infer<typeof LockfileSchema>;
export const parseLockfile = (data: unknown): Lockfile => {
  const lock = LockfileSchema.parse(data);
  if (lock.lockfileVersion !== undefined && !lock.lockfileVersion.startsWith('9.'))
    throw new Error(
      `pnpm-lock.yaml is lockfileVersion ${lock.lockfileVersion}; only 9.x (pnpm 9+) is supported`,
    );
  return lock;
};

// `optional` / `dev` say how the graph reaches an entry, and a smaller graph reaches it differently.
// Resolution is everything else.
const resolution = (entry: unknown) => {
  if (typeof entry !== 'object' || entry === null) return entry;
  const { optional: _o, dev: _d, ...rest } = entry as Record<string, unknown>;
  return rest;
};

/**
 * Pruning may only remove. A resolved version that is new, or whose entry changed, means pnpm
 * resolved something instead of reusing the private lockfile, and the public tree would no
 * longer install what the private one does.
 */
export const assertOnlyPruned = (
  before: Lockfile,
  after: Lockfile,
  /** The private importer path a public importer path came from, for importers that existed. */
  importerOf: (publicImporter: string) => string | undefined = () => undefined,
): void => {
  // pnpm keys a snapshot (and an importer's `version`) as `name@version(peer@version…)`. The part
  // before the peers is the version; the peers are how this graph satisfied them, and a smaller
  // graph satisfies an optional peer differently (pnpm 11 resolves optional peers from anywhere in
  // the graph). Versions are guarded through `packages`, which has no peer suffix and must be a
  // subset with identical resolutions. A snapshot may be re-keyed by its peers, but its other
  // edges must match a private snapshot of the same version: an edge that moved between two
  // versions both present privately is a re-resolution the `packages` check cannot see.
  const withoutPeers = (key: string) => key.split('(')[0] ?? key;
  const peersOf = (base: string): Set<string> => {
    const entry = before.packages[base];
    const peers =
      typeof entry === 'object' && entry !== null
        ? (entry as { peerDependencies?: Record<string, unknown> }).peerDependencies
        : undefined;
    return new Set(Object.keys(peers ?? {}));
  };
  const edges = (base: string, entry: unknown): string => {
    if (typeof entry !== 'object' || entry === null) return JSON.stringify(entry);
    const peers = peersOf(base);
    const { optional: _o, dev: _d, ...rest } = entry as Record<string, unknown>;
    const stripped = Object.entries(rest).flatMap(([field, value]) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return [[field, value] as const];
      const deps = Object.entries(value as Record<string, unknown>)
        .filter(([dep]) => !peers.has(dep))
        .map(([dep, v]) => [dep, typeof v === 'string' ? withoutPeers(v) : v] as const);
      // A map left empty once its peers are gone is the same as no map: pnpm omits it.
      return deps.length === 0 ? [] : [[field, Object.fromEntries(deps)] as const];
    });
    return JSON.stringify(Object.fromEntries(stripped));
  };
  const priorEdges = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(before.snapshots)) {
    const base = withoutPeers(key);
    priorEdges.set(base, (priorEdges.get(base) ?? new Set()).add(edges(base, entry)));
  }

  // An importer that existed privately must resolve every dependency to the same version. The
  // package subset check alone would miss a switch between two versions both present before.
  for (const [pub, importer] of Object.entries(after.importers)) {
    const priv = importerOf(pub);
    const prior = priv === undefined ? undefined : before.importers[priv];
    if (prior === undefined) continue;
    for (const [field, deps] of Object.entries(importer)) {
      const parsed = z.record(z.string(), Resolved).safeParse(deps);
      const priorDeps = z.record(z.string(), Resolved).safeParse(prior[field]);
      if (!parsed.success || !priorDeps.success) continue;
      for (const [name, { version }] of Object.entries(parsed.data)) {
        const was = priorDeps.data[name]?.version;
        // A workspace link is a relative path, and the layout moved: only registry versions compare.
        if (version.startsWith('link:') && was?.startsWith('link:')) continue;
        if (was === undefined || withoutPeers(was) !== withoutPeers(version))
          throw new Error(
            `lockfile prune re-resolved ${name} in ${pub}: ${was ?? 'absent'} → ${version}`,
          );
      }
    }
  }
  for (const [key, entry] of Object.entries(after.packages)) {
    const prior = before.packages[key];
    if (prior === undefined) throw new Error(`lockfile prune resolved a new entry: ${key}`);
    if (JSON.stringify(resolution(prior)) !== JSON.stringify(resolution(entry)))
      throw new Error(
        `lockfile prune changed an entry: ${key}\n  before ${JSON.stringify(prior)}\n  after  ${JSON.stringify(entry)}`,
      );
  }
  for (const [key, entry] of Object.entries(after.snapshots)) {
    const base = withoutPeers(key);
    const prior = priorEdges.get(base);
    if (prior === undefined) throw new Error(`lockfile prune resolved a new entry: ${key}`);
    if (!prior.has(edges(base, entry)))
      throw new Error(
        `lockfile prune changed an entry: ${key}\n  after ${JSON.stringify(entry)}\n  matches no private snapshot of that version`,
      );
  }
};

/** `name@version` keys in `packages:` for a patched dependency key like `name@1.2.3`. */
export const reachablePatches = (
  after: Lockfile,
  patched: Readonly<Record<string, string>>,
): string[] =>
  Object.keys(patched).filter(key =>
    Object.keys(after.packages).some(k => k === key || k.startsWith(`${key}(`)),
  );
