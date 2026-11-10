import { DEFAULT_SETTINGS, type RepoId, type RepoSettings, type Settings, type StoredSettings } from "@factory/core";

// plan 6 Task 7/8 replaces this: the Board picks a factory instead of assuming `blocks`.
export const BLOCKS_FACTORY = "blocks";

/** The `blocks` factory's settings and repo overrides (the defaults when nothing is stored). */
export function blocksSettings(stored: StoredSettings): { factory: Settings; repos: Record<string, RepoSettings> } {
  return stored.factories[BLOCKS_FACTORY] ?? { factory: DEFAULT_SETTINGS, repos: {} };
}

// plan 6 Task 8 replaces this: the Settings tabs list the selected factory's repos.
export const REPO_IDS: readonly RepoId[] = ["os", "iam", "monitor", "logic", "data", "localization", "release"];
