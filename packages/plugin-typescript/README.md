# @openrepo/plugin-typescript

TypeScript support for [OpenRepo](https://github.com/fishballapp/openrepo#readme). When a project
moves to the top level of the public repo, relative paths in its `tsconfig*.json` files change.
This plugin updates `extends` and `references[].path` so they still point at the right file, and
keeps comments intact. A path that points at a file that wasn't exported is an error.

```ts
import { pnpm } from '@openrepo/plugin-pnpm';
import { typescript } from '@openrepo/plugin-typescript';

plugins: [pnpm(), typescript()]
```

Only those two settings are rewritten. Others that could point outside the exported files
(`include`, `paths`, `rootDir`) are left as they are, and the public repo's typecheck will show if
one is wrong. Requires `@openrepo/cli` as a peer dependency.
