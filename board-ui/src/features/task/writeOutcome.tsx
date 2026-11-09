import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  BlocksForbiddenError, BlocksUnauthorizedError, ForbiddenError, OwnerActionError, StaleDocError, VersionConflictError, type DocKind
} from "@factory/core";
import { BOARD_KEY } from "../board/useBoard";

/** Owner actions take a clock; the page uses real time. */
export const now = (): Date => new Date();

export const taskKey = (taskId: string) => ["task", taskId] as const;

/** What a failed write means for the page. Every kind keeps the typed text. */
export type WriteProblem =
  | { kind: "conflict"; message: string }
  | { kind: "stale"; docKind: DocKind; currentVersion: number; seenVersion: number; message: string }
  | { kind: "message"; message: string };

export const CONFLICT_MESSAGE = "This task changed while you were looking. Reload to see the latest.";
export const FORBIDDEN_MESSAGE = "Blocks refused this change for your account.";
const SESSION_MESSAGE = "Your session ended. Your text is kept: sign in again to send it.";

export function describeWriteError(error: unknown): WriteProblem {
  if (error instanceof VersionConflictError) return { kind: "conflict", message: CONFLICT_MESSAGE };
  if (error instanceof StaleDocError) {
    return {
      currentVersion: error.currentVersion,
      docKind: error.kind,
      kind: "stale",
      message: `The ${error.kind} changed since you opened it (now v${error.currentVersion}). Review the new version first.`,
      seenVersion: error.seenVersion
    };
  }
  if (error instanceof OwnerActionError) return { kind: "message", message: error.message };
  // A refused read surfaces as the data layer's own error.
  if (error instanceof ForbiddenError || error instanceof BlocksForbiddenError) {
    return { kind: "message", message: FORBIDDEN_MESSAGE };
  }
  // A 401 after a rejected renewal: the auth module has already ended the session and the guard sends the
  // owner to sign in; the unsent text stays in memory (lib/unsent.ts).
  if (error instanceof BlocksUnauthorizedError) return { kind: "message", message: SESSION_MESSAGE };
  const detail = error instanceof Error && error.message ? `: ${error.message}` : ".";
  return { kind: "message", message: `The change was not saved${detail}` };
}

/** Every successful write refreshes the Board and the task. */
export function useInvalidateAfterWrite() {
  const client = useQueryClient();
  return useCallback(async (taskId?: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: BOARD_KEY }),
      taskId ? client.invalidateQueries({ queryKey: taskKey(taskId) }) : client.invalidateQueries({ queryKey: ["task"] })
    ]);
  }, [client]);
}

/** A failed write's message, with Reload on a conflict. */
export function WriteProblemNotice({ onReload, problem }: { onReload?: () => void; problem: WriteProblem | undefined }) {
  if (!problem) return null;
  return (
    <div className="sf-problem" role="alert">
      <span>{problem.message}</span>
      {problem.kind === "conflict" && onReload ? (
        <button type="button" className="sf-button" onClick={onReload}>Reload</button>
      ) : null}
    </div>
  );
}
