# @openrepo/plugin-secretlint

Secret scanning for [OpenRepo](https://github.com/fishballapp/openrepo#readme). Before an eject
writes or commits anything, it scans the tree with
[secretlint](https://github.com/secretlint/secretlint) and stops on any token, API key or private
key you have not allowed.

```ts
import { secretlint } from '@openrepo/plugin-secretlint';

plugins: [secretlint()]
```

It runs secretlint's recommended rules in-process, with no network calls, plus Google API keys
(which the preset misses) and AWS access key ids (which the preset leaves off). `secretlint({ rules })`
adds more secretlint rules.

Nothing in the tree can silence it: `.secretlintrc`, `.secretlintignore` and `secretlint-disable`
comments are not read. A finding meant to be public, like a test fixture, goes in the config's
`allowLeaks`:

```ts
allowLeaks: [{ path: 'test/fixtures/**', rule: 'secretlint/github' }],
```

Rules are named `secretlint/` plus secretlint's rule name: `secretlint/github`,
`secretlint/privatekey`, `secretlint/google-api-key`. The error shows the first four characters of
a secret, never the rest.
