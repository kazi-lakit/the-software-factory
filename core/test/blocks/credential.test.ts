import { describe, expect, it } from 'vitest';
import { loadBlocksCredential } from '../../src/blocks/credential.js';
import type { ExecFile } from '../../src/secrets.js';

const cred = { clientId: 'cid', clientSecret: 'S3CR3T-it\'s', projectKey: 'tenant1', apiUrl: 'https://api.example.com' };
const execOf = (stdout: string, code = 0): ExecFile => async () => ({ code, stdout, stderr: '' });

describe('loadBlocksCredential', () => {
  it('returns the parsed credential', async () => {
    expect(await loadBlocksCredential(execOf(JSON.stringify(cred) + '\n'))).toEqual(cred);
  });
  it('reads through secret-tool on Linux', async () => {
    const files: string[] = [];
    const exec: ExecFile = async (file) => { files.push(file); return { code: 0, stdout: JSON.stringify(cred), stderr: '' }; };
    expect(await loadBlocksCredential(exec, 'linux')).toEqual(cred);
    expect(files).toEqual(['secret-tool']);
  });
  it('throws the fixed message on a bad shape without echoing the value', async () => {
    const msg = 'blocks-credential is not valid JSON {clientId, clientSecret, projectKey, apiUrl}';
    for (const bad of ['{"clientId":"x","clientSecret":"LEAKME"}', 'not json LEAKME']) {
      const err = await loadBlocksCredential(execOf(bad)).catch((e: Error) => e);
      expect((err as Error).message).toBe(msg);
      expect((err as Error).message).not.toContain('LEAKME');
    }
  });
});

