# @openrepo/plugin-git

Git support for [OpenRepo](https://github.com/fishballapp/openrepo#readme). Commits the exported
files into a local clone of the public repo. It never pushes; it prints the push command for you.

```ts
import { gitCommit } from '@openrepo/plugin-git';

plugins: [
  gitCommit({
    remote: 'git@github.com:you/thing.git',
    branch: 'main',
    dir: '../thing-public',          // optional; default is under the OS temp dir, printed every run
    authors: [{ name: 'You', email: 'you@example.com' }],
    message: ({ source }) => `release\n\nref-hash: ${source.sha.slice(0, 8)}`,
  }),
]
```

Clones `remote` into `dir`, or reuses it if it's already a clean clone of that remote. Checks out
`branch`, creating it from the remote's default branch if needed. Replaces the branch's files with
the exported ones and commits. The first entry in `authors` is the commit author; the rest become
`Co-authored-by` lines. If an earlier commit hasn't been pushed yet, the new one goes on top of it.

`message` can be a string or a function. The function receives the export context plus
`previous`, the commit at the tip of the branch, which is enough to build a changelog. Requires
`openrepo` as a peer dependency.
