import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  DEFAULT_SETTINGS, resetRemovedRepoSettings, saveSettings, SETTING_RANGES, VersionConflictError,
  type FactoryRepo, type Gate, type RepoSettings, type RepoSettingsPatch, type Settings, type StoredSettings
} from "@factory/core";
import { boardStore } from "../../lib/board";
import { FactoryPicker } from "../board/FactoryPicker";
import { useFactories, useSelectedFactory, type FactoryEntry } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { describeWriteError, now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { FactoriesSection } from "./FactoriesTab";
import { SETTINGS_KEY, useSettings } from "./useSettings";

/** The PR gate's note for one factory's protected branches, or for every factory when no list is given (All). */
export function prGateNote(protectedBranches?: readonly string[]): string {
  const into = protectedBranches === undefined || protectedBranches.length === 0
    ? "each factory's protected branches"
    : protectedBranches.length === 1
      ? protectedBranches[0]
      : `${protectedBranches.slice(0, -1).join(", ")} or ${protectedBranches.at(-1)}`;
  return `A PR into ${into} always waits for you, whatever this says.`;
}
export const SETTINGS_CONFLICT = "Settings changed elsewhere. Reload to see the latest.";

const GATES: readonly Gate[] = ["spec", "plan", "pr"];
const GATE_LABEL: Readonly<Record<Gate, string>> = { plan: "Plan", pr: "PR", spec: "Spec" };
type LimitKey = keyof typeof SETTING_RANGES;
const rangeText = (key: LimitKey) => {
  const r = SETTING_RANGES[key];
  return `${r.min} to ${r.max}`;
};

/** A settings save failure; a conflict gets the settings wording, the rest are shared with task writes. */
function describeSettingsError(error: unknown): WriteProblem {
  if (error instanceof VersionConflictError) return { kind: "conflict", message: SETTINGS_CONFLICT };
  return describeWriteError(error);
}

/** Blank is not zero: an empty limit is refused by the range check, not saved as 0. */
const parseNumber = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.trim()));

/** After a save: the shell's pause state, this view and the History all read the new settings. */
function useSaved(onNotice: (text: string) => void) {
  const client = useQueryClient();
  return useCallback(async (stored: StoredSettings, notice: string) => {
    client.setQueryData(SETTINGS_KEY, stored);
    onNotice(notice);
    await Promise.all([client.invalidateQueries({ queryKey: SETTINGS_KEY }), client.invalidateQueries({ queryKey: HISTORY_KEY })]);
  }, [client, onNotice]);
}

/**
 * One scope's form text. Each field starts from its stored value (`origin`); the fields whose text differs are the
 * owner's own changes, and only those are saved. The text lives in this component only: leaving the view drops it
 * and remounting shows the stored values. When the stored scope changes (a reload, a save elsewhere), the fields
 * the owner did not change take the new stored value.
 */
function useScopeDraft<K extends string>(keys: readonly K[], stored: Record<K, string>) {
  const [origin, setOrigin] = useState(stored);
  const [values, setValues] = useState(stored);
  const changed = keys.filter((key) => values[key] !== origin[key]);

  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    const nextOrigin = { ...origin };
    const nextValues = { ...values };
    let moved = false;
    for (const key of keys) {
      if (values[key] !== origin[key] || origin[key] === stored[key]) continue;
      nextOrigin[key] = stored[key];
      nextValues[key] = stored[key];
      moved = true;
    }
    if (moved) {
      setOrigin(nextOrigin);
      setValues(nextValues);
    }
    // Runs when the stored values change (compared as text), not on every keystroke.
  }, [storedKey]);

  /** After a save: every field shows the saved value. */
  function settle(saved: Record<K, string>) {
    setValues(saved);
    setOrigin(saved);
  }

  return { changed, set: (key: K, text: string) => setValues((v) => ({ ...v, [key]: text })), settle, value: (key: K): string => values[key] };
}

