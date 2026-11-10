import fs from 'node:fs';
import os from 'node:os';
import { readHookInput, resolveFactoryRoot, readSession, sessionFile, isFactoryAgent } from './lib.mjs';
import { decide } from './decide.mjs';

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
}

// The guard enforces only during factory work: for factory agents, in a session started in the
// factory folder (project mode), and while this session's /factory:run step file exists.
// Anything else, such as normal work with a user-scoped install, is allowed without output.
// While enforcing, an error denies (fail closed).
let enforcing = false;

async function main() {
  const home = os.homedir();
  const found = resolveFactoryRoot(process.env, home);
  enforcing = Boolean(found?.projectMode);
  const input = await readHookInput();
  if (isFactoryAgent(input)) {
    enforcing = true;
    if (!found) return emitDeny('factory guard: factory root not found');
  }
  const stepRunning = Boolean(found && input?.session_id && fs.existsSync(sessionFile(found.root, input.session_id)));
  enforcing ||= stepRunning;
  const session = found ? readSession(found.root, input?.session_id) : null;
  const result = decide(input, { root: found?.root, home, platform: process.platform, session, active: enforcing });
  if (result.deny) emitDeny(result.reason);
}

try {
  await main();
} catch (e) {
  if (enforcing) emitDeny(`factory guard error: ${e?.message ?? e}`);
}
