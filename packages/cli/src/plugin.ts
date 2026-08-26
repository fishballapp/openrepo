/** A workspace member as one ecosystem sees it. `dir`, `manifest` and `dependsOn` are private paths. */
export type Package = {
  dir: string;
  manifest: string;
  name: string;
  dependsOn: readonly string[];
};

/** The private repo at the commit being ejected. `read` returns committed bytes, never the working tree. */
export type Repo = {
  root: string;
  sha: string;
  files: readonly string[];
  read: (path: string) => string;
};

export type PathResolver = {
  toPublic: (privatePath: string) => string | undefined;
  toPrivate: (publicPath: string) => string | undefined;
  /** Every public path in the tree, sorted. */
  publicPaths: readonly string[];
};

export type TransformFile = { privatePath: string; publicPath: string; content: string };

export type Artifact = { path: string; content: string | Uint8Array };

export type GenerateContext = {
  repo: Repo;
  /** The staging dir every selected file has already been written to. Read freely, write via `emit`. */
  staging: string;
  paths: PathResolver;
  packages: readonly Package[];
  /** Write a derived file. `path` is public, checked like every other path, and joins the manifest. */
  emit: (artifact: Artifact) => void;
};

export type PostExportContext = {
  outDir: string;
  /** The final manifest: every public path in the tree, sorted. */
  files: readonly string[];
  source: { root: string; sha: string };
  packages: readonly Package[];
};

export type Plugin = {
  name: string;
  /** The packages this ecosystem knows about and how they depend on each other. */
  packages?: (repo: Repo) => Package[];
  /** Rewrite one text file on its way into the tree. Runs in plugin order. */
  transform?: (file: TransformFile, paths: PathResolver) => string;
  /** Derive root files (a workspace manifest, a lockfile) once every selected file is in staging. */
  generate?: (ctx: GenerateContext) => Promise<void>;
  /** After the tree is final. Skipped by `--dry-run`. */
  postExport?: (ctx: PostExportContext) => Promise<void>;
};
