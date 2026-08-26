import { z } from 'zod';
import type { Plugin } from './plugin.ts';

/** A public path stays inside the tree: relative, forward slashes only, no `.`, `..` or `.git` segment. */
export const isContained = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !/^[a-zA-Z]:/.test(path) &&
  !path.split('/').some(s => s === '' || s === '.' || s === '..' || s === '.git');

const PublicPath = z
  .string()
  .refine(
    isContained,
    'must be a relative forward-slash path without empty, `.`, `..` or `.git` segments',
  );

// One config = one ejected repo. Paths are relative to the private repo root and name files at
// HEAD; nothing outside the commit is ever read.
export const ExportConfigSchema = z.object({
  /** This dir becomes the root of the ejected tree; paths outside it keep their own. */
  root: PublicPath,
  /**
   * Where the tree lands, relative to the private repo root or absolute. Must not exist, or must
   * be a dir a previous eject wrote (see `emptyOutDir`). Default: under the OS temp dir.
   */
  outDir: z.string().min(1).optional(),
  /** Wipe an existing `outDir` that a previous eject did not write. Off by default. */
  emptyOutDir: z.boolean().default(false),
  /** git pathspecs. */
  include: z.array(z.string().min(1)).min(1),
  /** git pathspecs. A deny rule: re-applied after workspace deps are pulled in. */
  exclude: z.array(z.string().min(1)).default([]),
  /** Private tracked file or directory → public path. Added to the selection; its default mapping is replaced. */
  files: z.record(PublicPath, PublicPath).default({}),
  plugins: z
    .array(
      z.custom<Plugin>(v => typeof v === 'object' && v !== null && 'name' in v, 'not a plugin'),
    )
    .default([]),
});

export type ExportConfig = z.infer<typeof ExportConfigSchema>;

export const defineExport = (config: z.input<typeof ExportConfigSchema>): ExportConfig =>
  ExportConfigSchema.parse(config);
