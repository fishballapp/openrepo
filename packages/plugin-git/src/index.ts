import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Plugin, PostExportContext } from '@openrepo/cli';

export type Author = { name: string; email: string };

/** A public tag to place on the commit that holds the ejected tree. */
export type ReleaseTag = {
  /** The tag's name in the public repo, like `v1.2.0`. */
  name: string;
  /**
   * A ref in the private repo, like `origin/main`, that the ejected commit must be reachable from.
   * A commit that was never on it is refused before the checkout is touched.
   */
  reachableFrom: string;
};

export type Previous = {
  sha: string;
  message: string;
  /** The private commit it was ejected from: its `ref-hash:` trailer as written, or `null`. */
  source: string | null;
};

export type GitCommitOptions = {
  remote: string;
  branch: string;
  /**
   * The checkout the snapshot is committed into. Relative to the private repo root, or absolute.
   * Cloned from `remote` when missing; when present it must be a clean clone of that remote.
   * Default: a dir named after the remote under the OS temp dir.
   */
  dir?: string;
  /**
   * The commit message, or a function of the context plus the branch tip it lands on. The plugin
   * appends the `ref-hash:` trailer itself; a message that carries one is refused.
   */
  message: string | ((ctx: PostExportContext & { previous: Previous | null }) => string);
  /** Who the snapshot is by: the first is the commit author, the rest are `Co-authored-by:` trailers. */
  authors: readonly [Author, ...Author[]];
  /**
   * Tag the branch's commit that holds this eject's tree, so the public repo can build a release
   * from the tag. Local only, like the commit: push `refs/tags/<name>` yourself. The commit is
   * found through the `ref-hash:` trailers, which name the private commit each one was ejected from:
   *
   * - The branch is behind (its tip was ejected from this commit or an ancestor): the tree is
   *   committed first if the branch lacks it, then tagged.
   * - The branch has moved past: nothing is committed, and the newest commit ejected from this
   *   commit or an ancestor is tagged. It must hold exactly this tree.
   *
   * A tag that already sits on that commit is left alone; one on any other commit is an error.
   */
  tag?: ReleaseTag;
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });

const tryGit = (cwd: string, args: readonly string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** `true` / `false` as git answers; `null` when either commit is unknown to the repo. */
const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean | null => {
  const { status } = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', `${ancestor}^{commit}`, `${descendant}^{commit}`],
    { cwd, stdio: 'ignore' },
  );
  if (status === 0) return true;
  return status === 1 ? false : null;
};

const TRAILER = /^ref-hash: ([0-9a-f]+)$/m;
const sourceOf = (message: string): string | null => TRAILER.exec(message)?.[1] ?? null;

