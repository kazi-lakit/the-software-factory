// Pure branch rules (no Node API): the browser entry imports gates.ts, which needs isProtected.
export const PROTECTED_BRANCHES = ['dev', 'stg', 'main'] as const;

export class ProtectedBranchError extends Error {
  constructor(public readonly branch: string) {
    super(`push to ${branch} refused (protected branch)`);
    this.name = 'ProtectedBranchError';
  }
}

/**
 * True when the ref names a protected branch (`refs/heads/`, `refs/remotes/origin/`, `remotes/origin/` and `origin/` prefixes
 * are ignored). `main` always counts, whatever the list says.
 */
export function isProtected(ref: string, protectedBranches: readonly string[] = PROTECTED_BRANCHES): boolean {
  const name = ref.replace(/^refs\/heads\//, '').replace(/^(?:refs\/)?remotes\/origin\//, '').replace(/^origin\//, '');
  return name === 'main' || protectedBranches.includes(name);
}

export function assertPushAllowed(branch: string, protectedBranches: readonly string[] = PROTECTED_BRANCHES): void {
  if (isProtected(branch, protectedBranches)) throw new ProtectedBranchError(branch);
}

/** Task branch name: `factory/<taskId>-<slug>`, slug lowercase a-z0-9- and at most 40 chars. */
export function branchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `factory/${taskId}-${slug}`;
}
