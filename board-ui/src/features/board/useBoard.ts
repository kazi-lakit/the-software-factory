import { useQuery } from "@tanstack/react-query";
import { boardStore } from "../../lib/board";

export const BOARD_KEY = ["board", "tasks"] as const;

/** Every task on the Board, refreshed every 30 seconds. */
export function useBoard() {
  return useQuery({
    queryFn: () => boardStore.listTasks(),
    queryKey: BOARD_KEY,
    refetchInterval: 30_000
  });
}
