import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FactoryHealth, FactoryRepo } from "@factory/core";
import { FACTORIES_KEY, useFactories, useFactoryHealth, type FactoryEntry } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { FactoryForm } from "./FactoryForm";
import { ImportFactory } from "./ImportFactory";
import { RepoForm } from "./RepoForm";
import { formatTime } from "../../lib/formatTime";

type Editing =
  | { kind: "add-factory" }
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

/** Factories and their repos: list, add, edit, import, and the definitions the Board cannot use. */
export function FactoriesSection() {
  const client = useQueryClient();
  const factories = useFactories();
  const health = useFactoryHealth();
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState("");

  const entries = [...factories.byId.values()];
  const healthOf = (factoryId: string) => health.data?.find((h) => h.factoryId === factoryId);
  const close = () => setEditing(undefined);

  /** Refetches the definitions and returns what is stored now. */
  async function reload<T>(pick: (entries: FactoryEntry[]) => T | undefined): Promise<T | undefined> {
    const result = await factories.refetch();
    return pick(result.data?.entries ?? []);
  }

  async function saved(text: string) {
    setNotice(text);
    close();
    await Promise.all([client.invalidateQueries({ queryKey: FACTORIES_KEY }), client.invalidateQueries({ queryKey: HISTORY_KEY })]);
  }

  // The page shows the loading and load-error messages once, above the sections; a failed load leaves a short note here.
  if (factories.loading) return null;
  if (factories.error && entries.length === 0) return <p className="sf-empty">Settings are not available.</p>;

  const form = (() => {
    if (!editing) return null;
    switch (editing.kind) {
      case "add-factory":
        return <FactoryForm key="add" before={null} onCancel={close} onReload={async () => undefined} onSaved={(d) => void saved(`Created factory ${d.factoryId}.`)} />;
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
        return <ImportFactory onClose={close} />;
    }
  })();

  return (
    <>
      <div className="sf-toolbar">
        <button type="button" className="sf-button" onClick={() => setEditing({ kind: "add-factory" })}>Add factory</button>
        <button type="button" className="sf-button" onClick={() => setEditing({ kind: "import" })}>Import factory</button>
      </div>
      <p className="sf-muted" role="status">{notice}</p>
      {health.isError ? <p className="sf-hint">Could not read the gh login checks; they show as unknown.</p> : null}
      {form && !(editing?.kind === "edit-factory" || editing?.kind === "edit-repo" || editing?.kind === "add-repo") ? form : null}

      {entries.length === 0 ? <p className="sf-empty">No factory is set up yet. Add one, or import the file from <span className="sf-mono">factory migrate --export</span>.</p> : null}
      {entries.map((entry) => (
        <FactorySection
          key={entry.def.factoryId}
          entry={entry}
          health={healthOf(entry.def.factoryId)}
          editing={editing}
          form={form}
          onEdit={setEditing}
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

function FactorySection({ editing, entry, form, health, onEdit }: {
  editing: Editing | undefined; entry: FactoryEntry; form: React.ReactNode; health: FactoryHealth | undefined; onEdit: (e: Editing) => void;
}) {
  const { def, repos } = entry;
  const here = editing && "factoryId" in editing && editing.factoryId === def.factoryId ? editing : undefined;
  return (
    <section className="sf-factory-row" aria-label={`Factory ${def.factoryId}`}>
      <div className="sf-actions">
        <h3>{def.name}</h3>
        <span className="sf-mono">{`GitHub login ${def.ghUser}`}</span>
        <GhStatus health={health} />
        <button type="button" className="sf-button" aria-label={`Edit factory ${def.factoryId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "edit-factory" })}>Edit</button>
      </div>
      <dl className="sf-facts">
        <dt>Id</dt>
        <dd className="sf-mono">{def.factoryId}</dd>
        <dt>State</dt>
        <dd className={def.active ? "sf-status-on" : "sf-muted"}>{def.active ? "Active" : "Inactive"}</dd>
        <dt>Protected branches</dt>
        <dd className="sf-mono">{def.protectedBranches.join(", ")}</dd>
      </dl>
      {here?.kind === "edit-factory" ? form : null}
      <h4>Repos</h4>
      {repos.length === 0 ? <p className="sf-empty">No repos yet.</p> : (
        <ul className="sf-plain-list">
          {repos.map((repo: FactoryRepo) => (
            <li key={repo.repoId} className="sf-actions">
              <span className="sf-mono">{repo.repoId}</span>
              <span className="sf-muted sf-mono">{repo.remote}</span>
              <span className="sf-muted sf-mono">base {repo.baseBranch}</span>
              <button type="button" className="sf-button" aria-label={`Edit repo ${def.factoryId}/${repo.repoId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "edit-repo", repoId: repo.repoId })}>Edit</button>
            </li>
          ))}
        </ul>
      )}
      {here?.kind === "edit-repo" || here?.kind === "add-repo" ? form : null}
      <div className="sf-actions">
        <button type="button" className="sf-button" aria-label={`Add repo to ${def.factoryId}`} onClick={() => onEdit({ factoryId: def.factoryId, kind: "add-repo" })}>Add repo</button>
      </div>
    </section>
  );
}
