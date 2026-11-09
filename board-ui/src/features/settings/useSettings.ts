import { useQuery } from "@tanstack/react-query";
import { boardStore } from "../../lib/board";

// The factory's stored settings: the global scope and the per-repo overrides.
// The shell reads `global.paused` for its indicator; the Settings view builds on this.
export function useSettings() {
  return useQuery({
    queryFn: () => boardStore.getSettings(),
    queryKey: ["settings"]
  });
}
