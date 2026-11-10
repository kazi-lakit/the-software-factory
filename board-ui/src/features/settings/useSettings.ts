import { useQuery } from "@tanstack/react-query";
import { boardStore } from "../../lib/board";

export const SETTINGS_KEY = ["settings"] as const;

// The factory's stored settings: the global scope and the per-repo overrides.
// The shell reads `global.paused` for its indicator; the Settings view edits them.
export function useSettings() {
  return useQuery({
    queryFn: () => boardStore.getSettings(),
    queryKey: SETTINGS_KEY,
    // The shell's pause indicator follows the stored value, so a change from the CLI shows up without a reload.
    refetchInterval: 30_000
  });
}
