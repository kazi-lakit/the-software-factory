import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FactoryHealth, FactoryRepo } from "@factory/core";
import { FACTORIES_KEY, useFactories, useFactoryHealth, useSelectedFactory, type FactoryEntry } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { FactoryForm } from "./FactoryForm";
import { ImportFactory } from "./ImportFactory";
import { RepoForm } from "./RepoForm";
import { formatTime } from "../../lib/formatTime";
import { setNavigationGuard } from "../../lib/navigationGuard";
import { followInApp } from "../board/TaskCard";

const NEW_FACTORY_PATH = "/settings/factories/new";

type Editing =
  | { kind: "edit-factory"; factoryId: string }
  | { kind: "add-repo"; factoryId: string }
  | { kind: "edit-repo"; factoryId: string; repoId: string }
  | { kind: "import" };

/** The gh login as `factory status` last found it (gh auth status); a factory the core has not checked is `unknown`. */
function GhStatus({ health }: { health: FactoryHealth | undefined }) {
  if (!health) return <span className="sf-chip sf-gh sf-gh-unknown" title="Not checked yet">gh unknown</span>;
  const state = health.ghLoggedIn ? "signed-in" : "signed-out";
  return (
    <>
      <span className={`sf-chip sf-gh sf-gh-${state}`}>{health.ghLoggedIn ? "gh signed in" : "gh signed out"}</span>
      <span className="sf-muted">checked <time dateTime={health.checkedAt}>{formatTime(health.checkedAt)}</time></span>
    </>
  );
}

