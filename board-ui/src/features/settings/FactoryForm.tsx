import { useId, useState } from "react";
import { AGENT_MODELS, AGENT_STEPS, DEFAULT_GH_USER, type AgentModel, type AgentStep, type FactoryDef } from "@factory/core";
import { WriteProblemNotice } from "../task/writeOutcome";
import { addProtectedBranch, draftOf, useFactorySave, type Draft } from "./factoryDraft";

export { DEFINITION_CONFLICT, describeDefinitionError } from "./factoryDraft";

const MODEL_LABEL: Record<AgentModel, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const STAGE_LABEL: Record<AgentStep, string> = { spec: "Spec", plan: "Plan", build: "Build", verify: "Verify", review: "Review" };

type Props = {
  /** The stored definition being edited. New factories are made on the New factory page. */
  before: FactoryDef;
  onCancel: () => void;
  /** After a conflict's Reload: refetches and returns the latest stored definition (undefined if it is gone). */
  onReload: () => Promise<FactoryDef | undefined>;
  onSaved: (saved: FactoryDef) => void;
};

/** Edit a factory. The id is fixed; `main` is always protected and cannot be removed. */
export function FactoryForm({ before, onCancel, onReload, onSaved }: Props) {
  const ids = useId();
  const [base, setBase] = useState<FactoryDef>(before);
  const [draft, setDraft] = useState(() => draftOf(before));
  const [branch, setBranch] = useState("");
  const saving = useFactorySave({ base, onSaved });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function addBranch() {
    set("protectedBranches", addProtectedBranch(draft.protectedBranches, branch));
    setBranch("");
  }

  async function reload() {
    saving.clearProblem();
    const latest = await onReload();
    if (!latest) {
      onCancel();
      return;
    }
    setBase(latest);
    setDraft(draftOf(latest));
  }

  const text = (key: "docsPath" | "ghUser" | "gitEmail" | "gitName" | "name", label: string, hint?: string) => (
    <div className="sf-field">
      <label className="sf-field-label" htmlFor={`${ids}-${key}`}>{label}</label>
      <input id={`${ids}-${key}`} className="sf-input" value={draft[key]} onChange={(event) => set(key, event.target.value)} aria-describedby={hint ? `${ids}-${key}-hint` : undefined} />
      {hint ? <span id={`${ids}-${key}-hint`} className="sf-hint">{hint}</span> : null}
    </div>
  );

  return (
    <form className="sf-panel sf-form" aria-label={`Edit factory ${before.factoryId}`} noValidate onSubmit={(event) => { event.preventDefault(); void saving.save(draft); }}>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-id`}>Factory id</label>
        <input
          id={`${ids}-id`}
          className="sf-input sf-mono"
          value={draft.factoryId}
          readOnly
          aria-describedby={`${ids}-id-hint`}
        />
        <span id={`${ids}-id-hint`} className="sf-hint">The id cannot change.</span>
      </div>
      {text("name", "Name")}
      <label className="sf-switch">
        <input type="checkbox" role="switch" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
        <span>Active</span>
      </label>
      <fieldset className="sf-fieldset">
        <legend>Protected branches</legend>
        <ul className="sf-chips" aria-label="Protected branches">
          {draft.protectedBranches.map((name) => (
            <li key={name} className="sf-chip sf-mono">
              <span>{name}</span>
              {name === "main" ? (
                <span className="sf-hint">always on</span>
              ) : (
                <button type="button" className="sf-chip-remove" aria-label={`Remove ${name}`} onClick={() => set("protectedBranches", draft.protectedBranches.filter((b) => b !== name))}>×</button>
              )}
            </li>
          ))}
        </ul>
        <div className="sf-actions">
          <input
            className="sf-input sf-mono"
            aria-label="Branch to protect"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addBranch();
              }
            }}
          />
          <button type="button" className="sf-button" onClick={addBranch}>Add branch</button>
        </div>
        <span className="sf-hint">The factory never pushes to a protected branch.</span>
      </fieldset>
      {text("gitName", "Git name")}
      {text("gitEmail", "Git email")}
      {text("docsPath", "Docs path")}
      {text("ghUser", "GitHub login", `The gh CLI account the factory opens PRs with (gh auth login on this Mac). Empty uses ${DEFAULT_GH_USER}.`)}
      <fieldset className="sf-fieldset">
        <legend>Agent models</legend>
        {AGENT_STEPS.map((s) => (
          <div key={s} className="sf-field">
            <label className="sf-field-label" htmlFor={`${ids}-model-${s}`}>{STAGE_LABEL[s]} model</label>
            <select
              id={`${ids}-model-${s}`}
              className="sf-select"
              value={draft.models[s]}
              onChange={(event) => set("models", { ...draft.models, [s]: event.target.value as AgentModel | "" })}
            >
              <option value="">Same as session</option>
              {AGENT_MODELS.map((m) => (
                <option key={m} value={m}>{MODEL_LABEL[m]}</option>
              ))}
            </select>
          </div>
        ))}
        <span className="sf-hint">Same as session runs the stage on the model of the session that runs /factory:run.</span>
      </fieldset>
      {saving.invalidText ? <p className="sf-problem" role="alert">{saving.invalidText}</p> : null}
      <WriteProblemNotice problem={saving.problem} onReload={() => void reload()} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={saving.busy}>Save factory</button>
        <button type="button" className="sf-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
