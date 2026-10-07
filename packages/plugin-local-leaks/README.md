# @openrepo/plugin-local-leaks

Local-leak scanning for [OpenRepo](https://github.com/fishballapp/openrepo#readme). Before an eject
writes or commits anything, it stops on a path from your machine or a `.env` file you have not
allowed.

```ts
import { localLeaks } from '@openrepo/plugin-local-leaks';

plugins: [localLeaks()]
```

- `local-leaks/path`: your home directory, the private repo root, and any home directory path
  (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), also as JSON escapes it.
- `local-leaks/env-file`: `.env` and `.env.*` files. `.env.example`, `.env.sample`,
  `.env.template` and `.env.schema` are fine.

A finding meant to be public, like a test fixture, goes in the config's `allowLeaks`:

```ts
allowLeaks: [{ path: 'test/fixtures/**', rule: 'local-leaks/path' }],
```

For tokens and keys, add [`@openrepo/plugin-secretlint`](https://www.npmjs.com/package/@openrepo/plugin-secretlint) too.
