import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { GenerateContext, Plugin, Repo } from '@openrepo/cli';
import { parse, stringify } from 'yaml';
import { assertOnlyPruned, parseWorkspaceLockfile, reachablePatches } from './lockfile.ts';
import {
  type KeptPolicy,
  type Manifest,
  ManifestSchema,
  overridePackages,
  publicWorkspaceYaml,
  type SettingsPolicy,
  toPackages,
  WorkspaceYamlSchema,
  workspaceDirs,
} from './workspace.ts';

const readPrivate = (repo: Repo, path: string): string => {
  if (!repo.files.includes(path)) {
    throw new Error(
      `${path} is not tracked at HEAD; the pnpm plugin needs the private repo's ${path}`,
    );
  }
  return repo.read(path);
};

const readWorkspace = (repo: Repo) =>
  WorkspaceYamlSchema.parse(parse(readPrivate(repo, 'pnpm-workspace.yaml')));

const readManifest = (json: string): Manifest => ManifestSchema.parse(JSON.parse(json));

const pnpmVersion = (): string => {
  try {
    return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error('pnpm is not on PATH; the pnpm plugin runs it to prune the lockfile');
    }
    throw err;
  }
};

// Runs against the copied private lockfile: pnpm drops importers and packages the subset no
// longer reaches. Not `--offline`: the supply-chain check reads registry metadata for every
// entry of the copied lockfile. The caller asserts that nothing changed but size, which is the
// guarantee that matters.
const prune = (staging: string) =>
  execFileSync(
    'pnpm',
    ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile'],
    {
      cwd: staging,
      stdio: 'inherit',
    },
  );

const generate = async (
  { repo, staging, paths, packages, emit }: GenerateContext,
  settings: SettingsPolicy,
): Promise<void> => {
  const source = readWorkspace(repo);
  if (!existsSync(join(staging, 'package.json'))) {
    throw new Error(
      'the ejected tree has no root package.json; check one in under the config root dir, it becomes the public root manifest',
    );
  }
  const rootManifest = readManifest(readFileSync(join(staging, 'package.json'), 'utf8'));
  const wanted = rootManifest.packageManager;
  if (typeof wanted === 'string' && wanted !== `pnpm@${pnpmVersion()}`) {
    throw new Error(`the tree pins ${wanted} but pnpm on PATH is ${pnpmVersion()}`);
  }

  const publicDirs = packages.map(p => {
    const pub = paths.toPublic(p.manifest);
    if (pub === undefined) throw new Error(`${p.manifest} is selected but has no public path`);
    return posix.dirname(pub);
  });
  const manifests = [rootManifest, ...packages.map(p => readManifest(repo.read(p.manifest)))];
  const before = parseWorkspaceLockfile(readPrivate(repo, 'pnpm-lock.yaml'));
  const importerOf = (pub: string): string | undefined => {
    const priv = paths.toPrivate(pub === '.' ? 'package.json' : `${pub}/package.json`);
    if (priv === undefined) return undefined;
    const dir = posix.dirname(priv);
    return dir === '.' ? '.' : dir;
  };
  const assertPruned = (after: ReturnType<typeof parseWorkspaceLockfile>) =>
    assertOnlyPruned(before, after, importerOf);

  // Pass 1 carries every override so the copied lockfile still matches its own `overrides:`
  // section; pass 2 drops the ones whose target the pruned graph no longer contains.
  const all = { overrides: source.overrides ?? {}, allowBuilds: source.allowBuilds ?? {} };
  emit({
    path: 'pnpm-workspace.yaml',
    content: stringify(publicWorkspaceYaml(source, publicDirs, manifests, all, settings)),
  });
  emit({ path: 'pnpm-lock.yaml', content: readPrivate(repo, 'pnpm-lock.yaml') });
  prune(staging);
  const pass1 = parseWorkspaceLockfile(readFileSync(join(staging, 'pnpm-lock.yaml'), 'utf8'));
  assertPruned(pass1);

  const patches = reachablePatches(pass1, source.patchedDependencies ?? {});
  if (patches.length > 0) {
    throw new Error(
      `patched dependencies reach the ejected tree (${patches.join(', ')}); patches are not supported yet`,
    );
  }

  // A selector can name an ejected workspace package too; those never appear in `packages:`.
  const workspaceNames = new Set(packages.map(p => p.name));
  const survives = (name: string) =>
    workspaceNames.has(name) ||
    Object.keys(pass1.packages).some(k => k === name || k.startsWith(`${name}@`));
  const kept: KeptPolicy = {
    overrides: Object.fromEntries(
      Object.entries(all.overrides).filter(([key]) => overridePackages(key).every(survives)),
    ),
    allowBuilds: Object.fromEntries(
      Object.entries(all.allowBuilds).filter(([name]) => survives(name)),
    ),
  };
  const workspace = publicWorkspaceYaml(source, publicDirs, manifests, kept, settings);
  emit({ path: 'pnpm-workspace.yaml', content: stringify(workspace) });
  const dropped =
    Object.keys(all.overrides).length +
    Object.keys(all.allowBuilds).length -
    Object.keys(kept.overrides).length -
    Object.keys(kept.allowBuilds).length;
  if (dropped > 0) {
    prune(staging);
    assertPruned(parseWorkspaceLockfile(readFileSync(join(staging, 'pnpm-lock.yaml'), 'utf8')));
  }
  emit({ path: 'pnpm-lock.yaml', content: readFileSync(join(staging, 'pnpm-lock.yaml'), 'utf8') });
};

export type PnpmOptions = {
  /** Classify `pnpm-workspace.yaml` keys the plugin refuses by default: copy verbatim or leave out. */
  settings?: SettingsPolicy;
};

export const pnpm = ({ settings = {} }: PnpmOptions = {}): Plugin => ({
  name: 'pnpm',
  packages: repo => {
    const dirs = workspaceDirs(readWorkspace(repo).packages, repo.files);
    return toPackages(
      new Map(dirs.map(dir => [dir, readManifest(repo.read(`${dir}/package.json`))])),
    );
  },
  generate: ctx => generate(ctx, settings),
});