const SECTIONS = [
  { id: "settings-factory", title: "Factory" },
  { id: "settings-gates-and-limits", title: "Gates and limits" },
  { id: "settings-repos", title: "Repos" },
  { id: "settings-factories", title: "Factories" }
] as const;
const SECTION_IDS: readonly string[] = SECTIONS.map((s) => s.id);
const PICK_A_FACTORY = "Pick a factory to see its settings.";

/** The nav's current section: the first one, a clicked one, or the visible one nearest the top while scrolling. */
function useCurrentSection(ids: readonly string[]): [string, (id: string) => void] {
  const [current, setCurrent] = useState<string>(ids[0] ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
        else visible.delete(id);
      }
      let best: string | undefined;
      let bestTop = Number.POSITIVE_INFINITY;
      for (const [id, top] of visible) {
        if (top < bestTop) {
          best = id;
          bestTop = top;
        }
      }
      if (best) setCurrent(best);
    }, { rootMargin: "0px 0px -60% 0px" });
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return [current, setCurrent];
}

/** One settings section: a surface panel named by its h2, the target of a nav link. */
function SettingsSection({ children, id, title }: { children: ReactNode; id: string; title: string }) {
  return (
    <section id={id} className="sf-panel sf-settings-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * One scrolling page: the selected factory's pause switch, gates and limits and repos, then the factory and repo
 * definitions. A sticky nav links to each section. Each scope saves on its own.
 */
export function SettingsView() {
  const settings = useSettings();
  const factories = useFactories();
  const [picked, setPicked] = useSelectedFactory();
  const [notice, setNotice] = useState("");
  const [currentSection, setCurrentSection] = useCurrentSection(SECTION_IDS);
  const noteId = useId();

  // With one factory there is nothing to pick: its settings show whatever the stored pick says.
  const only = factories.defs.length === 1 ? factories.defs[0] : undefined;
  const entry = only ? factories.byId.get(only.factoryId) : factories.byId.get(picked);
  const factoriesFailed = Boolean(factories.error) && factories.byId.size === 0;
  const reload = async () => { await settings.refetch(); };

  const scoped = (body: (factoryId: string, current: FactoryStored, def: FactoryEntry) => ReactNode): ReactNode => {
    if (!settings.data || factories.loading || factoriesFailed) return null;
    if (!entry) return <p className="sf-empty">{PICK_A_FACTORY}</p>;
    const factoryId = entry.def.factoryId;
    return body(factoryId, settings.data.factories[factoryId] ?? { factory: DEFAULT_SETTINGS, repos: {} }, entry);
  };

  return (
    <div className="sf-view sf-settings">
      <div className="sf-toolbar">
        <h2 className="sf-page-title">Settings</h2>
        {factories.defs.length > 1 ? <FactoryPicker defs={factories.defs} value={entry ? picked : "all"} onChange={setPicked} /> : null}
      </div>
      <p className="sf-visually-hidden" role="status">{notice}</p>
      {settings.isPending ? <p className="sf-empty" role="status">Loading settings…</p> : null}
      {!settings.isPending && !settings.data ? (
        <div className="sf-problem" role="alert">
          <span>Could not load the settings.</span>
          <button type="button" className="sf-button" onClick={() => void settings.refetch()}>Retry</button>
        </div>
      ) : null}
      {settings.data && settings.isError ? (
        <div className="sf-problem" role="alert">
          <span>Could not refresh the settings; showing what was loaded last.</span>
          <button type="button" className="sf-button" onClick={() => void reload()}>Retry</button>
        </div>
      ) : null}
      {factories.loading ? <p className="sf-empty" role="status">Loading factories…</p> : null}
      {!factories.loading && factoriesFailed ? (
        <div className="sf-problem" role="alert">
          <span>Could not load the factories.</span>
          <button type="button" className="sf-button" onClick={() => void factories.refetch()}>Retry</button>
        </div>
      ) : null}
      <div className="sf-settings-layout">
        <nav className="sf-settings-nav" aria-label="Settings sections">
          <ul>
            {SECTIONS.map(({ id, title }) => (
              <li key={id}>
                <a href={`#${id}`} aria-current={currentSection === id ? "location" : undefined} onClick={() => setCurrentSection(id)}>{title}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sf-settings-sections">
          <SettingsSection id="settings-factory" title="Factory">
            {scoped((factoryId, current) => (
              <PauseControl key={`${factoryId}:pause`} factoryId={factoryId} paused={current.factory.paused} onNotice={setNotice} onReload={reload} />
            ))}
          </SettingsSection>
          <SettingsSection id="settings-gates-and-limits" title="Gates and limits">
            {scoped((factoryId, current, { def }) => (
              <>
                <p className="sf-hint">These apply to every repo unless a repo overrides them below.</p>
                <GlobalForm key={`${factoryId}:defaults`} factoryId={factoryId} global={current.factory} protectedBranches={def.protectedBranches} noteId={noteId} onNotice={setNotice} onReload={reload} />
              </>
            ))}
          </SettingsSection>
          <SettingsSection id="settings-repos" title="Repos">
            {scoped((factoryId, current, { repos }) => (
              <>
                <RepoTable key={`${factoryId}:repos`} factoryId={factoryId} repos={repos} stored={current} noteId={noteId} onNotice={setNotice} onReload={reload} />
                <RemovedRepoSettings key={`${factoryId}:removed`} factoryId={factoryId} repos={repos} existing={factories.storedRepos} stored={current} onNotice={setNotice} onReload={reload} />
              </>
            ))}
          </SettingsSection>
          <SettingsSection id="settings-factories" title="Factories">
            <FactoriesSection />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}

type ScopeProps = { factoryId: string; onNotice: (text: string) => void; onReload: () => Promise<void> };

/** Saves at once; the shell's "Factory paused" follows the stored value. */
function PauseControl({ factoryId, onNotice, onReload, paused }: ScopeProps & { paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<WriteProblem>();
  const saved = useSaved(onNotice);
  const ids = useId();

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const stored = await saveSettings(boardStore, now, factoryId, { paused: !paused });
      await saved(stored, stored.factories[factoryId]?.factory.paused ? "Factory paused." : "Factory running.");
    } catch (error) {
      setProblem(describeSettingsError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className="sf-switch">
        <input type="checkbox" role="switch" checked={paused} disabled={busy} onChange={() => void toggle()} aria-describedby={`${ids}-hint`} />
        <span>Pause the factory</span>
      </label>
      <p id={`${ids}-hint`} className="sf-hint">While paused, the factory starts no new work. Steps already running finish. This saves at once.</p>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
    </>
  );
}

const GLOBAL_KEYS = ["spec", "plan", "pr", "maxParallel", "maxTurnsPerStage", "maxCostPerTaskUsd"] as const;
type GlobalKey = (typeof GLOBAL_KEYS)[number];
const GATE_SWITCH_LABEL: Readonly<Record<Gate, string>> = {
  plan: "Plan: you approve every plan",
  pr: "PR: you merge every PR",
  spec: "Spec: you approve every spec"
};
type Limit = { hint: string; key: LimitKey; label: string; repoLabel: string };
const LIMITS: readonly Limit[] = [
  { hint: rangeText("maxParallel"), key: "maxParallel", label: "Tasks at once", repoLabel: "" },
  { hint: rangeText("maxTurnsPerStage"), key: "maxTurnsPerStage", label: "Turns per stage", repoLabel: "turn limit" },
  { hint: "The runner stops a task above this", key: "maxCostPerTaskUsd", label: "Cost per task (USD)", repoLabel: "cost limit" }
];

const globalDraft = (s: Settings): Record<GlobalKey, string> => ({
  maxCostPerTaskUsd: String(s.maxCostPerTaskUsd),
  maxParallel: String(s.maxParallel),
  maxTurnsPerStage: String(s.maxTurnsPerStage),
  plan: String(s.gates.plan),
  pr: String(s.gates.pr),
  spec: String(s.gates.spec)
});

function GlobalForm({
  factoryId, global, noteId, onNotice, onReload, protectedBranches
}: ScopeProps & { global: Settings; noteId: string; protectedBranches: readonly string[] }) {
  const ids = useId();
  const draft = useScopeDraft(GLOBAL_KEYS, globalDraft(global));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<WriteProblem>();
  const [done, setDone] = useState(false);
  const saved = useSaved(onNotice);

  function edit(key: GlobalKey, text: string) {
    draft.set(key, text);
    setDone(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const patch: { gates?: Partial<Record<Gate, boolean>> } & Partial<Record<LimitKey, number>> = {};
    for (const key of draft.changed) {
      if (key === "spec" || key === "plan" || key === "pr") patch.gates = { ...patch.gates, [key]: draft.value(key) === "true" };
      else patch[key] = parseNumber(draft.value(key));
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const stored = await saveSettings(boardStore, now, factoryId, patch);
      draft.settle(globalDraft(stored.factories[factoryId]?.factory ?? DEFAULT_SETTINGS));
      setDone(true);
      await saved(stored, "Saved gates and limits.");
    } catch (error) {
      setProblem(describeSettingsError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sf-form" aria-label="Gates and limits" noValidate onSubmit={(event) => void save(event)}>
      <fieldset className="sf-fieldset">
        <legend>Where the factory stops for you</legend>
        {GATES.map((gate) => (
          <div key={gate} className="sf-switch-row">
            <label className="sf-switch">
              <input
                type="checkbox"
                role="switch"
                checked={draft.value(gate) === "true"}
                onChange={(event) => edit(gate, String(event.target.checked))}
                aria-describedby={gate === "pr" ? noteId : undefined}
              />
              <span>{GATE_SWITCH_LABEL[gate]}</span>
            </label>
          </div>
        ))}
        <p id={noteId} className="sf-hint">{prGateNote(protectedBranches)}</p>
      </fieldset>
      <div className="sf-field-row">
        {LIMITS.map(({ hint, key, label }) => (
          <div key={key} className="sf-field sf-limit">
            <label className="sf-field-label" htmlFor={`${ids}-${key}`}>{label}</label>
            <input
              id={`${ids}-${key}`}
              className="sf-input sf-mono"
              inputMode={SETTING_RANGES[key].integer ? "numeric" : "decimal"}
              value={draft.value(key)}
              onChange={(event) => edit(key, event.target.value)}
              aria-describedby={`${ids}-${key}-hint`}
            />
            <span id={`${ids}-${key}-hint`} className="sf-hint">{hint}</span>
          </div>
        ))}
      </div>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Save gates and limits</button>
        {done && draft.changed.length === 0 ? <span className="sf-muted">Saved.</span> : null}
      </div>
    </form>
  );
}

const REPO_KEYS = ["spec", "plan", "pr", "maxTurnsPerStage", "maxCostPerTaskUsd"] as const;
type RepoKey = (typeof REPO_KEYS)[number];
type RepoLimit = Exclude<RepoKey, Gate>;
const REPO_LIMITS = LIMITS.filter((l): l is Limit & { key: RepoLimit } => l.key !== "maxParallel");
const gateText = (on: boolean | undefined): string => (on === undefined ? "inherit" : on ? "on" : "off");

const repoDraft = (r: RepoSettings | undefined): Record<RepoKey, string> => ({
  maxCostPerTaskUsd: r?.maxCostPerTaskUsd === undefined ? "" : String(r.maxCostPerTaskUsd),
  maxTurnsPerStage: r?.maxTurnsPerStage === undefined ? "" : String(r.maxTurnsPerStage),
  plan: gateText(r?.gates?.plan),
  pr: gateText(r?.gates?.pr),
  spec: gateText(r?.gates?.spec)
});

type FactoryStored = StoredSettings["factories"][string];

/** What a repo overrides of the factory's gates, in spec, plan, PR order; "Same as factory" when nothing. */
export function gatesSummary(r: RepoSettings | undefined): string {
  const parts: string[] = [];
  for (const gate of GATES) {
    const on = r?.gates?.[gate];
    if (on !== undefined) parts.push(`${GATE_LABEL[gate]} gate ${on ? "on" : "off"}`);
  }
  return parts.length === 0 ? "Same as factory" : parts.join(", ");
}

/** A repo's check commands in the order they run. */
export function checksSummary(c: FactoryRepo["checks"]): string {
  return [c.server.build, c.server.test, c.client.install, c.client.typecheck, c.client.lint, c.client.test].join(" · ");
}

function RepoTable({ factoryId, noteId, onNotice, onReload, repos, stored }: ScopeProps & { noteId: string; repos: readonly FactoryRepo[]; stored: FactoryStored }) {
  const [open, setOpen] = useState<string>();
  return (
    <>
      <p className="sf-hint">Inherit uses the factory default. An empty limit inherits too.</p>
      <div className="sf-table-wrap">
        <table className="sf-table sf-repo-table" aria-label="Repos">
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Base</th>
              <th scope="col">Gates</th>
              <th scope="col">Checks</th>
              <th scope="col"><span className="sf-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <RepoRow
                key={repo.repoId}
                factoryId={factoryId}
                repo={repo}
                global={stored.factory}
                stored={stored.repos[repo.repoId]}
                noteId={noteId}
                open={open === repo.repoId}
                onToggle={() => setOpen((was) => (was === repo.repoId ? undefined : repo.repoId))}
                onNotice={onNotice}
                onReload={onReload}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type RepoRowProps = ScopeProps & { global: Settings; noteId: string; stored: RepoSettings | undefined };

function RepoRow({ open, onToggle, repo, ...rest }: RepoRowProps & { onToggle: () => void; open: boolean; repo: FactoryRepo }) {
  const { repoId } = repo;
  return (
    <>
      <tr aria-label={repoId}>
        <th scope="row" className="sf-mono">{repoId}</th>
        <td className="sf-mono">{repo.baseBranch}</td>
        <td>{gatesSummary(rest.stored)}</td>
        <td className="sf-mono">{checksSummary(repo.checks)}</td>
        <td>
          <button type="button" className="sf-button" aria-label={`Edit overrides for ${repoId}`} aria-expanded={open} onClick={onToggle}>Edit</button>
        </td>
      </tr>
      {open ? (
        <tr className="sf-repo-edit-row">
          <td colSpan={5}>
            <RepoOverrideForm {...rest} repo={repoId} onClose={onToggle} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** One repo's gate and limit overrides; Inherit and an empty limit save as null. */
function RepoOverrideForm({ factoryId, global, noteId, onClose, onNotice, onReload, repo, stored }: RepoRowProps & { onClose: () => void; repo: string }) {
  const draft = useScopeDraft(REPO_KEYS, repoDraft(stored));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<WriteProblem>();
  const [done, setDone] = useState(false);
  const saved = useSaved(onNotice);

  function edit(key: RepoKey, text: string) {
    draft.set(key, text);
    setDone(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // Inherit (a gate) or an empty limit is null: the repo takes the global value again.
    const patch: RepoSettingsPatch = {};
    for (const key of draft.changed) {
      const text = draft.value(key);
      if (key === "spec" || key === "plan" || key === "pr") patch.gates = { ...patch.gates, [key]: text === "inherit" ? null : text === "on" };
      else patch[key] = text.trim() === "" ? null : parseNumber(text);
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const next = await saveSettings(boardStore, now, `${factoryId}/${repo}`, patch);
      draft.settle(repoDraft(next.factories[factoryId]?.repos[repo]));
      setDone(true);
      await saved(next, `Saved ${repo} settings.`);
    } catch (error) {
      setProblem(describeSettingsError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sf-form sf-repo-overrides" aria-label={`${repo} overrides`} noValidate onSubmit={(event) => void save(event)}>
      <div className="sf-field-row">
        {GATES.map((gate) => (
          <label key={gate} className="sf-field">
            <span className="sf-field-label">{GATE_LABEL[gate]} gate</span>
            <select
              className="sf-select"
              aria-label={`${repo} ${gate === "pr" ? "PR" : gate} gate`}
              aria-describedby={gate === "pr" ? noteId : undefined}
              value={draft.value(gate)}
              onChange={(event) => edit(gate, event.target.value)}
            >
              <option value="inherit">Inherit</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
        ))}
        {REPO_LIMITS.map(({ key, label, repoLabel }) => (
          <label key={key} className="sf-field">
            <span className="sf-field-label">{label}</span>
            <input
              className="sf-input sf-mono sf-limit-input"
              inputMode={SETTING_RANGES[key].integer ? "numeric" : "decimal"}
              aria-label={`${repo} ${repoLabel}`}
              placeholder={`Inherit (${global[key]})`}
              value={draft.value(key)}
              onChange={(event) => edit(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
      <div className="sf-actions">
        <button type="submit" className="sf-button" aria-label={`Save ${repo}`} disabled={busy}>Save</button>
        <button type="button" className="sf-button" onClick={onClose}>Close</button>
        {done && draft.changed.length === 0 ? <span className="sf-muted">Saved.</span> : null}
      </div>
    </form>
  );
}

const settingText = (s: RepoSettings): string => {
  const parts: string[] = [];
  if (s.gates) parts.push(`gates ${JSON.stringify(s.gates)}`);
  if (s.maxParallel !== undefined) parts.push(`max parallel ${s.maxParallel}`);
  if (s.maxTurnsPerStage !== undefined) parts.push(`turn limit ${s.maxTurnsPerStage}`);
  if (s.maxCostPerTaskUsd !== undefined) parts.push(`cost limit ${s.maxCostPerTaskUsd}`);
  if (s.paused !== undefined) parts.push(`paused ${s.paused}`);
  return parts.join(", ") || "no overrides";
};

/** Overrides stored for repos the factory no longer has. They do nothing; the owner can reset them to inherit. */
function RemovedRepoSettings({ existing, factoryId, onNotice, onReload, repos, stored }: ScopeProps & { existing: ReadonlySet<string>; repos: readonly FactoryRepo[]; stored: FactoryStored }) {
  const titleId = useId();
  const saved = useSaved(onNotice);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState<WriteProblem>();
  // Removed: no stored repo at all. Invalid: stored but unusable, so it is not in `repos`; those settings stay as they are.
  const orphans = Object.keys(stored.repos).filter((id) => !existing.has(`${factoryId}/${id}`));
  const invalid = Object.keys(stored.repos).filter((id) => existing.has(`${factoryId}/${id}`) && !repos.some((r) => r.repoId === id));
  if (orphans.length === 0 && invalid.length === 0) return null;

  async function reset(repo: string) {
    if (busy) return;
    setBusy(repo);
    setProblem(undefined);
    try {
      const next = await resetRemovedRepoSettings(boardStore, now, factoryId, repo);
      await saved(next, `Reset ${repo} settings.`);
    } catch (error) {
      setProblem(describeSettingsError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      {orphans.length > 0 ? (
        <section className="sf-settings-subsection" aria-labelledby={titleId}>
          <h3 id={titleId}>Settings for removed repos</h3>
          <p className="sf-hint">These repos are no longer in the factory. Reset drops their overrides.</p>
          <ul className="sf-plain-list">
            {orphans.map((repo) => (
              <li key={repo} className="sf-actions">
                <span className="sf-mono">{repo}</span>
                <span className="sf-muted">{settingText(stored.repos[repo]!)}</span>
                <button type="button" className="sf-button" disabled={busy !== ""} aria-label={`Reset ${repo} settings`} onClick={() => void reset(repo)}>Reset</button>
              </li>
            ))}
          </ul>
          <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
        </section>
      ) : null}
      {invalid.length > 0 ? (
        <section className="sf-settings-subsection" aria-label="Settings for invalid repos">
          <h3>Settings for invalid repos</h3>
          <p className="sf-hint">These repos exist but fail validation, so they are not listed above. Fix them in the Factories section.</p>
          <ul className="sf-plain-list">
            {invalid.map((repo) => (
              <li key={repo} className="sf-actions"><span className="sf-mono">{repo}</span><span className="sf-muted">{settingText(stored.repos[repo]!)}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
