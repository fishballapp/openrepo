# OpenRepo

**Open up your repo.** Publish part of a private monorepo as a standalone public repo.

OpenRepo copies the projects you choose into a new pnpm workspace that installs and builds on its
own, brings along the internal packages they depend on, trims the lockfile to what they use, and
commits the result into a local clone of the public repo. You review it and push.

```bash
pnpm add -Dw @openrepo/cli @openrepo/plugin-pnpm @openrepo/plugin-typescript @openrepo/plugin-git
pnpm openrepo eject projects/thing/openrepo.config.ts --dry-run
```

This package is the core: the `openrepo eject` command, `defineExport`, and the `Plugin` type.
Package-manager and language support come from plugins:
[`@openrepo/plugin-pnpm`](https://www.npmjs.com/package/@openrepo/plugin-pnpm),
[`@openrepo/plugin-typescript`](https://www.npmjs.com/package/@openrepo/plugin-typescript),
[`@openrepo/plugin-git`](https://www.npmjs.com/package/@openrepo/plugin-git).

Guide, configuration, plugin authoring and current limits:
[github.com/fishballapp/openrepo](https://github.com/fishballapp/openrepo#readme).
