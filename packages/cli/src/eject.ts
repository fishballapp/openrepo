import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ExportConfig, ExportConfigSchema, isContained } from './config.ts';
import { assertRegular, extract, headSha, listTree, readBlob, repoRoot, treeModes } from './git.ts';
import { mapPaths, resolverOf } from './paths.ts';
import type { Artifact, Package, Plugin, Repo } from './plugin.ts';
import { assertClosed, missingDependencies } from './select.ts';

const isText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 8000).includes(0);

/** Load a config module and eject it. */
export const ejectFile = async (
  configPath: string,
  options: { dryRun: boolean },
): Promise<void> => {
  const absolute = resolve(configPath);
  const loaded: unknown = (await import(pathToFileURL(absolute).href)).default;
  if (loaded === undefined)
    throw new Error(`${configPath} has no default export; export default defineExport({ ... })`);
  await eject({
    ...options,
    config: ExportConfigSchema.parse(loaded),
    configDir: dirname(absolute),
  });
};

/** Written into every tree an eject produces; the only kind of dir a later eject will empty. */
const MARKER = '.openrepo';

/**
 * Where the tree lands. Like Vite's `emptyOutDir`: a dir that does not exist is created, a dir
 * a previous eject wrote (it carries the marker) is emptied, anything else is refused unless the
 * config says `emptyOutDir: true`. So nothing that is not ours is ever deleted by default.
 */
const resolveOutDir = (
  root: string,
  configDir: string,
  { outDir, emptyOutDir }: { outDir: string | undefined; emptyOutDir: boolean },
): string => {
  const target =
    outDir === undefined
      ? join(tmpdir(), 'openrepo', 'out', basename(configDir))
      : resolve(root, outDir);
  if (!existsSync(target) || emptyOutDir || existsSync(join(target, MARKER))) return target;
  throw new Error(
    `outDir ${target} exists and was not written by openrepo; set emptyOutDir: true to wipe it anyway`,
  );
};

