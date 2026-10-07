import type { Finding, Plugin } from '@openrepo/cli';
import { lintSource } from '@secretlint/core';
import { rules as recommended } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfigUnionRule, SecretLintRuleCreator } from '@secretlint/types';

export type SecretlintOptions = {
  /** More secretlint rules, run alongside the recommended preset. */
  rules?: readonly SecretLintCoreConfigUnionRule[];
};

// The key alphabet includes `-` and `_`, so the edges are lookarounds: `\b` would miss a key that
// ends in `-`.
const GOOGLE_API_KEY = /(?<![\w-])AIza[\w-]{35}(?![\w-])/g;

// The preset's gcp rule finds service-account JSON only, not a bare browser API key.
const googleApiKey: SecretLintRuleCreator = {
  messages: { FOUND: { en: () => 'found a Google API key' } },
  meta: {
    id: 'google-api-key',
    recommended: true,
    type: 'scanner',
    supportedContentTypes: ['text'],
  },
  create(context) {
    const t = context.createTranslator(googleApiKey.messages);
    return {
      file(source) {
        for (const match of source.content.matchAll(GOOGLE_API_KEY)) {
          context.report({
            message: t('FOUND'),
            range: [match.index, match.index + match[0].length],
          });
        }
      },
    };
  },
};

// filter-comments is left out, so a `secretlint-disable` comment in the tree cannot hide a
// finding: the only way to allow one is the config's `allowLeaks`.
const PRESET = recommended
  .filter(rule => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments')
  .map(rule => ({
    id: rule.meta.id,
    rule,
    // Off by default upstream, as an access key id alone is not a credential. It is still not public.
    options: rule.meta.id === '@secretlint/secretlint-rule-aws' ? { enableIDScanRule: true } : {},
  }));

/** `@secretlint/secretlint-rule-github` → `github`, so an `allowLeaks` rule reads `secretlint/github`. */
const ruleName = (id: string): string => id.replace(/^@secretlint\/secretlint-rule-/, '');

/** Scan the final tree with secretlint's recommended rules. Ignore files and disable comments in the tree are not read. */
export const secretlint = ({ rules = [] }: SecretlintOptions = {}): Plugin => {
  const config = { rules: [...PRESET, { id: googleApiKey.meta.id, rule: googleApiKey }, ...rules] };
  return {
    name: 'secretlint',
    scan: async ({ files }) => {
      const scanned = await Promise.all(
        files.map(async ({ path, content }): Promise<Finding[]> => {
          const { messages } = await lintSource({
            source: { filePath: path, content, contentType: 'text' },
            options: { config },
          });
          return messages.map(message => ({
            path,
            line: message.loc.start.line,
            rule: ruleName(message.ruleId),
            excerpt: content.slice(message.range[0], message.range[1]),
          }));
        }),
      );
      return scanned.flat();
    },
  };
};
