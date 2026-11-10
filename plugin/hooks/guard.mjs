import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput, factoryRoot, readSession, isFactoryAgent } from './lib.mjs';

const BASH_DENY = [
  [/\bsecurity\b/, 'security command'],
  [/(^|[\s;&|(])gh\s/, 'gh CLI'],
  [/git\s+push/, 'git push'],
  [/git\s+remote\s+(add|set-url|remove|rename)/, 'git remote change'],
  [/git\s+config\s+(?!--get)/, 'git config change'],
  [/(^|[\s;&|(])ssh\s/, 'ssh'],
  [/\.ssh\b/, '.ssh access'],
  [/GH_TOKEN|GITHUB_TOKEN/, 'token variable'],
  [/api\.github\.com/, 'GitHub API'],
  [/scratchpad\/selise\/(blocks|vaultS)/, 'checkouts and vault are off limits'],
];
const BASH_DENY_AGENT = [
  [/git\s+(switch|rebase|merge|branch|checkout\s+-b)/, 'branch-changing git command'],
  [/(^|[\s;&|(])factory\s/, 'factory CLI'],
  [/core\/dist\/cli\.js/, 'factory CLI'],
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const deny = (rule) => ({ deny: true, reason: `factory guard: ${rule}` });
const inside = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function decide(input, ctx) {
  const { root, home, session } = ctx;
  const tool = input.tool_name;
  const agent = isFactoryAgent(input);
  const ti = input.tool_input ?? {};

  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '');
    for (const [re, rule] of BASH_DENY) if (re.test(cmd)) return deny(`Bash denied (${rule})`);
    if (agent) for (const [re, rule] of BASH_DENY_AGENT) if (re.test(cmd)) return deny(`Bash denied for factory agents (${rule})`);
    return { deny: false };
  }

  if (WRITE_TOOLS.has(tool)) {
    const raw = ti.file_path ?? ti.notebook_path;
    if (typeof raw !== 'string' || !raw) return deny(`${tool} without a file path`);
    const base = agent ? session?.worktree ?? root : root;
    const target = path.resolve(base, raw);
    for (const d of ['blocks', 'vaultS']) {
      if (inside(path.join(home, 'scratchpad', 'selise', d), target)) return deny(`writes under ${d} are off limits`);
    }
    if (agent) {
      if (!session?.worktree) return deny('no active factory step');
      if (!inside(path.resolve(session.worktree), target)) return deny('factory agents may write only inside the step worktree');
      return { deny: false };
    }
    if (inside(path.join(root, 'runs'), target) || inside(path.join(root, '.clones', 'worktrees'), target)) return { deny: false };
    return deny('the main session may write only under runs/ and .clones/worktrees/');
  }

  return { deny: false };
}

async function main() {
  try {
    const input = await readHookInput();
    const root = factoryRoot(process.env);
    const result = decide(input, { root, home: os.homedir(), session: readSession(root, input.session_id) });
    if (result.deny) emitDeny(result.reason);
  } catch (e) {
    emitDeny(`factory guard error: ${e?.message ?? e}`);
  }
}

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
