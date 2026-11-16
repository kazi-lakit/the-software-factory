import type { FactoryDef, GitHubLink, Task } from "@factory/core";

/** A link that failed this many times in a row is "keeps failing"; the first failures are normal retries. */
export const STUCK_ATTEMPTS = 3;

export interface CardGitHub { issue: { label: string; url: string; name: string } | null; waiting: boolean; error: string | null }

export const issueUrl = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`;

const CLOSED = new Set(["done", "cancelled"]);

/** What a card shows about GitHub; null for factories that are not connected and when there is nothing to show. */
export function cardGitHub(task: Task, link: GitHubLink | undefined, def: FactoryDef | undefined): CardGitHub | null {
  if (def?.github?.mode !== "connected") return null;
  const n = link?.issueNumber ?? null;
  const issue = link && n !== null ? { label: `#${n}`, name: `${link.repo}#${n}`, url: issueUrl(link.repo, n) } : null;
  const waiting = issue === null && !CLOSED.has(task.status);
  const error = link?.error && link.error.attempts >= STUCK_ATTEMPTS ? link.error.message : null;
  return issue || waiting || error ? { issue, waiting, error } : null;
}
