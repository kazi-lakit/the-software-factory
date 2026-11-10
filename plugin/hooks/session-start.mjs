import fs from 'node:fs';
import os from 'node:os';
import { readHookInput, factoryRoot, claimantFor } from './lib.mjs';

try {
  const input = await readHookInput();
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    process.stderr.write('factory session-start: CLAUDE_ENV_FILE is not set; skipping env export\n');
  } else {
    const lines = [
      `export FACTORY_CLAIMANT=${claimantFor(input.session_id, os.hostname())}`,
      'export HUSKY=0',
      `export FACTORY_ROOT=${factoryRoot(process.env)}`,
      'export FACTORY_STORE=${FACTORY_STORE:-blocks}',
    ];
    fs.appendFileSync(envFile, lines.join('\n') + '\n');
  }
} catch (e) {
  process.stderr.write(`factory session-start error: ${e?.message ?? e}\n`);
}
