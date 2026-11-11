import { useId, useState } from "react";
import type { FormEvent } from "react";
import {
  AGENT_MODELS, AGENT_STEPS, DEFAULT_GH_USER, ensureMain, saveFactory, validateFactoryDef, VersionConflictError, type AgentModel, type AgentStep, type FactoryDef,
} from "@factory/core";
import { boardStore } from "../../lib/board";
import { describeWriteError, now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";

export const DEFINITION_CONFLICT = "This definition changed elsewhere. Reload to see the latest.";

/** A failed definition save: a conflict gets the definition wording, the rest are shared with other writes. */
export function describeDefinitionError(error: unknown, existsText?: string): WriteProblem {
  // Adding: a version conflict can only mean the id is taken, not that the owner's copy is stale.
  if (error instanceof VersionConflictError && existsText) return { kind: "message", message: existsText };
  if (error instanceof VersionConflictError) return { kind: "conflict", message: DEFINITION_CONFLICT };
  return describeWriteError(error);
}

const MODEL_LABEL: Record<AgentModel, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const STAGE_LABEL: Record<AgentStep, string> = { spec: "Spec", plan: "Plan", build: "Build", verify: "Verify", review: "Review" };

type Draft = {
  active: boolean;
  docsPath: string;
  factoryId: string;
  gitEmail: string;
  gitName: string;
  /** The gh CLI login; left empty, the core's validation saves DEFAULT_GH_USER. */
  ghUser: string;
  /** The model per stage; "" is Same as session, left out of the saved agentModels. */
  models: Record<AgentStep, AgentModel | "">;
  name: string;
  protectedBranches: string[];
};

const modelsOf = (def: FactoryDef | null): Draft["models"] =>
  Object.fromEntries(AGENT_STEPS.map((s) => [s, def?.agentModels?.[s] ?? ""])) as Draft["models"];

const draftOf = (def: FactoryDef | null): Draft =>
  def
    ? {
        active: def.active, docsPath: def.docsPath, factoryId: def.factoryId, gitEmail: def.gitEmail, ghUser: def.ghUser, gitName: def.gitName,
        models: modelsOf(def), name: def.name, protectedBranches: def.protectedBranches,
      }
    : { active: true, docsPath: "", factoryId: "", gitEmail: "", ghUser: "", gitName: "", models: modelsOf(null), name: "", protectedBranches: ensureMain(["dev", "stg"]) };

type Props = {
  /** The stored definition being edited; null adds a factory. */
  before: FactoryDef | null;
  onCancel: () => void;
  /** After a conflict's Reload: refetches and returns the latest stored definition (undefined if it is gone). */
  onReload: () => Promise<FactoryDef | undefined>;
  onSaved: (saved: FactoryDef) => void;
};

/** Add or edit a factory. The id is fixed once created; `main` is always protected and cannot be removed. */
export function FactoryForm({ before, onCancel, onReload, onSaved }: Props) {
  const ids = useId();
  const [base, setBase] = useState(before);
  const [draft, setDraft] = useState(() => draftOf(before));
  const [branch, setBranch] = useState("");
  const [problem, setProblem] = useState<WriteProblem>();
  const [invalidText, setInvalidText] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function addBranch() {
    const name = branch.trim();
    // `main` stays last, so a new branch lands before it.
    if (name !== "") set("protectedBranches", ensureMain([...draft.protectedBranches.filter((b) => b !== "main"), name]));
    setBranch("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    const { models, ...rest } = draft;
    // Same as session ("") leaves the stage out; the core drops an empty map.
    const agentModels = Object.fromEntries(AGENT_STEPS.flatMap((s) => (models[s] ? [[s, models[s]]] : [])));
    const checked = validateFactoryDef({ ...rest, agentModels, version: base?.version ?? 1 });
    if (!checked.ok) {
      setInvalidText(checked.error);
      return;
    }
    setInvalidText("");
    setBusy(true);
    try {
      onSaved(await saveFactory(boardStore, now, base, checked.value));
    } catch (error) {
      setProblem(describeDefinitionError(error, base === null ? `Factory ${draft.factoryId} already exists. Pick another id.` : undefined));
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setProblem(undefined);
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
    <form className="sf-panel sf-form" aria-label={before ? `Edit factory ${before.factoryId}` : "Add factory"} noValidate onSubmit={(event) => void save(event)}>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-id`}>Factory id</label>
        <input
          id={`${ids}-id`}
          className="sf-input sf-mono"
          value={draft.factoryId}
          readOnly={before !== null}
          onChange={(event) => set("factoryId", event.target.value)}
          aria-describedby={`${ids}-id-hint`}
        />
        <span id={`${ids}-id-hint`} className="sf-hint">{before ? "The id cannot change." : "Lowercase letters, digits and hyphens, starting with a letter. It cannot change later."}</span>
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
      {invalidText ? <p className="sf-problem" role="alert">{invalidText}</p> : null}
      <WriteProblemNotice problem={problem} onReload={() => void reload()} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>{before ? "Save factory" : "Create factory"}</button>
        <button type="button" className="sf-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
