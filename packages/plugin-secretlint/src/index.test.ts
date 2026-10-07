import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { secretlint } from './index.ts';

const scan = async (files: Record<string, string>) => {
  const { scan } = secretlint();
  if (scan === undefined) throw new Error('secretlint() has no scan hook');
  return scan({
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    source: { root: '/repo', sha: 'abc' },
  });
};

// Fake but well-formed: secretlint checks shape and entropy, so a run of one letter would not
// match. Built at runtime so this file holds no token for a scanner to find.
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const fake = (length: number, alphabet = ALPHANUMERIC): string =>
  Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');

const TOKENS = [
  { name: 'GitHub personal access token', rule: 'github', token: `ghp_${fake(36)}` },
  {
    name: 'GitHub fine-grained token',
    rule: 'github',
    token: `github_pat_${fake(22)}_${fake(59)}`,
  },
  {
    name: 'AWS access key id',
    rule: 'aws',
    token: `AKIA${fake(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`,
  },
  { name: 'npm token', rule: 'npm', token: `npm_${fake(36)}` },
  { name: 'Stripe live key', rule: 'stripe', token: `sk_live_${fake(24)}` },
  { name: 'Anthropic key', rule: 'anthropic', token: `sk-ant-api03-${fake(93)}AA` },
  { name: 'OpenAI key', rule: 'openai', token: `sk-proj-${fake(74)}T3BlbkFJ${fake(74)}` },
  { name: 'Google API key', rule: 'google-api-key', token: `AIza${fake(35)}` },
  { name: 'Google API key ending in -', rule: 'google-api-key', token: `AIza${fake(34)}-` },
];

describe('secretlint', () => {
  it.each(TOKENS)('finds a $name', async ({ rule, token }) => {
    expect(await scan({ 'src/config.ts': `export const key = '${token}';\n` })).toEqual([
      { path: 'src/config.ts', line: 1, rule, excerpt: token },
    ]);
  });

  it('finds a PEM private key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(await scan({ 'deploy/id_rsa': privateKey })).toMatchObject([
      { path: 'deploy/id_rsa', line: 1, rule: 'privatekey' },
    ]);
  });

  it('finds nothing in ordinary code', async () => {
    expect(
      await scan({
        'src/index.ts': "export const url = 'https://github.com/fishballapp/openrepo';\n",
        'keys/public.pem': '-----BEGIN PUBLIC KEY-----\n',
      }),
    ).toEqual([]);
  });

  it('still finds a secret under a secretlint-disable comment', async () => {
    const token = `ghp_${fake(36)}`;
    const content = `// secretlint-disable\nexport const key = '${token}';\n`;
    expect(await scan({ 'src/config.ts': content })).toMatchObject([{ line: 2, rule: 'github' }]);
  });
});
