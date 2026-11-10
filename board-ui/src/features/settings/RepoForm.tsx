import { useId, useState } from "react";
import type { FormEvent } from "react";
import { canonicalJson, saveRepo, validateFactoryRepo, type FactoryDef, type FactoryRepo } from "@factory/core";
import { boardStore } from "../../lib/board";
import { now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { describeDefinitionError } from "./FactoryForm";

type Draft = { baseBranch: string; checks: string; remote: string; repoId: string };

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
};
/** Keys sorted, indented: the same text for the same checks, whatever the key order. */
const pretty = (value: unknown): string => JSON.stringify(sorted(value), null, 2);

const draftOf = (repo: FactoryRepo | null): Draft =>
  repo ? { baseBranch: repo.baseBranch, checks: pretty(repo.checks), remote: repo.remote, repoId: repo.repoId } : { baseBranch: "dev", checks: "", remote: "", repoId: "" };

type Props = {
  /** The factory the repo belongs to. */
  def: FactoryDef;
  /** The stored repo being edited; null adds one. */
  before: FactoryRepo | null;
  onCancel: () => void;
  /** After a conflict's Reload: refetches and returns the latest stored repo (undefined if it is gone). */
  onReload: () => Promise<FactoryRepo | undefined>;
  onSaved: (saved: FactoryRepo) => void;
};

/** Add or edit a repo. The id is fixed once created. A change to the checks is shown old beside new and needs Confirm change. */
export function RepoForm({ before, def, onCancel, onReload, onSaved }: Props) {
  const ids = useId();
  const [base, setBase] = useState(before);
  const [draft, setDraft] = useState(() => draftOf(before));
  const [problem, setProblem] = useState<WriteProblem>();
  const [invalidText, setInvalidText] = useState("");
  const [review, setReview] = useState<FactoryRepo>();
  const [busy, setBusy] = useState(false);
  const set = (key: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setReview(undefined);
  };

  /** Checks the draft; a checks change on an existing repo stops at the review until it is confirmed. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    let checks: unknown;
    try {
      checks = draft.checks.trim() === "" ? undefined : JSON.parse(draft.checks);
    } catch {
      setInvalidText("checks must be valid JSON");
      return;
    }
    const checked = validateFactoryRepo({ baseBranch: draft.baseBranch, checks, factoryId: def.factoryId, remote: draft.remote, repoId: draft.repoId, version: base?.version ?? 1 }, def);
    if (!checked.ok) {
      setInvalidText(checked.error);
      return;
    }
    setInvalidText("");
    if (base && canonicalJson(base.checks) !== canonicalJson(checked.value.checks)) {
      setReview(checked.value);
      return;
    }
    void write(checked.value);
  }

  async function write(after: FactoryRepo) {
    setBusy(true);
    try {
      onSaved(await saveRepo(boardStore, now, base, after));
    } catch (error) {
      setProblem(describeDefinitionError(error));
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setProblem(undefined);
    setReview(undefined);
    const latest = await onReload();
    if (!latest) {
      onCancel();
      return;
    }
    setBase(latest);
    setDraft(draftOf(latest));
  }

  return (
    <form className="sf-panel sf-form" aria-label={before ? `Edit repo ${before.repoId}` : `Add repo to ${def.factoryId}`} noValidate onSubmit={submit}>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-id`}>Repo id</label>
        <input id={`${ids}-id`} className="sf-input sf-mono" value={draft.repoId} readOnly={before !== null} onChange={(event) => set("repoId", event.target.value)} aria-describedby={`${ids}-id-hint`} />
        <span id={`${ids}-id-hint`} className="sf-hint">{before ? "The id cannot change." : "Unique within this factory. It cannot change later."}</span>
      </div>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-remote`}>Remote</label>
        <input id={`${ids}-remote`} className="sf-input sf-mono" value={draft.remote} onChange={(event) => set("remote", event.target.value)} />
      </div>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-base`}>Base branch</label>
        <input id={`${ids}-base`} className="sf-input sf-mono" value={draft.baseBranch} onChange={(event) => set("baseBranch", event.target.value)} />
        <span className="sf-hint">The factory never uses main as a base.</span>
      </div>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-checks`}>Checks (JSON)</label>
        <textarea id={`${ids}-checks`} className="sf-input sf-mono" rows={12} value={draft.checks} onChange={(event) => set("checks", event.target.value)} />
      </div>
      {invalidText ? <p className="sf-problem" role="alert">{invalidText}</p> : null}
      {review && base ? (
        <section className="sf-panel sf-checks-review" aria-label="Checks change">
          <p>These checks run for every task in this repo. Review the change.</p>
          <div className="sf-checks-diff">
            <div><h4>Old checks</h4><pre className="sf-mono" aria-label="Old checks">{pretty(base.checks)}</pre></div>
            <div><h4>New checks</h4><pre className="sf-mono" aria-label="New checks">{pretty(review.checks)}</pre></div>
          </div>
          <div className="sf-actions">
            <button type="button" className="sf-button sf-button-primary" disabled={busy} onClick={() => void write(review)}>Confirm change</button>
            <button type="button" className="sf-button" onClick={() => setReview(undefined)}>Keep editing</button>
          </div>
        </section>
      ) : null}
      <WriteProblemNotice problem={problem} onReload={() => void reload()} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>{before ? "Save repo" : "Add repo"}</button>
        <button type="button" className="sf-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
