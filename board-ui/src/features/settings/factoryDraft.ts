import { useState } from "react";
import { AGENT_STEPS, ensureMain, saveFactory, validateFactoryDef, VersionConflictError, type AgentModel, type AgentStep, type FactoryDef } from "@factory/core";
import { boardStore } from "../../lib/board";
import { describeWriteError, now, type WriteProblem } from "../task/writeOutcome";

export const DEFINITION_CONFLICT = "This definition changed elsewhere. Reload to see the latest.";

/** A failed definition save: a conflict gets the definition wording, the rest are shared with other writes. */
export function describeDefinitionError(error: unknown, existsText?: string): WriteProblem {
  // Adding: a version conflict can only mean the id is taken, not that the owner's copy is stale.
  if (error instanceof VersionConflictError && existsText) return { kind: "message", message: existsText };
  if (error instanceof VersionConflictError) return { kind: "conflict", message: DEFINITION_CONFLICT };
  return describeWriteError(error);
}

export type Draft = {
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

export const modelsOf = (def: FactoryDef | null): Draft["models"] =>
  Object.fromEntries(AGENT_STEPS.map((s) => [s, def?.agentModels?.[s] ?? ""])) as Draft["models"];

export const draftOf = (def: FactoryDef | null): Draft =>
  def
    ? {
        active: def.active, docsPath: def.docsPath, factoryId: def.factoryId, gitEmail: def.gitEmail, ghUser: def.ghUser, gitName: def.gitName,
        models: modelsOf(def), name: def.name, protectedBranches: def.protectedBranches,
      }
    : { active: true, docsPath: "", factoryId: "", gitEmail: "", ghUser: "", gitName: "", models: modelsOf(null), name: "", protectedBranches: ensureMain(["dev", "stg"]) };

/** The input validateFactoryDef checks: Same as session ("") leaves the stage out; the core drops an empty map. */
export function toFactoryInput(draft: Draft, base: FactoryDef | null) {
  const { models, ...rest } = draft;
  const agentModels = Object.fromEntries(AGENT_STEPS.flatMap((s) => (models[s] ? [[s, models[s]]] : [])));
  return { ...rest, agentModels, version: base?.version ?? 1 };
}

/** Adds a protected branch: `main` stays last, so a new branch lands before it; blanks and repeats add nothing. */
export function addProtectedBranch(list: string[], name: string): string[] {
  return name.trim() === "" ? list : ensureMain([...list.filter((b) => b !== "main"), name]);
}

/** Validates and saves a factory draft; `base` null adds one, where a version conflict means the id is taken. */
export function useFactorySave({ base, onSaved }: { base: FactoryDef | null; onSaved: (saved: FactoryDef) => void | Promise<unknown> }) {
  const [problem, setProblem] = useState<WriteProblem>();
  const [invalidText, setInvalidText] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(draft: Draft) {
    if (busy) return;
    setProblem(undefined);
    const checked = validateFactoryDef(toFactoryInput(draft, base));
    if (!checked.ok) {
      setInvalidText(checked.error);
      return;
    }
    setInvalidText("");
    setBusy(true);
    let saved: FactoryDef;
    try {
      saved = await saveFactory(boardStore, now, base, checked.value);
    } catch (error) {
      setProblem(describeDefinitionError(error, base === null ? `Factory ${draft.factoryId} already exists. Pick another id.` : undefined));
      setBusy(false);
      return;
    }
    // Busy stays set: the definition is stored, and onSaved moves on (closes the form or leaves the page), maybe
    // only after a refetch. Saving the same draft again would only fail.
    void onSaved(saved);
  }

  return { busy, clearProblem: () => setProblem(undefined), invalidText, problem, save };
}
