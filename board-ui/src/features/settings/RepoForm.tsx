import { useId, useState } from "react";
import type { FormEvent } from "react";
import { canonicalJson, saveRepo, validateFactoryRepo, type Check, type FactoryDef, type FactoryRepo } from "@factory/core";
import { boardStore } from "../../lib/board";
import { now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { describeDefinitionError } from "./FactoryForm";

/** One checks row as typed: `needs` is "" for none. */
type Row = { cwd: string; name: string; needs: string; run: string };
type Draft = { baseBranch: string; checks: Row[]; remote: string; repoId: string };

/** Core's canonical form (keys sorted) indented, so the same checks read the same whatever the key order. */
const pretty = (value: unknown): string => JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);

const rowOf = (c: Check): Row => ({ cwd: c.cwd, name: c.name, needs: c.needs ?? "", run: c.run });
const checkOf = (r: Row): Check => ({ name: r.name, cwd: r.cwd, run: r.run, ...(r.needs === "" ? {} : { needs: r.needs }) });

const draftOf = (repo: FactoryRepo | null): Draft =>
  repo ? { baseBranch: repo.baseBranch, checks: repo.checks.map(rowOf), remote: repo.remote, repoId: repo.repoId } : { baseBranch: "dev", checks: [], remote: "", repoId: "" };

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
  const set = (key: Exclude<keyof Draft, "checks">, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setReview(undefined);
  };
  const editChecks = (change: (rows: Row[]) => Row[]) => {
    setDraft((d) => ({ ...d, checks: change(d.checks) }));
    setReview(undefined);
  };
  const setRow = (i: number, key: keyof Row, value: string) => editChecks((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const move = (i: number, by: -1 | 1) => editChecks((rows) => {
    const next = rows.slice();
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    return next;
  });

  /** Checks the draft; a checks change on an existing repo stops at the review until it is confirmed. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    const checked = validateFactoryRepo({ baseBranch: draft.baseBranch, checks: draft.checks.map(checkOf), factoryId: def.factoryId, remote: draft.remote, repoId: draft.repoId, version: base?.version ?? 1 }, def);
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
      setProblem(describeDefinitionError(error, base === null ? `Repo ${draft.repoId} already exists in ${def.factoryId}. Pick another id.` : undefined));
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
      <fieldset className="sf-fieldset"><legend>Repository details</legend>
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
      </fieldset>
      <fieldset className="sf-fieldset"><legend>Checks</legend>
      {draft.checks.map((row, i) => {
        const n = i + 1;
        const earlier = draft.checks.slice(0, i).map((r) => r.name).filter((name) => name !== "");
        const options = row.needs !== "" && !earlier.includes(row.needs) ? [...earlier, row.needs] : earlier;
        return (
          <fieldset className="sf-fieldset" key={i}><legend>Check {n}</legend>
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-c${i}-name`}>Check {n} name</label>
              <input id={`${ids}-c${i}-name`} className="sf-input sf-mono" value={row.name} onChange={(event) => setRow(i, "name", event.target.value)} />
            </div>
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-c${i}-cwd`}>Check {n} folder</label>
              <input id={`${ids}-c${i}-cwd`} className="sf-input sf-mono" value={row.cwd} onChange={(event) => setRow(i, "cwd", event.target.value)} />
            </div>
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-c${i}-run`}>Check {n} command</label>
              <input id={`${ids}-c${i}-run`} className="sf-input sf-mono" value={row.run} onChange={(event) => setRow(i, "run", event.target.value)} />
            </div>
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-c${i}-needs`}>Check {n} needs</label>
              <select id={`${ids}-c${i}-needs`} className="sf-select sf-mono" value={row.needs} onChange={(event) => setRow(i, "needs", event.target.value)}>
                <option value="">None</option>
                {options.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <div className="sf-actions">
              <button type="button" className="sf-button" disabled={i === 0} onClick={() => move(i, -1)}>Move check {n} up</button>
              <button type="button" className="sf-button" disabled={i === draft.checks.length - 1} onClick={() => move(i, 1)}>Move check {n} down</button>
              <button type="button" className="sf-button" onClick={() => editChecks((rows) => rows.filter((_, j) => j !== i))}>Remove check {n}</button>
            </div>
          </fieldset>
        );
      })}
      <div className="sf-actions">
        <button type="button" className="sf-button" onClick={() => editChecks((rows) => [...rows, { cwd: ".", name: "", needs: "", run: "" }])}>Add check</button>
      </div>
      <span className="sf-hint">These commands run when the factory checks this repository.</span>
      {invalidText.startsWith("checks") ? <p className="sf-problem" role="alert">{invalidText}</p> : null}
      </fieldset>
      {invalidText && !invalidText.startsWith("checks") ? <p className="sf-problem" role="alert">{invalidText}</p> : null}
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
