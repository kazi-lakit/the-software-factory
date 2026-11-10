import fs from 'node:fs';
import path from 'node:path';

export async function readHookInput() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

const isFactoryRoot = (dir, exists) => ['repos', 'core', 'plugin'].every((d) => exists(path.join(dir, d)));

/**
 * Finds the factory root: FACTORY_ROOT if set (null when it is not a factory root), else
 * CLAUDE_PROJECT_DIR, else <home>/scratchpad/selise/the-software-factory. projectMode is true
 * when the root is the session's project dir, that is, the session started in the factory folder.
 */
export function resolveFactoryRoot(env, home, exists = fs.existsSync) {
  const project = env.CLAUDE_PROJECT_DIR ? path.resolve(env.CLAUDE_PROJECT_DIR) : null;
  const found = (dir) => ({ root: dir, projectMode: dir === project });
  if (env.FACTORY_ROOT) {
    const dir = path.resolve(env.FACTORY_ROOT);
    return isFactoryRoot(dir, exists) ? found(dir) : null;
  }
  for (const dir of [project, home && path.join(home, 'scratchpad', 'selise', 'the-software-factory')]) {
    if (dir && isFactoryRoot(dir, exists)) return found(dir);
  }
  return null;
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

// Same map as core/src/defaults.ts AGENT_FOR (a test keeps them equal).
export const AGENT_FOR = {
  spec: 'spec-writer',
  plan: 'planner',
  build: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
};

export function claimantFor(sessionId, host) {
  return `claude:${host}:${String(sessionId).slice(0, 8)}`;
}

// Where a factory agent's final reply goes; null unless the stop is the session step's own agent.
export function replyTarget(input, ctx) {
  const { root, session } = ctx;
  if (!session?.taskId || !session.step) return null;
  const agent = AGENT_FOR[session.step];
  if (!agent || input?.agent_type !== `factory:${agent}`) return null;
  return path.join(root, 'runs', session.taskId, `${session.step}.reply.md`);
}

export const RENEW_INTERVAL_MS = 60_000;

export function shouldRenew(lastRenewMs, nowMs) {
  return lastRenewMs == null || nowMs - lastRenewMs >= RENEW_INTERVAL_MS;
}

export function renewFile(root, sessionId) {
  return path.join(root, 'runs', '.sessions', `${sessionId}.renew`);
}

export function renewCommand({ root, session, sessionId, host, node = process.execPath, env = process.env }) {
  return {
    file: node,
    args: [path.join(root, 'core', 'dist', 'cli.js'), '--mode', session.mode, '--store', session.store, 'renew', session.taskId],
    env: { ...env, FACTORY_ROOT: root, FACTORY_CLAIMANT: claimantFor(sessionId, host) },
    log: path.join(root, 'runs', session.taskId, 'renew.log'),
  };
}
