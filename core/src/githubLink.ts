import type { Status } from './types.js';

// What was last pushed to GitHub for a task. Pure (no Node API), so the browser entry can import it.

/** The values the last successful push wrote to GitHub. */
export interface PushedState {
  status: Status | null; option: string | null; title: string | null; bodyHash: string | null; label: string | null;
  docs: { spec: number; plan: number }; blocked: string | null; closed: boolean;
}

/** One task's link to its GitHub issue and Project item, with the last pushed state. */
export interface GitHubLink {
  taskId: string; factoryId: string;
  /** "owner/repo" of the issue's repo. */
  repo: string;
  issueNumber: number | null; issueNodeId: string | null;
  /** "owner/number" of the Project the item is on. */
  project: string | null; itemId: string | null;
  pushed: PushedState;
  error: { message: string; attempts: number; nextAttemptAt: string } | null;
  lease: { by: string; until: string } | null;
  version: number;
}

export const emptyPushed = (): PushedState => ({
  status: null, option: null, title: null, bodyHash: null, label: null, docs: { spec: 0, plan: 0 }, blocked: null, closed: false,
});
