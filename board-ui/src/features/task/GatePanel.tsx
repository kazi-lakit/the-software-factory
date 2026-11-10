import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { decideGate, GATE_DOC, isProtected, type Approval, type Doc, type Gate, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useFactories } from "../factories/useFactories";
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
  // The factory never merges into its factory's protected branches: the owner merges on GitHub, so there is nothing
  // to approve. While that list is unknown (not loaded, or the factory is gone), the safe side is the same.
  const protectedBranches = useFactories().byId.get(task.factoryId)?.def.protectedBranches;
  const mergeOnGitHub = gate === "pr" && (protectedBranches === undefined || isProtected(task.baseBranch, protectedBranches));
  const headingId = useId();
  const commentId = useId();
  const [comment, setComment, clearComment] = useUnsent(`gate:${task.taskId}:${gate}`);
  const [seen, setSeen] = useState<number | undefined>(() => currentOf(docs)?.version);
  const [problem, setProblem] = useState<WriteProblem>();
  // The doc's versions for the stale diff: undefined while loading, "failed" when the load failed.
  const [staleDocs, setStaleDocs] = useState<Doc[] | "failed">();
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

  // A decision is recorded and a newer version arrived: a new round (the view may have missed the task
  // leaving and re-entering the gate). An undecided panel keeps its version; deciding then is a StaleDocError.
  const isDecided = decided !== undefined;
  useEffect(() => {
    if (!isDecided || seen === undefined || latest === undefined || latest <= seen) return;
    setSeen(latest);
    setRecorded(undefined);
    setProblem(undefined);
    setStaleDocs(undefined);
  }, [isDecided, latest, seen]);

  function loadStaleDocs() {
    setStaleDocs(undefined);
    boardStore.listDocs(task.taskId, kind).then(setStaleDocs, () => setStaleDocs("failed"));
  }

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
        void invalidate(task.taskId);
        loadStaleDocs();
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
    if (!mergeOnGitHub) void decide("approve");
  }

  return (
    <section className="sf-panel sf-panel-needs-you" aria-labelledby={headingId}>
      <h3 id={headingId}>Your decision: {GATE_LABEL[gate]}</h3>
      {mergeOnGitHub ? (
        <p>
          {protectedBranches === undefined ? (
            <>The Board has not read this factory&apos;s protected branches. Merge the PR on GitHub to finish this task.</>
          ) : (
            <>The factory never merges into <span className="sf-mono">{task.baseBranch}</span>. Merge the PR on GitHub to finish this task.</>
          )}
          {task.prUrl ? (
            <>
              {" "}
              <a href={task.prUrl} target="_blank" rel="noreferrer noopener">Open the PR on GitHub (opens in a new tab)</a>
            </>
          ) : null}
        </p>
      ) : null}
      {seen === undefined ? (
        <p className="sf-empty">No {kind} to decide on yet.</p>
      ) : decided && !mergeOnGitHub ? (
        <p role="status">
          {decided.decision === "approve" ? "Approval recorded" : "Changes requested"} for {kind}{" "}
          <span className="sf-mono">v{decided.docVersion}</span>. The factory applies it at its next sync.
        </p>
      ) : (
        <>
          {decided ? (
            <p role="status">
              {decided.decision === "approve" ? "Approval recorded" : "Changes requested"} for {kind}{" "}
              <span className="sf-mono">v{decided.docVersion}</span>. The factory applies a request for changes at its next sync.
            </p>
          ) : null}
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
              <StaleDiff
                docs={staleDocs}
                kind={kind}
                currentVersion={problem.currentVersion}
                seenVersion={problem.seenVersion}
                onRetry={loadStaleDocs}
                onReview={reviewNewVersion}
              />
            ) : null}
            <div className="sf-actions">
              {mergeOnGitHub ? null : <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Approve</button>}
              <button type="button" className="sf-button" disabled={busy} onClick={() => void decide("changes")}>Request changes</button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

/**
 * The diff from the version the owner saw to the newer one. "Decide on vN" appears only once that diff is on
 * screen, so the owner cannot move on to a version they have not been shown.
 */
function StaleDiff({ currentVersion, docs, kind, onRetry, onReview, seenVersion }: {
  currentVersion: number;
  docs: Doc[] | "failed" | undefined;
  kind: Doc["kind"];
  onRetry: () => void;
  onReview: (version: number) => void;
  seenVersion: number;
}) {
  if (docs === undefined) return <p className="sf-empty">Loading v{currentVersion}…</p>;
  // The newest version, if another arrived since the refusal.
  const target = Math.max(currentVersion, ...docs === "failed" ? [] : docs.map((d) => d.version));
  const ready = docs !== "failed" && docs.some((d) => d.version === seenVersion) && docs.some((d) => d.version === target);
  if (!ready) {
    return (
      <div className="sf-problem">
        <span>{docs === "failed" ? `Could not load the ${kind} versions.` : `v${currentVersion} is not available yet.`}</span>
        <button type="button" className="sf-button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return (
    <div className="sf-stale">
      <DocVersions key={`${seenVersion}-${target}`} label={KIND_TITLE[kind]} docs={docs} from={seenVersion} to={target} />
      <button type="button" className="sf-button" onClick={() => onReview(target)}>Decide on v{target}</button>
    </div>
  );
}
