import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import {
  DEFAULT_SETTINGS, resetRemovedRepoSettings, saveSettings, SETTING_RANGES, VersionConflictError,
  type FactoryRepo, type Gate, type RepoSettings, type RepoSettingsPatch, type Settings, type StoredSettings
} from "@factory/core";
import { boardStore } from "../../lib/board";
import { FactoryPicker } from "../board/FactoryPicker";
import { useFactories, useSelectedFactory } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { describeWriteError, now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { FactoriesTab } from "./FactoriesTab";
import { SETTINGS_KEY, useSettings } from "./useSettings";

export const PR_GATE_NOTE = "Turning this off lets the factory merge into other branches. A PR into dev, stg or main always waits for you.";
export const SETTINGS_CONFLICT = "Settings changed elsewhere. Reload to see the latest.";

const GATES: readonly Gate[] = ["spec", "plan", "pr"];
const GATE_LABEL: Readonly<Record<Gate, string>> = { plan: "Plan", pr: "PR", spec: "Spec" };
type LimitKey = keyof typeof SETTING_RANGES;
const rangeText = (key: LimitKey) => {
  const r = SETTING_RANGES[key];
  return `${r.min} to ${r.max}${r.integer ? ", whole number" : ""}`;
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

type SettingsTab = "factories" | "settings";
const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "settings", label: "Factory settings" },
  { id: "factories", label: "Factories" }
];

/** Two tabs: the selected factory's gates, limits and repo overrides, and the factory and repo definitions. */
export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>("settings");
  const ids = useId();
  return (
    <div className="sf-view sf-settings">
      <div className="sf-toolbar"><h2>Settings</h2></div>
      <div className="sf-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            id={`${ids}-${id}-tab`}
            type="button"
            role="tab"
            className="sf-tab"
            aria-selected={tab === id}
            aria-controls={`${ids}-panel`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-${tab}-tab`} className="sf-tab-panel">
        {tab === "settings" ? <FactorySettingsTab /> : <FactoriesTab />}
      </div>
    </div>
  );
}


/** The selected factory's pause switch, defaults and repo overrides. Each scope saves on its own. */
function FactorySettingsTab() {
  const settings = useSettings();
  const factories = useFactories();
  const [picked, setPicked] = useSelectedFactory();
  const [notice, setNotice] = useState("");
  const noteId = useId();

  if (settings.isPending) return <p className="sf-empty" role="status">Loading settings…</p>;
  if (!settings.data) {
    return (
      <div className="sf-problem" role="alert">
        <span>Could not load the settings.</span>
        <button type="button" className="sf-button" onClick={() => void settings.refetch()}>Retry</button>
      </div>
    );
  }
  const stored = settings.data;
  const reload = async () => { await settings.refetch(); };
  const entry = factories.byId.get(picked);
  const picker = <FactoryPicker defs={factories.defs} value={entry ? picked : "all"} onChange={setPicked} />;

  if (!entry && factories.error && factories.byId.size === 0 && !factories.loading) {
    return (
      <div className="sf-problem" role="alert">
        <span>Could not load the factories.</span>
        <button type="button" className="sf-button" onClick={() => void factories.refetch()}>Retry</button>
      </div>
    );
  }
  if (!entry) {
    return (
      <>
        <div className="sf-toolbar">{picker}</div>
        {factories.loading ? <p className="sf-empty" role="status">Loading factories…</p> : <p className="sf-empty">Pick a factory to see its settings.</p>}
      </>
    );
  }
  const factoryId = entry.def.factoryId;
  const current = stored.factories[factoryId] ?? { factory: DEFAULT_SETTINGS, repos: {} };

  return (
    <>
      <div className="sf-toolbar">{picker}</div>
      <p className="sf-visually-hidden" role="status">{notice}</p>
      {settings.isError ? (
        <div className="sf-problem" role="alert">
          <span>Could not refresh the settings; showing what was loaded last.</span>
          <button type="button" className="sf-button" onClick={() => void reload()}>Retry</button>
        </div>
      ) : null}
      <PauseControl key={`${factoryId}:pause`} factoryId={factoryId} paused={current.factory.paused} onNotice={setNotice} onReload={reload} />
      <GlobalForm key={`${factoryId}:defaults`} factoryId={factoryId} global={current.factory} noteId={noteId} onNotice={setNotice} onReload={reload} />
      <RepoTable key={`${factoryId}:repos`} factoryId={factoryId} repos={entry.repos} stored={current} noteId={noteId} onNotice={setNotice} onReload={reload} />
      <RemovedRepoSettings key={`${factoryId}:removed`} factoryId={factoryId} repos={entry.repos} existing={factories.storedRepos} stored={current} onNotice={setNotice} onReload={reload} />
    </>
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
    <section className="sf-panel sf-settings-section" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`}>Factory</h3>
      <label className="sf-switch">
        <input type="checkbox" role="switch" checked={paused} disabled={busy} onChange={() => void toggle()} aria-describedby={`${ids}-hint`} />
        <span>Pause factory</span>
      </label>
      <p id={`${ids}-hint`} className="sf-hint">While paused, the factory starts no new work. This saves at once.</p>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
    </section>
  );
}

const GLOBAL_KEYS = ["spec", "plan", "pr", "maxParallel", "maxTurnsPerStage", "maxCostPerTaskUsd"] as const;
type GlobalKey = (typeof GLOBAL_KEYS)[number];
const LIMITS: readonly { key: LimitKey; label: string; repoLabel: string }[] = [
  { key: "maxParallel", label: "Max parallel tasks", repoLabel: "" },
  { key: "maxTurnsPerStage", label: "Turn limit per stage", repoLabel: "turn limit" },
  { key: "maxCostPerTaskUsd", label: "Cost limit per task (USD)", repoLabel: "cost limit" }
];

