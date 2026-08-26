import { posix } from 'node:path';
import type { PathResolver, Plugin, TransformFile } from '@openrepo/cli';
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  type Node,
  parseTree,
} from 'jsonc-parser';

const isRelative = (value: string) => value.startsWith('./') || value.startsWith('../');

// TypeScript's own rules: `extends` names a file (`.json` may be omitted) or a package; a project
// reference names a dir (meaning its tsconfig.json) or a file.
const resolveTarget = (
  fromDir: string,
  value: string,
  paths: PathResolver,
): { file: string; isDir: boolean } => {
  const base = posix.join(fromDir, value);
  const candidates: { file: string; isDir: boolean }[] = [
    { file: base, isDir: false },
    { file: `${base}.json`, isDir: false },
    { file: `${base}/tsconfig.json`, isDir: true },
  ];
  const hit = candidates.find(c => paths.toPublic(c.file) !== undefined);
  if (hit === undefined)
    throw new Error(`${posix.join(fromDir, value)} is referenced but not ejected`);
  return hit;
};

const rePoint = (file: TransformFile, value: string, paths: PathResolver): string => {
  const { file: target, isDir } = resolveTarget(posix.dirname(file.privatePath), value, paths);
  const publicTarget = paths.toPublic(target);
  if (publicTarget === undefined) throw new Error(`${target} has no public path`);
  const publicRef = isDir ? posix.dirname(publicTarget) : publicTarget;
  const rel = posix.relative(posix.dirname(file.publicPath), publicRef);
  const withExt = isDir || value.endsWith('.json') ? rel : rel.replace(/\.json$/, '');
  return isRelative(withExt) ? withExt : `./${withExt}`;
};

const transform = (file: TransformFile, paths: PathResolver): string => {
  if (!/^tsconfig.*\.json$/.test(posix.basename(file.publicPath))) return file.content;
  const tree = parseTree(file.content);
  if (tree === undefined) return file.content;
  const edits: { path: (string | number)[]; value: string }[] = [];
  const consider = (node: Node | undefined, path: (string | number)[]) => {
    const value: unknown = node === undefined ? undefined : getNodeValue(node);
    if (typeof value === 'string' && isRelative(value))
      edits.push({ path, value: rePoint(file, value, paths) });
  };
  const extendsNode = findNodeAtLocation(tree, ['extends']);
  if (extendsNode?.type === 'array') {
    for (const i of (extendsNode.children ?? []).keys())
      consider(findNodeAtLocation(tree, ['extends', i]), ['extends', i]);
  } else consider(extendsNode, ['extends']);
  for (const i of (findNodeAtLocation(tree, ['references'])?.children ?? []).keys())
    consider(findNodeAtLocation(tree, ['references', i, 'path']), ['references', i, 'path']);
  return edits.reduce(
    (text, { path, value }) =>
      applyEdits(text, modify(text, path, value, { formattingOptions: {} })),
    file.content,
  );
};

export const typescript = (): Plugin => ({ name: 'typescript', transform });
