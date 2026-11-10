import fs from 'node:fs';
import path from 'node:path';
import { readHookInput, factoryRoot, readSession, replyTarget } from './lib.mjs';

try {
  const input = await readHookInput();
  const root = factoryRoot(process.env);
  const target = replyTarget(input, { root, session: readSession(root, input.session_id) });
  if (target && typeof input.last_assistant_message === 'string') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.last_assistant_message);
  }
} catch (e) {
  process.stderr.write(`factory subagent-stop error: ${e?.message ?? e}\n`);
}
