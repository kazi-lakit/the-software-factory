import path from 'node:path';
import { isFactoryAgent } from './lib.mjs';

// git, then any global options (-C dir, -c k=v, --flag[=v]), then whitespace before the subcommand
const G = 'git(?:\\s+(?:-C|-c)\\s+\\S+|\\s+--?[\\w-]+(?:=\\S+)?)*\\s+';
const BASH_DENY = [
  [/\bsecurity\s+(?:find-|add-|delete-|dump-|export|import|unlock-|set-|create-|default-|list-keychains|login-keychain|show-keychain)/, 'Keychain access'],
  [/(^|[\s;&|(])gh\s/, 'gh CLI'],
  [new RegExp(`${G}push`), 'git push'],
  [new RegExp(`${G}remote\\s+(add|set-url|remove|rename)`), 'git remote change'],
  [new RegExp(`${G}config\\s+(?!--get)`), 'git config change'],
  [/(^|[\s;&|(])ssh\s/, 'ssh'],
  [/\.ssh\b/, '.ssh access'],
  [/GH_TOKEN|GITHUB_TOKEN/, 'token variable'],
  [/api\.github\.com/, 'GitHub API'],
  [/scratchpad\/selise\/(blocks|vaults)/i, 'checkouts and vault are off limits'],
];
const BASH_DENY_AGENT = [
  [new RegExp(`${G}(switch|rebase|merge|branch|checkout\\s+-b)`), 'branch-changing git command'],
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
  const tool = input?.tool_name;
  if (typeof tool !== 'string' || !tool) return deny('no tool name');
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
    if (!path.isAbsolute(raw)) return deny(`${tool} needs an absolute path`);
    const target = path.resolve(raw);
    // macOS volumes are case-insensitive, so compare protected roots case-insensitively there
    const fold = ctx.platform === 'darwin' ? (p) => p.toLowerCase() : (p) => p;
    for (const d of ['blocks', 'vaultS']) {
      if (inside(fold(path.join(home, 'scratchpad', 'selise', d)), fold(target))) return deny(`writes under ${d} are off limits`);
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