/** Factories and their repos: list, edit, import, and the definitions the Board cannot use. Add factory opens the New factory page. */
export function FactoriesSection({ onNavigate }: { onNavigate?: (path: string) => void } = {}) {
  const client = useQueryClient();
  const factories = useFactories();
  const health = useFactoryHealth();
  const [picked] = useSelectedFactory();
  const [editing, setEditing] = useState<Editing>();
  const editTrigger = useRef<HTMLElement | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    setNavigationGuard(dirty ? () => window.confirm("Discard the current edits?") : undefined);
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); setNavigationGuard(undefined); };
  }, [dirty]);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string>();

  const entries = [...factories.byId.values()];
  const shown = entries.filter(({ def }) => `${def.name} ${def.factoryId}`.toLowerCase().includes(search.trim().toLowerCase()));
  const openId = expanded ?? (entries.length === 1 ? entries[0]?.def.factoryId : entries.some(({ def }) => def.factoryId === picked) ? picked : undefined);
  const beginEdit = (next: Editing) => { if (dirty && !window.confirm("Discard the current edits?")) return; editTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDirty(false); setEditing(next); };
  const healthOf = (factoryId: string) => health.data?.find((h) => h.factoryId === factoryId);
  const close = () => { if (dirty && !window.confirm("Discard the current edits?")) return; setDirty(false); setEditing(undefined); requestAnimationFrame(() => editTrigger.current?.focus()); };

  /** Refetches the definitions and returns what is stored now. */
  async function reload<T>(pick: (entries: FactoryEntry[]) => T | undefined): Promise<T | undefined> {
    const result = await factories.refetch();
    return pick(result.data?.entries ?? []);
  }

  async function saved(text: string) {
    setNotice(text);
    setDirty(false);
    setEditing(undefined);
    requestAnimationFrame(() => editTrigger.current?.focus());
    await Promise.all([client.invalidateQueries({ queryKey: FACTORIES_KEY }), client.invalidateQueries({ queryKey: HISTORY_KEY })]);
  }

  // The page shows the loading and load-error messages once, above the sections; a failed load leaves a short note here.
  if (factories.loading) return null;
  if (factories.error && entries.length === 0) return <p className="sf-empty">Settings are not available.</p>;

  const form = (() => {
    if (!editing) return null;
    switch (editing.kind) {
      case "edit-factory": {
        const entry = factories.byId.get(editing.factoryId);
        if (!entry) return null;
        return (
          <FactoryForm
            key={`edit-${editing.factoryId}`}
            before={entry.def}
            onCancel={close}
            onReload={() => reload((all) => all.find((e) => e.def.factoryId === editing.factoryId)?.def)}
            onSaved={(d) => void saved(`Saved factory ${d.factoryId}.`)}
          />
        );
      }
      case "add-repo":
      case "edit-repo": {
        const entry = factories.byId.get(editing.factoryId);
        if (!entry) return null;
        const repoId = editing.kind === "edit-repo" ? editing.repoId : undefined;
        const before = repoId ? (entry.repos.find((r) => r.repoId === repoId) ?? null) : null;
        return (
          <RepoForm
            key={`repo-${editing.factoryId}-${repoId ?? "new"}`}
            def={entry.def}
            before={before}
            onCancel={close}
            onReload={() => reload((all) => all.find((e) => e.def.factoryId === editing.factoryId)?.repos.find((r) => r.repoId === repoId))}
            onSaved={(r) => void saved(`Saved repo ${r.repoId} of ${r.factoryId}.`)}
          />
        );
      }
      case "import":
        return <ImportFactory onClose={close} onDone={() => { setDirty(false); setEditing(undefined); }} />;
    }
  })();

  return (
    <>
      <p>Manage all factories. Use General to pause or resume execution.</p>
      <div className="sf-toolbar">
        <a
          href={NEW_FACTORY_PATH}
          className="sf-button sf-button-primary"
          onClick={(event) => {
            if (onNavigate) followInApp(event, NEW_FACTORY_PATH, onNavigate);
          }}
        >
          Add factory
        </a>
        <button type="button" className="sf-button" onClick={() => beginEdit({ kind: "import" })}>Import factory</button>
      </div>
      <p className={notice ? "sf-feedback" : "sf-visually-hidden"} role="status">{notice}</p>
      {health.isError ? <p className="sf-hint">Could not read the gh login checks; they show as unknown.</p> : null}
      {form && !(editing?.kind === "edit-factory" || editing?.kind === "edit-repo" || editing?.kind === "add-repo") ? <div onChangeCapture={() => setDirty(true)}>{form}</div> : null}

      {entries.length === 0 ? <p className="sf-empty">No factory is set up yet. Add one, or import the file from <span className="sf-mono">factory migrate --export</span>.</p> : null}
      <p className="sf-hint">{shown.length} of {entries.length} factories</p>
      {entries.length > 1 ? <label className="sf-field"><span>Search factories</span><input className="sf-input" type="search" disabled={dirty} value={search} onChange={(event) => setSearch(event.target.value)} /></label> : null}
      {search ? <button type="button" className="sf-button" onClick={() => setSearch("")}>Clear search</button> : null}
      {shown.length === 0 && entries.length > 0 ? <p className="sf-empty">No factories match your search.</p> : null}
      {shown.map((entry) => (
        <FactorySection
          key={entry.def.factoryId}
          entry={entry}
          health={healthOf(entry.def.factoryId)}
          editing={editing}
          form={form}
          onEdit={beginEdit}
          setDirty={setDirty}
          open={openId === entry.def.factoryId}
          onToggle={() => { if (dirty && !window.confirm("Discard the current edits?")) return; setDirty(false); setEditing(undefined); setExpanded(openId === entry.def.factoryId ? "" : entry.def.factoryId); }}
        />
      ))}

      {factories.skipped.length > 0 ? (
        <details className="sf-panel sf-skipped">
          <summary>Skipped definitions ({factories.skipped.length})</summary>
          <p className="sf-hint">The Board and the core ignore these until they are fixed in Blocks.</p>
          <ul className="sf-plain-list">
            {factories.skipped.map((skip, index) => (
              <li key={`${skip.id}:${index}`}><span className="sf-mono">{skip.id}</span>: {skip.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function FactorySection({ editing, entry, form, health, onEdit, open, onToggle, setDirty }: {
  editing: Editing | undefined; entry: FactoryEntry; form: React.ReactNode; health: FactoryHealth | undefined; onEdit: (e: Editing) => void; open: boolean; onToggle: () => void; setDirty: (dirty: boolean) => void;
}) {
  const { def, repos } = entry;
  const here = editing && "factoryId" in editing && editing.factoryId === def.factoryId ? editing : undefined;
  return (
    <section className="sf-factory-row" aria-label={`Factory ${def.factoryId}`}>
      <button type="button" className="sf-factory-summary" aria-expanded={open} onClick={onToggle}><strong>{def.name}</strong>{" "}<span>{def.factoryId} · {def.active ? "Active" : "Inactive"} · {repos.length} repositories · {health ? (health.ghLoggedIn ? "GitHub signed in" : "GitHub signed out") : "GitHub status unknown"}</span></button>
      <div hidden={!open}>
      <div className="sf-actions">
        <h3>{def.name}</h3>
        <span className="sf-mono">{`GitHub login ${def.ghUser}`}</span>
        <GhStatus health={health} />
        <button type="button" className="sf-button" aria-label={`Edit factory ${def.factoryId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "edit-factory" })}>Edit factory</button>
      </div>
      <h4>Factory details</h4>
      <dl className="sf-facts">
        <dt>Id</dt>
        <dd className="sf-mono">{def.factoryId}</dd>
        <dt>State</dt>
        <dd className={def.active ? "sf-status-on" : "sf-muted"}>{def.active ? "Active" : "Inactive"}</dd>
        <dt>Protected branches</dt>
        <dd className="sf-mono">{def.protectedBranches.join(", ")}</dd>
        <dt>Agent models</dt>
        <dd>{Object.entries(def.agentModels ?? {}).map(([stage, model]) => `${stage}: ${model}`).join(", ") || "Same as session"}</dd>
      </dl>
      {here?.kind === "edit-factory" ? <div onChangeCapture={() => setDirty(true)} onClickCapture={(event) => { const button = (event.target as Element).closest("button"); if (button?.getAttribute("aria-label")?.startsWith("Remove ")) setDirty(true); }}>{form}</div> : null}
      <h4>Repositories</h4>
      {here?.kind === "add-repo" ? <div onChangeCapture={() => setDirty(true)}>{form}</div> : null}
      {repos.length === 0 ? <p className="sf-empty">No repos yet.</p> : (
        <ul className="sf-plain-list">
          {repos.map((repo: FactoryRepo) => (
            <li key={repo.repoId} className="sf-actions">
              <span className="sf-mono">{repo.repoId}</span>
              {/^https?:\/\//i.test(repo.remote) ? <a className="sf-muted sf-mono" href={repo.remote} target="_blank" rel="noopener noreferrer">{repo.remote}</a> : <span className="sf-muted sf-mono">{repo.remote}</span>}
              <span className="sf-muted sf-mono">base {repo.baseBranch}</span>
              <button type="button" className="sf-button" aria-label={`Edit repo ${def.factoryId}/${repo.repoId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "edit-repo", repoId: repo.repoId })}>Edit repository</button>
              {here?.kind === "edit-repo" && here.repoId === repo.repoId ? <div onChangeCapture={() => setDirty(true)}>{form}</div> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="sf-actions">
        <button type="button" className="sf-button" aria-label={`Add repo to ${def.factoryId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "add-repo" })}>Add repo</button>
      </div>
      </div>
    </section>
  );
}
