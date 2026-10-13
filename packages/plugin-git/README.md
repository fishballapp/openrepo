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
    message: 'release',
    tag: { name: 'v1.2.0', reachableFrom: 'origin/main' }, // optional, see below
  }),
]
```

Clones `remote` into `dir`, or reuses it if it's already a clean clone of that remote. Checks out
`branch`, creating it from the remote's default branch if needed. Replaces the branch's files with
the exported ones and commits. The first entry in `authors` is the commit author; the rest become
`Co-authored-by` lines. If an earlier commit hasn't been pushed yet, the new one goes on top of it.

Every message ends with a `ref-hash:` trailer, which the plugin writes: the full SHA of the commit
the tree was ejected from. The remote's default branch only moves forward: a run for a commit older
than the one its tip was ejected from commits nothing. Any other branch may go back.

`message` can be a string or a function. The function receives the export context plus
`previous`, the commit at the tip of the branch (`sha`, `message` and `source`, the `ref-hash` it
carries), which is enough to build a changelog. Requires `openrepo` as a peer dependency.

With `tag`, the commit that holds the ejected tree is tagged: committed first if the branch does
not hold the tree yet, never on top of a newer one, and found through the `ref-hash:` trailers when
the branch has moved past. An existing tag on the same commit is kept as it is; on another, it's an error. A
commit that is not reachable from `reachableFrom` is refused. See the
[README](https://github.com/fishballapp/openrepo#release-tags).