export const eject = async ({
  config,
  configDir,
  dryRun,
}: {
  config: ExportConfig;
  configDir: string;
  dryRun: boolean;
}): Promise<void> => {
  const root = repoRoot(configDir);
  const sha = headSha(root);
  const outDir = resolveOutDir(root, configDir, {
    outDir: config.outDir,
    emptyOutDir: config.emptyOutDir,
  });

  // Every read goes through the commit; the working tree is never consulted. `ls-files
  // --with-tree` still lists staged additions, so every listing is cut down to what HEAD has.
  const modes = treeModes(root);
  const list = (pathspecs: readonly string[]) =>
    listTree(root, pathspecs).filter(path => modes.has(path));
  const repo: Repo = {
    root,
    sha,
    files: list(['.']),
    read: path => readBlob(root, sha, path),
  };
  const packages: Package[] = config.plugins.flatMap(p => p.packages?.(repo) ?? []);
  const fileKeys = Object.keys(config.files);
  const excludes = config.exclude.map(e => `:!${e}`);

  // Select, then widen with whatever workspace deps are missing, re-listing each time so
  // `exclude` is the last word. Stops when a listing adds nothing.
  const vendored: string[] = [];
  let selected = new Set(list([...config.include, ...fileKeys, ...excludes]));
  for (let missing = missingDependencies(selected, packages); missing.length > 0; ) {
    vendored.push(...missing);
    const widened = new Set(list([...config.include, ...fileKeys, ...vendored, ...excludes]));
    // A listing that adds nothing means `exclude` is holding a dependency out; assertClosed says which.
    if (widened.size === selected.size) break;
    selected = widened;
    missing = missingDependencies(selected, packages);
  }
  assertClosed(selected, packages);
  assertRegular(modes, selected);
  for (const key of fileKeys)
    if (!selected.has(key) && ![...selected].some(p => p.startsWith(`${key}/`)))
      throw new Error(`files: ${key} is not a tracked file or directory at HEAD`);

  const entries = mapPaths([...selected], config.root, config.files);
  const paths = resolverOf(entries);
  const selectedPackages = packages.filter(p => selected.has(p.manifest));

  // A fresh staging dir the tool owns; nothing touches outDir until the tree is complete.
  const staging = mkdtempSync(join(tmpdir(), 'openrepo-'));
  const extracted = mkdtempSync(join(tmpdir(), 'openrepo-src-'));
  try {
    extract(root, sha, [...selected], extracted);
    const manifest = new Set<string>();
    const write = ({ path, content }: Artifact) => {
      if (!isContained(path)) throw new Error(`${path} escapes the tree`);
      const dest = join(staging, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      manifest.add(path);
    };
    for (const [pub, priv] of entries) {
      const src = join(extracted, priv);
      if (!existsSync(src))
        throw new Error(
          `${priv} is tracked but git archive left it out, which .gitattributes export-ignore does; that is not supported`,
        );
      const bytes = readFileSync(src);
      const transforms = config.plugins.flatMap(p => p.transform ?? []);
      if (!isText(bytes) || transforms.length === 0) {
        write({ path: pub, content: bytes });
        continue;
      }
      const content = transforms.reduce(
        (text, transform) =>
          transform({ privatePath: priv, publicPath: pub, content: text }, paths),
        bytes.toString('utf8'),
      );
      write({ path: pub, content });
    }
    // The extracted copy carries the committed file modes; the write above did not. Re-apply.
    for (const [pub, priv] of entries)
      chmodSync(join(staging, pub), statSync(join(extracted, priv)).mode & 0o777);

    // A generated path belongs to the plugin that first emitted it: re-emitting your own artifact
    // (the pnpm lockfile, twice) is fine; overwriting a selected file or another plugin's is not.
    const generated = new Map<string, Plugin>();
    for (const plugin of config.plugins) {
      await plugin.generate?.({
        repo,
        staging,
        paths,
        packages: selectedPackages,
        emit: artifact => {
          const owner = generated.get(artifact.path);
          if (owner === undefined && entries.has(artifact.path))
            throw new Error(`${plugin.name} tried to overwrite selected file ${artifact.path}`);
          if (owner !== undefined && owner !== plugin)
            throw new Error(
              `${plugin.name} tried to overwrite ${artifact.path}, generated by ${owner.name}`,
            );
          write(artifact);
          generated.set(artifact.path, plugin);
        },
      });
    }
    assertOnlyManifest(staging, manifest);

    const files = [...manifest].toSorted();
    console.log(`source ${sha.slice(0, 12)} → ${outDir}`);
    console.log(
      `${files.length} files, ${vendored.length} vendored package dir(s), ${generated.size} generated`,
    );
    for (const dir of vendored) console.log(`  vendored ${dir}`);
    for (const [path, owner] of generated) console.log(`  generated ${path} (${owner.name})`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    try {
      renameSync(staging, outDir);
    } catch {
      // Another volume: copy instead. The finally below removes staging either way.
      cpSync(staging, outDir, { recursive: true });
    }
    writeFileSync(join(outDir, MARKER), `written by openrepo from ${sha}\n`);

    if (dryRun) return;
    for (const plugin of config.plugins)
      await plugin.postExport?.({
        outDir,
        files,
        source: { root, sha },
        packages: selectedPackages,
      });
  } finally {
    rmSync(extracted, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
};

// A generator that runs a tool in staging (pnpm, for the lockfile) can leave droppings. Junk the
// one dir we know about and refuse anything else, so the manifest is the whole truth of the tree.
const assertOnlyManifest = (staging: string, manifest: ReadonlySet<string>): void => {
  rmSync(join(staging, 'node_modules'), { recursive: true, force: true });
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [relative(staging, join(dir, entry.name))],
    );
  const extras = walk(staging).filter(path => !manifest.has(path));
  if (extras.length > 0)
    throw new Error(`files in the tree that no one declared: ${extras.join(', ')}`);
  if (!existsSync(staging)) throw new Error('staging vanished');
};
