<div align="center">

<img src="./assets/logo.png" width="140" alt="">

# OpenRepo

**Open up your repo.** Publish part of a private monorepo as a standalone public repo.

[![npm version](https://img.shields.io/npm/v/@openrepo/cli?color=2563eb&label=%40openrepo%2Fcli)](https://www.npmjs.com/package/@openrepo/cli)
[![npm downloads](https://img.shields.io/npm/dm/@openrepo/cli?color=2563eb)](https://www.npmjs.com/package/@openrepo/cli)
[![CI](https://github.com/fishballapp/openrepo/actions/workflows/ci.yml/badge.svg)](https://github.com/fishballapp/openrepo/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/npm/l/@openrepo/cli?color=2563eb)](./LICENSE)

</div>

You develop in one private monorepo. Some projects in it should be open source, but moving them
out would mean giving up the shared setup you built the monorepo for.

OpenRepo copies the projects you choose into a new pnpm workspace that installs and builds on its
own. It brings along the internal packages they depend on, trims your lockfile and catalog down to
what they use, and rewrites the few config paths that change when a project moves to the top
level. Then it commits the result into a local clone of the public repo. You review it and push.

We call one run of this an "eject". This repository is itself an eject of a private monorepo:
every commit on `main` is one release.

## What you get

- **Only committed files.** OpenRepo reads from your latest commit, not from your working
  directory, so unstaged edits and ignored files can't end up in the public repo.
- **A complete workspace.** If a selected package depends on another workspace package, that
  package is copied in too.
- **The same versions.** The public lockfile is your lockfile with the unused entries removed.
  OpenRepo checks that no version changed in the process.
- **Your files, not generated ones.** The public repo's `package.json`, README, licence and CI are
  normal files you keep in the project directory. OpenRepo only generates `pnpm-workspace.yaml`
  and `pnpm-lock.yaml`.
- **No automatic push.** The git plugin commits into a local clone and tells you the command to
  push. Running an eject never changes anything remote.
- **Clear errors.** If your setup has something OpenRepo can't handle yet, it stops and tells you
  what, instead of producing a broken repo.
- **Plugins.** pnpm, TypeScript and git support are plugins. You can write your own.

## Installation

```bash
pnpm add -Dw @openrepo/cli @openrepo/plugin-pnpm @openrepo/plugin-typescript @openrepo/plugin-git
```

Needs Node 24 or newer, git, and pnpm. Install at the workspace root (`-w`): the config file imports
the plugins, and the plugins depend on `@openrepo/cli`.

## Quick start

**1. Add the public repo's root files to the project directory.**

The directory you set as `root` becomes the top level of the public repo. Put in it whatever a
standalone repo needs: a `package.json` with scripts, dev dependencies and `packageManager`; a
`tsconfig.json` if you use project references; `README.md`, `LICENSE`, `.gitignore`, and a CI
workflow under `.github/workflows/`. In the private monorepo these files do nothing (pnpm's
workspace globs match `projects/*/packages/*`, not `projects/thing` itself). In the public repo
they are the real root files.

```
projects/thing/
├── package.json  tsconfig.json  README.md  LICENSE  .gitignore  .github/workflows/ci.yml
├── openrepo.config.ts        ← not exported
├── AGENTS.md                 ← private notes, not exported
└── packages/…                ← the code
```

**2. Write the config.**

```ts
// projects/thing/openrepo.config.ts
import { defineExport } from '@openrepo/cli';
import { gitCommit } from '@openrepo/plugin-git';
import { pnpm } from '@openrepo/plugin-pnpm';
import { typescript } from '@openrepo/plugin-typescript';

export default defineExport({
  root: 'projects/thing',
  include: ['projects/thing', 'biome.json', 'tsconfig.base.json'],
  exclude: ['projects/thing/AGENTS.md', 'projects/thing/openrepo.config.ts'],
  plugins: [
    pnpm(),
    typescript(),
    gitCommit({
      remote: 'git@github.com:you/thing.git',
      branch: 'main',
      authors: [{ name: 'You', email: 'you@example.com' }],
      message: 'v1.0.0',
    }),
  ],
});
```

**3. Try it without committing anything.**

```bash
pnpm openrepo eject projects/thing/openrepo.config.ts --dry-run
```

This prints every file, which packages were pulled in, which files were generated, and where the
result is. Go to that directory and run the public repo's own checks: `pnpm install
--frozen-lockfile`, lint, typecheck, tests. Fix things until they pass.

**4. Eject for real.**

```bash
pnpm openrepo eject projects/thing/openrepo.config.ts
```

Same as the dry run, then the git plugin commits the result into a local clone of the public repo
and prints the path. Look at the commit, change it if you want, and push it yourself.

**5. Next release.** Bump the version, commit in the monorepo, eject again. The new commit lands
on top of the previous one in the same clone.

## How it works

1. Lists the files matched by `include` and `exclude` at your latest commit.
2. Adds every workspace package those files depend on. `exclude` is applied again afterwards.
3. Works out each file's public path: files under `root` lose that prefix, other files keep their
   path.
4. Copies the files into a staging directory and runs each plugin's `transform` on them. This is
   where a `tsconfig.json` that pointed at `../../../../tsconfig.base.json` gets pointed at
   `../../tsconfig.base.json`.
5. Runs each plugin's `generate` to add root files: the trimmed `pnpm-workspace.yaml` and lockfile.
6. Moves the result to `outDir` and runs each plugin's `postExport`.

## Configuration

| Key | Meaning |
| --- | --- |
| `root` | Directory that becomes the public root. Files under it lose the prefix; other files keep their path. |
| `include` / `exclude` | git pathspecs: directories, files, `*` and `**` work like in `.gitignore`. `exclude` always wins, even over packages pulled in as dependencies. |
| `files` | `{ [privatePath]: publicPath }` for a file or a directory that has to land somewhere other than its default: a CI workflow the monorepo also runs, or a shared package pulled in from outside `root` that should sit under `internal/` rather than keep its monorepo path. A directory moves with everything under it. |
| `outDir` | Where the result goes. Default is a directory under the OS temp dir, printed on every run. The directory must not exist yet, or must be one a previous eject wrote (it leaves a `.openrepo` marker). Anything else is refused. |
| `emptyOutDir` | `true` to wipe an existing `outDir` that OpenRepo didn't write. Same idea as Vite's option of the same name. Default `false`. |
| `plugins` | The plugins, in the order their hooks should run. |

The CLI has one command: `openrepo eject <config> [--dry-run]`. `--dry-run` does everything except
run `postExport` hooks.

## Plugins

### `@openrepo/plugin-pnpm`

`pnpm({ settings? })`

Finds packages through `pnpm-workspace.yaml` and generates the public `pnpm-workspace.yaml` and
`pnpm-lock.yaml`. The workspace file keeps only the catalog entries the exported packages use. The
lockfile is your lockfile pruned by `pnpm install --lockfile-only`, then compared entry by entry
with the original; any changed version is an error.

Each setting in `pnpm-workspace.yaml` is either copied (install policy such as `minimumReleaseAge`),
regenerated (`packages`, catalogs, `overrides`), or rejected because it can't work in the public
repo (`pnpmfile`, `sharedWorkspaceLockfile`, `useLockfile`). A setting the plugin hasn't seen
before is also rejected; the error tells you to add it to `settings: { keep: [...] }` or
`settings: { drop: [...] }`.

### `@openrepo/plugin-typescript`

`typescript()`

Updates relative `extends` and `references[].path` entries in `tsconfig*.json` files so they still
point at the right file after the move. Comments are kept. Pointing at a file that isn't exported
is an error.

### `@openrepo/plugin-git`

`gitCommit({ remote, branch, dir?, message, authors })`

Clones `remote` into `dir` (default: a directory under the OS temp dir, printed on every run), or
reuses it if it's already a clean clone of that remote. Checks out `branch`, creating it from the
remote's default branch if it doesn't exist yet. Replaces the branch's files with the exported
ones and commits. The first entry in `authors` is the commit author; the rest become
`Co-authored-by` lines. It never pushes; it prints the push command.

`message` can be a string or a function. The function receives the export context plus
`previous`, the commit currently at the tip of the branch, which lets you write a changelog. This
repository's own config does that:

```ts
message: ({ outDir, source, previous }) => {
  const { version } = JSON.parse(readFileSync(join(outDir, 'packages/cli/package.json'), 'utf8'));
  const from = previous?.message.match(/ref-hash: (\w+)/)?.[1];
  const log = execSync(`git log --format='- %s' ${from ? `${from}..` : ''}${source.sha} -- projects/openrepo`, {
    cwd: source.root,
    encoding: 'utf8',
  });
  return `v${version}\n\n${log.trim()}\n\nref-hash: ${source.sha.slice(0, 8)}`;
},
```

## Writing a plugin

A plugin is an object with a name and any of four functions.

```ts
import type { Plugin } from '@openrepo/cli';

export const licenseHeaders = (header: string): Plugin => ({
  name: 'license-headers',
  transform: file =>
    file.publicPath.endsWith('.ts') ? `${header}\n${file.content}` : file.content,
});
```

| Function | Called | Purpose |
| --- | --- | --- |
| `packages(repo)` | before files are selected | return the workspace packages and what they depend on, so dependencies get pulled in |
| `transform(file, paths)` | once per text file | return the file's new content. `paths.toPublic(p)` and `paths.toPrivate(p)` convert between the two layouts; `paths.publicPaths` lists every exported file |
| `generate(ctx)` | after all files are in the staging directory | add generated files with `ctx.emit({ path, content })`. You may run a tool in `ctx.staging` first |
| `postExport(ctx)` | after the result is in `outDir`; skipped on `--dry-run` | anything that acts on the finished result, like committing |

`repo.read(path)` returns a file's content at the latest commit. A plugin can't overwrite a file
that was selected from the repo, and can't overwrite a file another plugin generated.

## Limits

OpenRepo is new and was built for one monorepo first, so it supports what that monorepo uses and
not yet every setup out there. We want to get there one real case at a time. Until then, when it
meets something it can't handle it stops and says so instead of producing a repo that looks right
but isn't. Today it assumes:

- pnpm 9 or newer, with one lockfile for the whole workspace, and `pnpm` installed at the exact
  version the public `package.json` names in `packageManager`.
- `workspace:*`, `workspace:^`, `workspace:~` or `workspace:<range>` for internal dependencies.
  `workspace:name@…` and `workspace:../path` are not supported.
- No patched dependencies among the exported packages.
- The exported root has its own `package.json`. OpenRepo only generates `pnpm-workspace.yaml` and
  `pnpm-lock.yaml`.
- TypeScript path rewriting covers `extends` and `references` only. Other settings that point
  outside the exported files (`include`, `paths`, `rootDir`) are left alone; the public repo's
  typecheck will show if one is wrong.
- No symlinks, no submodules, and no files that `.gitattributes` marks `export-ignore`.
- Optional peer dependencies stay resolved the way your private lockfile resolved them. pnpm 11
  satisfies an optional peer from anywhere in the graph, so a package only a sibling project needed
  can remain in the public lockfile, keyed differently. Versions never change; the public tree may
  install more than it strictly needs.
- Windows is untested.

If your monorepo doesn't fit, [open an issue](https://github.com/fishballapp/openrepo/issues) and
describe it. That's how this list gets shorter.

## Contributing

Issues and feature requests are welcome. Pull requests are disabled, because this repository is
an exported copy and a patch merged here would be lost on the next release. Describe the change in
an issue, with a diff if you have one, and it will be applied in the source repo and credited.

## Licence

[MIT](./LICENSE)
