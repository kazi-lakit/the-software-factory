import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { decideGate, GATE_DOC, type Approval, type Doc, type Gate, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useUnsent } from "../../lib/unsent";
import { DocVersions } from "./DocVersions";
import { currentOf } from "./useTask";
import { describeWriteError, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "./writeOutcome";

const GATE_LABEL: Record<Gate, string> = { plan: "plan", pr: "PR", spec: "spec" };
const KIND_TITLE = { plan: "Plan", review: "Review report", spec: "Spec", verify: "Verify report" } as const;

type Props = {
  approvals: readonly Approval[];
  /** Every version of the gate's doc (GATE_DOC[gate]), ascending. */
  docs: readonly Doc[];
  gate: Gate;
  onReload: () => unknown;
  task: Task;
};

/**
 * Approve / Request changes at a gate. The decision is on the version this panel shows (`seenDocVersion`), fixed
 * when the panel opens: a newer version is a StaleDocError, never a silent switch. One approval id per decision
 * attempt, kept until it is recorded, so a retry of the same click cannot record twice.
 */
export function GatePanel({ approvals, docs, gate, onReload, task }: Props) {
  const kind = GATE_DOC[gate];
  const headingId = useId();
  const commentId = useId();
  const [comment, setComment, clearComment] = useUnsent(`gate:${task.taskId}:${gate}`);
  const [seen, setSeen] = useState<number | undefined>(() => currentOf(docs)?.version);
  const [problem, setProblem] = useState<WriteProblem>();
  const [staleDocs, setStaleDocs] = useState<Doc[]>();
  const [recorded, setRecorded] = useState<Approval>();
  const [busy, setBusy] = useState(false);
  const approvalId = useRef(globalThis.crypto.randomUUID());
  const invalidate = useInvalidateAfterWrite();

  // The docs arrive after the panel when the task loads without them.
  const latest = currentOf(docs)?.version;
  useEffect(() => {
    if (seen === undefined && latest !== undefined) setSeen(latest);
  }, [latest, seen]);

  const decided = recorded ?? [...approvals].reverse().find((a) => a.gate === gate && a.docVersion === seen);

  async function decide(decision: "approve" | "changes") {
    if (busy || seen === undefined) return;
    if (decision === "changes" && comment.trim() === "") {
      setProblem({ kind: "message", message: "Say what should change before you request changes." });
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const approval = await decideGate(boardStore, now, task.taskId, gate, decision, seen, comment, approvalId.current);
      approvalId.current = globalThis.crypto.randomUUID();
      clearComment();
      setRecorded(approval);
      void invalidate(task.taskId);
    } catch (error) {
      const next = describeWriteError(error);
      setProblem(next);
      if (next.kind === "stale") {
        setStaleDocs(undefined);
        void invalidate(task.taskId);
        boardStore.listDocs(task.taskId, kind).then(setStaleDocs, () => setStaleDocs([]));
      }
    } finally {
      setBusy(false);
    }
  }

  function reviewNewVersion(version: number) {
    setSeen(version);
    setProblem(undefined);
    setStaleDocs(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void decide("approve");
  }

  return (
    <section className="sf-panel sf-panel-needs-you" aria-labelledby={headingId}>
      <h3 id={headingId}>Your decision: {GATE_LABEL[gate]}</h3>
      {seen === undefined ? (
        <p className="sf-empty">No {kind} to decide on yet.</p>
      ) : decided ? (
        <p role="status">
          {decided.decision === "approve" ? "Approval recorded" : "Changes requested"} for {kind}{" "}
          <span className="sf-mono">v{decided.docVersion}</span>. The factory applies it at its next sync.
        </p>
      ) : (
        <form onSubmit={submit} aria-labelledby={headingId}>
          <p>
            Deciding on {kind} <span className="sf-mono">v{seen}</span>
          </p>
          <label className="sf-field" htmlFor={commentId}>
            <span>Comment (needed to request changes)</span>
            <textarea id={commentId} className="sf-input" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          <WriteProblemNotice problem={problem} onReload={() => void onReload()} />
          {problem?.kind === "stale" ? (
            <div className="sf-stale">
              {staleDocs ? (
                <DocVersions
                  key={`${problem.seenVersion}-${problem.currentVersion}`}
                  label={KIND_TITLE[kind]}
                  docs={staleDocs}
                  from={problem.seenVersion}
                  to={problem.currentVersion}
                />
              ) : (
                <p className="sf-empty">Loading v{problem.currentVersion}…</p>
              )}
              <button type="button" className="sf-button" onClick={() => reviewNewVersion(problem.currentVersion)}>
                Decide on v{problem.currentVersion}
              </button>
            </div>
          ) : null}
          <div className="sf-actions">
            <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Approve</button>
            <button type="button" className="sf-button" disabled={busy} onClick={() => void decide("changes")}>Request changes</button>
          </div>
        </form>
      )}
    </section>
  );
}