/** The commit `tag` points at on the remote, or `null` when the remote has no such tag. */
const remoteTag = (cwd: string, tag: string): string | null => {
  const out = git(cwd, ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const shas = new Map(
    out
      .split('\n')
      .filter(line => line !== '')
      .map(line => {
        const [sha = '', ref = ''] = line.split('\t');
        return [ref, sha] as const;
      }),
  );
  // An annotated tag lists the tag object, then the commit it peels to.
  return shas.get(`refs/tags/${tag}^{}`) ?? shas.get(`refs/tags/${tag}`) ?? null;
};

/** The branch's first-parent history, newest first, with the private commit each was ejected from. */
const ejectedCommits = (cwd: string): { sha: string; source: string | null }[] =>
  git(cwd, ['log', '-z', '--first-parent', '--format=%H%n%B', 'HEAD'])
    .split('\0')
    .filter(record => record.trim() !== '')
    .map(record => {
      const [sha = '', ...message] = record.trim().split('\n');
      return { sha, source: sourceOf(message.join('\n')) };
    });

/**
 * The branch commit the release tag belongs on, given the snapshot staged in `dir`: its sha when
 * the branch already holds the tree, `null` when the snapshot has to be committed first.
 */
const tagHolder = ({
  dir,
  source,
  previous,
  hasChanges,
}: {
  dir: string;
  source: { root: string; sha: string };
  previous: Previous | null;
  hasChanges: boolean;
}): string | null => {
  const isBehind =
    previous === null ||
    (previous.source !== null && isAncestor(source.root, previous.source, source.sha) === true);
  if (isBehind) return hasChanges || previous === null ? null : previous.sha;

  // The branch has moved past: commit nothing, find what was ejected from this commit.
  const stagedTree = git(dir, ['write-tree']).trim();
  const ejected = ejectedCommits(dir).find(
    ({ source: from }) => from !== null && isAncestor(source.root, from, source.sha) === true,
  );
  if (ejected === undefined) {
    throw new Error(`no commit on the branch was ejected from ${source.sha} or an ancestor of it`);
  }
  if (git(dir, ['rev-parse', `${ejected.sha}^{tree}`]).trim() !== stagedTree) {
    throw new Error(
      `the branch has moved past ${source.sha}, and ${ejected.sha} (ejected from ${ejected.source}) ` +
        'does not hold its tree: this commit changed the public tree but was never ejected itself',
    );
  }
  return ejected.sha;
};

const remoteHeads = (cwd: string): { defaultBranch: string | null; branches: Set<string> } => {
  const out = git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? null;
  const branches = new Set([...out.matchAll(/\trefs\/heads\/(\S+)$/gm)].map(m => m[1] ?? ''));
  return { defaultBranch, branches };
};

const slug = (remote: string): string =>
  remote
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-');

/** A clone of `remote` at `dir`, on `branch`, fast-forwarded to the remote if it has the branch. */
const prepareCheckout = (dir: string, remote: string, branch: string): void => {
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    git(dirname(dir), ['clone', '-q', remote, dir]);
  } else {
    const origin = tryGit(dir, ['remote', 'get-url', 'origin'])?.trim();
    if (origin !== remote) {
      throw new Error(`${dir} is not a clone of ${remote} (origin: ${origin ?? 'none'})`);
    }
    if (git(dir, ['status', '--porcelain']).trim() !== '') {
      throw new Error(`${dir} has uncommitted changes; commit or discard them first`);
    }
  }
  git(dir, ['fetch', '-q', 'origin']);
  const { defaultBranch, branches } = remoteHeads(dir);
  const hasLocal = tryGit(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) !== null;
  if (hasLocal) {
    git(dir, ['checkout', '-q', branch]);
    // Local commits from an earlier eject that is not pushed yet stay; a diverged remote is an error.
    if (branches.has(branch)) git(dir, ['merge', '-q', '--ff-only', `origin/${branch}`]);
    return;
  }
  if (branches.has(branch)) {
    git(dir, ['checkout', '-q', '-b', branch, `origin/${branch}`]);
    return;
  }
  if (defaultBranch !== null && branches.has(defaultBranch)) {
    git(dir, ['checkout', '-q', '-b', branch, `origin/${defaultBranch}`]);
    return;
  }
  git(dir, ['checkout', '-q', '--orphan', branch]);
};

