# @openrepo/plugin-pnpm

pnpm support for [OpenRepo](https://github.com/fishballapp/openrepo#readme). Finds packages
through `pnpm-workspace.yaml` (so internal `workspace:` dependencies get copied in), then generates
the public `pnpm-workspace.yaml` with only the catalog entries the exported packages use, and a
`pnpm-lock.yaml` pruned from the private one with every version kept the same.

```ts
import { pnpm } from '@openrepo/plugin-pnpm';

plugins: [pnpm()]

// A pnpm-workspace.yaml setting the plugin doesn't know is an error. Tell it what to do:
plugins: [pnpm({ settings: { keep: ['someSetting'], drop: ['otherSetting'] } })]
```

A setting that lists packages (`minimumReleaseAgeExclude`, `onlyBuiltDependencies`,
`neverBuiltDependencies`, `ignoredBuiltDependencies`, `overrides`, `allowBuilds`) keeps only the
entries that match a package in the public lockfile, so the public file does not name the private
repo's other packages. An entry is a name or a `*` pattern; a version part (`name@1.0.0`) is not
judged.

Stops with an explanation on anything it can't carry over: lockfiles older than v9, patched
dependencies among the exported packages, `workspace:name@…` or `workspace:../path` specifiers,
and settings that can't work in a standalone repo. Requires `@openrepo/cli` as a peer dependency.
