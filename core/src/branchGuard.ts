export const PROTECTED_BRANCHES = ['dev', 'stg', 'main'] as const;

/** True when the ref names a protected branch (`refs/heads/` and `origin/` prefixes are ignored). */
export function isProtected(ref: string): boolean {
  const name = ref.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return (PROTECTED_BRANCHES as readonly string[]).includes(name);
}