const globalDraft = (s: Settings): Record<GlobalKey, string> => ({
  maxCostPerTaskUsd: String(s.maxCostPerTaskUsd),
  maxParallel: String(s.maxParallel),
  maxTurnsPerStage: String(s.maxTurnsPerStage),
  plan: String(s.gates.plan),
  pr: String(s.gates.pr),
  spec: String(s.gates.spec)
});

function GlobalForm({ factoryId, global, noteId, onNotice, onReload }: ScopeProps & { global: Settings; noteId: string }) {
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
      await saved(stored, "Saved factory defaults.");
    } catch (error) {
      setProblem(describeSettingsError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sf-panel sf-settings-section sf-form" aria-label="Factory defaults" noValidate onSubmit={(event) => void save(event)}>
      <h3>Defaults</h3>
      <fieldset className="sf-fieldset">
        <legend>Gates</legend>
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
              <span>{GATE_LABEL[gate]} gate</span>
            </label>
            {gate === "pr" ? <p id={noteId} className="sf-hint">{PR_GATE_NOTE}</p> : null}
          </div>
        ))}
      </fieldset>
      <div className="sf-field-row">
        {LIMITS.map(({ key, label }) => (
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
            <span id={`${ids}-${key}-hint`} className="sf-hint">{rangeText(key)}</span>
          </div>
        ))}
      </div>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Save factory defaults</button>
        {done && draft.changed.length === 0 ? <span className="sf-muted">Saved.</span> : null}
      </div>
    </form>
  );
}

const REPO_KEYS = ["spec", "plan", "pr", "maxTurnsPerStage", "maxCostPerTaskUsd"] as const;
type RepoKey = (typeof REPO_KEYS)[number];
type RepoLimit = Exclude<RepoKey, Gate>;
const REPO_LIMITS = LIMITS.filter((l): l is { key: RepoLimit; label: string; repoLabel: string } => l.key !== "maxParallel");
const gateText = (on: boolean | undefined): string => (on === undefined ? "inherit" : on ? "on" : "off");

const repoDraft = (r: RepoSettings | undefined): Record<RepoKey, string> => ({
  maxCostPerTaskUsd: r?.maxCostPerTaskUsd === undefined ? "" : String(r.maxCostPerTaskUsd),
  maxTurnsPerStage: r?.maxTurnsPerStage === undefined ? "" : String(r.maxTurnsPerStage),
  plan: gateText(r?.gates?.plan),
  pr: gateText(r?.gates?.pr),
  spec: gateText(r?.gates?.spec)
});

type FactoryStored = StoredSettings["factories"][string];

function RepoTable({ factoryId, noteId, onNotice, onReload, repos, stored }: ScopeProps & { noteId: string; repos: readonly FactoryRepo[]; stored: FactoryStored }) {
  const titleId = useId();
  return (
    <section className="sf-panel sf-settings-section" aria-labelledby={titleId}>
      <h3 id={titleId}>Repo overrides</h3>
      <p className="sf-hint">Inherit uses the factory default. An empty limit inherits too.</p>
      <div className="sf-table-wrap">
        <table className="sf-table sf-repo-table" aria-label="Repo overrides">
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Spec gate</th>
              <th scope="col">Plan gate</th>
              <th scope="col">PR gate</th>
              <th scope="col">Turn limit</th>
              <th scope="col">Cost limit (USD)</th>
              <th scope="col"><span className="sf-visually-hidden">Save</span></th>
            </tr>
          </thead>
          <tbody>
            {repos.map(({ repoId }) => (
              <RepoRow key={repoId} factoryId={factoryId} repo={repoId} global={stored.factory} stored={stored.repos[repoId]} noteId={noteId} onNotice={onNotice} onReload={onReload} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RepoRow({ factoryId, global, noteId, onNotice, onReload, repo, stored }: ScopeProps & {
  global: Settings; noteId: string; repo: string; stored: RepoSettings | undefined;
}) {
  const formId = useId();
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
    <>
      <tr aria-label={repo}>
        <th scope="row" className="sf-mono">{repo}</th>
        {GATES.map((gate) => (
          <td key={gate}>
            <select
              form={formId}
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
          </td>
        ))}
        {REPO_LIMITS.map(({ key, repoLabel }) => (
          <td key={key}>
            <input
              form={formId}
              className="sf-input sf-mono sf-limit-input"
              inputMode={SETTING_RANGES[key].integer ? "numeric" : "decimal"}
              aria-label={`${repo} ${repoLabel}`}
              placeholder={`Inherit (${global[key]})`}
              value={draft.value(key)}
              onChange={(event) => edit(key, event.target.value)}
            />
          </td>
        ))}
        <td>
          <form id={formId} className="sf-row-save" aria-label={`${repo} overrides`} noValidate onSubmit={(event) => void save(event)}>
            <button type="submit" className="sf-button" aria-label={`Save ${repo}`} disabled={busy}>Save</button>
            {done && draft.changed.length === 0 ? <span className="sf-muted">Saved.</span> : null}
          </form>
        </td>
      </tr>
      {problem ? (
        <tr className="sf-row-problem">
          <td colSpan={7}>
            <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
          </td>
        </tr>
      ) : null}
    </>
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
        <section className="sf-panel sf-settings-section" aria-labelledby={titleId}>
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
        <section className="sf-panel sf-settings-section" aria-label="Settings for invalid repos">
          <h3>Settings for invalid repos</h3>
          <p className="sf-hint">These repos exist but fail validation, so they are not listed above. Fix them on the Factories tab.</p>
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
