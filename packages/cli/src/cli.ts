#!/usr/bin/env node
// openrepo — eject a standalone workspace from a private monorepo.
//
//   openrepo eject <config> [--dry-run]
import { buildApplication, buildCommand, buildRouteMap, run, text_en } from '@stricli/core';
import { z } from 'zod';
import { ejectFile } from './eject.ts';

const formatError = (err: unknown): string => {
  if (err instanceof z.ZodError)
    return err.issues
      .map(i => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
  return err instanceof Error ? err.message : String(err);
};

const ejectCommand = buildCommand({
  async func(flags: { dryRun: boolean }, config: string) {
    await ejectFile(config, { dryRun: flags.dryRun });
  },
  parameters: {
    flags: {
      dryRun: {
        kind: 'boolean',
        brief: 'Write the tree and print the summary, but run no postExport hook',
        default: false,
      },
    },
    positional: {
      kind: 'tuple',
      parameters: [{ parse: String, brief: 'Path to the config file', placeholder: 'config' }],
    },
  },
  docs: { brief: 'Eject the tree a config describes' },
});

const app = buildApplication(
  buildRouteMap({ routes: { eject: ejectCommand }, docs: { brief: 'Open up your repo' } }),
  {
    name: 'openrepo',
    scanner: { caseStyle: 'allow-kebab-for-camel' },
    localization: {
      text: { ...text_en, formatException: exc => `\n✖ openrepo: ${formatError(exc)}` },
    },
  },
);
process.on('unhandledRejection', err => {
  console.error(`\n✖ openrepo: ${formatError(err)}`);
  process.exit(1);
});
await run(app, process.argv.slice(2), { process });
