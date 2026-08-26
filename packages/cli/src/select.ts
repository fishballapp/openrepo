import type { Package } from './plugin.ts';

/**
 * Every `dependsOn` of a selected package must ship too. Anything unselected is vendored whole, at
 * its own path, transitively. Returns the dirs to add to the selection; the caller re-lists with
 * them (so `exclude` still applies) and calls again until nothing new appears.
 */
export const missingDependencies = (
  selected: ReadonlySet<string>,
  packages: readonly Package[],
): string[] => {
  const byDir = new Map(packages.map(p => [p.dir, p]));
  const seen = new Set<string>();
  const queue = packages.filter(p => selected.has(p.manifest));
  for (let pkg = queue.pop(); pkg !== undefined; pkg = queue.pop()) {
    for (const dir of pkg.dependsOn) {
      const dep = byDir.get(dir);
      if (dep === undefined)
        throw new Error(`${pkg.name} depends on ${dir}, which no plugin knows`);
      if (selected.has(dep.manifest) || seen.has(dir)) continue;
      seen.add(dir);
      queue.push(dep);
    }
  }
  return [...seen].toSorted();
};

/** After the final listing, a vendored package whose manifest `exclude` removed is a config error. */
export const assertClosed = (selected: ReadonlySet<string>, packages: readonly Package[]): void => {
  const byDir = new Map(packages.map(p => [p.dir, p]));
  for (const pkg of packages.filter(p => selected.has(p.manifest))) {
    for (const dir of pkg.dependsOn) {
      const dep = byDir.get(dir);
      if (dep !== undefined && !selected.has(dep.manifest))
        throw new Error(
          `${pkg.name} depends on ${dep.name} (${dir}) but its manifest is excluded; drop the exclude or the dependant`,
        );
    }
  }
};