export const gitCommit = ({
  remote,
  branch,
  dir: dirOption,
  message,
  authors,
  tag,
}: GitCommitOptions): Plugin => ({
  name: 'git-commit',
  postExport: async ctx => {
    execFileSync('git', ['check-ref-format', '--branch', branch]);
    if (tag !== undefined) {
      execFileSync('git', ['check-ref-format', `refs/tags/${tag.name}`]);
      if (isAncestor(ctx.source.root, ctx.source.sha, tag.reachableFrom) !== true) {
        throw new Error(`${ctx.source.sha} is not reachable from ${tag.reachableFrom}`);
      }
    }
    const dir =
      dirOption === undefined
        ? join(tmpdir(), 'openrepo', slug(remote))
        : resolve(ctx.source.root, dirOption);
    prepareCheckout(dir, remote, branch);
    const headSha = tryGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim();
    const tipMessage = headSha === undefined ? '' : git(dir, ['log', '-1', '--format=%B']).trim();
    const previous: Previous | null =
      headSha === undefined
        ? null
        : { sha: headSha, message: tipMessage, source: sourceOf(tipMessage) };

    const text = typeof message === 'string' ? message : message({ ...ctx, previous });
    if (TRAILER.test(text)) {
      throw new Error('the message carries a ref-hash: trailer; the plugin writes it');
    }
    const [author, ...coAuthors] = authors;
    const trailers = [
      `ref-hash: ${ctx.source.sha}`,
      ...coAuthors.map(({ name, email }) => `Co-authored-by: ${name} <${email}>`),
    ];
    const body = `${text}\n\n${trailers.join('\n')}`;
    // The message and author go public with the tree, but the tree scan never saw them. Checked
    // before the checkout changes, so a fixed message can simply be retried.
    const leaks = await ctx.scan([
      { path: 'commit message', content: `${body}\n${author.name} <${author.email}>` },
    ]);
    if (leaks.length > 0) {
      const found = leaks.map(({ rule, excerpt }) => `${rule} ${excerpt}`).join(', ');
      throw new Error(`the commit message would leak: ${found}`);
    }

    git(dir, ['rm', '-rfq', '--ignore-unmatch', '.']);
    for (const file of ctx.files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(ctx.outDir, file), join(dir, file));
    }
    // Exactly the manifest, forced past any `.gitignore` the tree itself ships.
    const list = join(dir, '.git', 'openrepo-pathspec');
    writeFileSync(list, ctx.files.join('\0'));
    git(dir, ['add', '-f', '--pathspec-from-file', list, '--pathspec-file-nul']);
    rmSync(list, { force: true });
    // Puts the checkout back as the branch has it, for a snapshot that is not committed.
    const discard = () => tryGit(dir, ['reset', '-q', '--hard', 'HEAD']);

    console.log(`repo: ${dir} (${branch})`);
    const hasChanges = git(dir, ['status', '--porcelain']).trim() !== '';

    // The default branch only moves forward. A run for an older commit that arrives after a newer
    // one's (a release tag's run can beat the eject of an earlier merge) commits nothing, rather
    // than put the older tree on top. Other branches may rewind: a pull request can drop commits.
    if (
      tag === undefined &&
      previous?.source != null &&
      branch === remoteHeads(dir).defaultBranch &&
      isAncestor(ctx.source.root, ctx.source.sha, previous.source) === true &&
      isAncestor(ctx.source.root, previous.source, ctx.source.sha) !== true
    ) {
      discard();
      console.log(`nothing to commit: ${branch} was last ejected from a newer commit`);
      return;
    }

    // The branch commit the tag goes on; `null` is the snapshot, once it is committed.
    let tagged: string | null = null;
    if (tag !== undefined) {
      try {
        tagged = tagHolder({ dir, source: ctx.source, previous, hasChanges });
        const existing = remoteTag(dir, tag.name);
        if (existing !== null && existing !== tagged) {
          throw new Error(
            `tag ${tag.name} is already on ${existing}, but this tree belongs on ${tagged ?? 'a new commit'}`,
          );
        }
      } catch (error) {
        discard();
        throw error;
      }
      if (tagged !== null) discard();
    }

    let hasToPush = tag !== undefined;
    if (hasChanges && (tag === undefined || tagged === null)) {
      git(dir, [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '-q',
        '-m',
        body,
      ]);
      console.log(`committed ${git(dir, ['rev-parse', '--short', 'HEAD']).trim()}`);
      hasToPush = true;
    } else {
      console.log(
        tagged !== null && tagged !== headSha
          ? `nothing to commit: ${branch} has moved past this commit`
          : 'nothing to commit: the branch already holds this tree',
      );
      // No remote branch yet means every local commit is unpushed.
      const unpushed = (
        tryGit(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]) ??
        tryGit(dir, ['rev-list', '--count', 'HEAD']) ??
        '0'
      ).trim();
      if (unpushed !== '0') {
        console.log(`${unpushed} unpushed commit(s)`);
        hasToPush = true;
      }
    }

    if (tag !== undefined) {
      const commit = tagged ?? git(dir, ['rev-parse', 'HEAD']).trim();
      if (remoteTag(dir, tag.name) === null) {
        // `-f`: a tag of an earlier run that never got pushed.
        git(dir, ['tag', '-f', tag.name, commit]);
        console.log(`tagged ${tag.name} on ${commit.slice(0, 12)}`);
      } else {
        // Already on this commit (checked above): take the remote's own, annotated or not, so the
        // push leaves it as it is.
        git(dir, ['fetch', '-q', 'origin', `+refs/tags/${tag.name}:refs/tags/${tag.name}`]);
        console.log(`${tag.name} is already on ${commit.slice(0, 12)}`);
      }
    }
    if (hasToPush) {
      console.log(
        `push with: git -C ${dir} push origin ${branch}${tag === undefined ? '' : ` refs/tags/${tag.name}`}`,
      );
    }
  },
});
