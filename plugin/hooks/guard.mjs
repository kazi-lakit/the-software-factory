import os from 'node:os';
import { readHookInput, factoryRoot, readSession } from './lib.mjs';
import { decide } from './decide.mjs';

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
}

try {
  const input = await readHookInput();
  const root = factoryRoot(process.env);
  const result = decide(input, { root, home: os.homedir(), platform: process.platform, session: readSession(root, input.session_id) });
  if (result.deny) emitDeny(result.reason);
} catch (e) {
  emitDeny(`factory guard error: ${e?.message ?? e}`);
}
