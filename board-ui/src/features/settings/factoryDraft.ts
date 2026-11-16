import { useState } from "react";
import { AGENT_STEPS, DEFAULT_LABEL, DEFAULT_STATUS_MAP, ensureMain, saveFactory, validateFactoryDef, VersionConflictError, type AgentModel, type AgentStep, type FactoryDef, type GitHubSettings, type Status } from "@factory/core";
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

/** The GitHub section as typed: the project is `owner/number` text and approvers a comma/space list. */
export type GitHubDraft = { mode: "off" | "connected" | "github-only"; project: string; label: string; approvers: string; statusMap: Record<Status, string> };

export const githubDraftOf = (g: GitHubSettings | undefined): GitHubDraft =>
  g
    ? { mode: g.mode, project: `${g.project.owner}/${g.project.number}`, label: g.label, approvers: g.approvers.join(", "), statusMap: { ...g.statusMap } }
    : { mode: "off", project: "", label: DEFAULT_LABEL, approvers: "", statusMap: { ...DEFAULT_STATUS_MAP } };

export type Draft = {
  active: boolean;
  docsPath: string;
  factoryId: string;
  gitEmail: string;
  gitName: string;
  github: GitHubDraft;
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
        github: githubDraftOf(def.github), models: modelsOf(def), name: def.name, protectedBranches: def.protectedBranches,
      }
    : { active: true, docsPath: "", factoryId: "", gitEmail: "", ghUser: "", gitName: "", github: githubDraftOf(undefined), models: modelsOf(null), name: "", protectedBranches: ensureMain(["dev", "stg"]) };

/** The input validateFactoryDef checks: Same as session ("") leaves the stage out; the core drops an empty map. */
export function toFactoryInput(draft: Draft, base: FactoryDef | null) {
  const { github, models, ...rest } = draft;
  const agentModels = Object.fromEntries(AGENT_STEPS.flatMap((s) => (models[s] ? [[s, models[s]]] : [])));
  const approvers = github.approvers.split(/[\s,]+/).filter((a) => a !== "");
  const input = github.mode === "off" ? undefined
    : { mode: github.mode, project: github.project.trim(), label: github.label, statusMap: github.statusMap, ...(approvers.length > 0 ? { approvers } : {}) };
  return { ...rest, agentModels, github: input, version: base?.version ?? 1 };
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
