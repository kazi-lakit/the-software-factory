import fs from 'node:fs';
import path from 'node:path';

export async function readHookInput() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

export function factoryRoot(env) {
  const root = env.CLAUDE_PROJECT_DIR || env.FACTORY_ROOT;
  if (!root) throw new Error('neither CLAUDE_PROJECT_DIR nor FACTORY_ROOT is set');
  return root;
}

export function sessionFile(root, sessionId) {
  return path.join(root, 'runs', '.sessions', `${sessionId}.json`);
}

// Session file shape: {taskId, step, worktree, mode, store, session}. Null when missing or unreadable.
export function readSession(root, sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

export function isFactoryAgent(input) {
  return typeof input?.agent_type === 'string' && input.agent_type.startsWith('factory:');
}
