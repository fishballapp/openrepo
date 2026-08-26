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
        if (was !== version)
          throw new Error(
            `lockfile prune re-resolved ${name} in ${pub}: ${was ?? 'absent'} → ${version}`,
          );
      }
    }
  }
  for (const section of ['packages', 'snapshots'] as const) {
    for (const [key, entry] of Object.entries(after[section])) {
      const prior = before[section][key];
      if (prior === undefined) throw new Error(`lockfile prune resolved a new entry: ${key}`);
      if (JSON.stringify(resolution(prior)) !== JSON.stringify(resolution(entry)))
        throw new Error(
          `lockfile prune changed an entry: ${key}\n  before ${JSON.stringify(prior)}\n  after  ${JSON.stringify(entry)}`,
        );
    }
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
