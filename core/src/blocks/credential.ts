import { z } from 'zod';
import { readSecret, type ExecFile } from '../secrets.js';

const schema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  projectKey: z.string().min(1),
  apiUrl: z.string().min(1),
});

export type BlocksCredential = z.infer<typeof schema>;

/** Reads the factory's Blocks client credential from the Keychain. Errors never include the stored value. */
export async function loadBlocksCredential(exec?: ExecFile): Promise<BlocksCredential> {
  const raw = await readSecret('blocks-credential', exec);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error('blocks-credential in Keychain is not valid JSON {clientId, clientSecret, projectKey, apiUrl}');
  return result.data;
}
