import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { followInApp } from "../board/TaskCard";
import { FACTORIES_KEY } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { TaskTabs } from "../task/TaskTabs";
import { WriteProblemNotice } from "../task/writeOutcome";
import { addProtectedBranch, draftOf, useFactorySave, type Draft } from "./factoryDraft";
import { idFromName } from "./factoryId";
import { ImportFactory } from "./ImportFactory";

type Navigate = (path: string) => void;

/** /settings/factories/new: set a factory up from a form, or import the file `factory migrate --export` wrote. */
export function NewFactoryPage({ onNavigate }: { onNavigate: Navigate }) {
  return (
    <div className="sf-view sf-new-factory">
      <nav aria-label="Breadcrumb" className="sf-breadcrumb">
        <a href="/settings" onClick={(event) => followInApp(event, "/settings", onNavigate)}>Settings</a>
        <span> / </span>
        <a href="/settings#settings-factories" onClick={(event) => followInApp(event, "/settings#settings-factories", onNavigate)}>Factories</a>
        <span> / New factory</span>
      </nav>
      <h1 className="sf-page-title">New factory</h1>
      <TaskTabs
        label="New factory"
        tabs={[
          { id: "setup", label: "Set it up", content: <SetUpFactory onNavigate={onNavigate} /> },
          { id: "import", label: "Import from a file", content: <ImportFactory heading={false} onClose={() => onNavigate("/settings")} /> }
        ]}
      />
    </div>
  );
}

type TextKey = "docsPath" | "factoryId" | "ghUser" | "gitEmail" | "gitName" | "name";

function SetUpFactory({ onNavigate }: { onNavigate: Navigate }) {
  const ids = useId();
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(null));
  // The id follows the name until the owner types in the id field.
  const [idEdited, setIdEdited] = useState(false);
  const [branch, setBranch] = useState("");
  const saving = useFactorySave({
    base: null,
    onSaved: () =>
      void Promise.all([client.invalidateQueries({ queryKey: FACTORIES_KEY }), client.invalidateQueries({ queryKey: HISTORY_KEY })]).then(() => onNavigate("/settings"))
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function change(key: TextKey, value: string) {
    if (key === "name") setDraft((d) => ({ ...d, name: value, factoryId: idEdited ? d.factoryId : idFromName(value) }));
    else set(key, value);
    if (key === "factoryId") setIdEdited(true);
  }

  function addBranch() {
    set("protectedBranches", addProtectedBranch(draft.protectedBranches, branch));
    setBranch("");
  }

  const field = (key: Exclude<TextKey, "factoryId">, label: string, hint?: string) => (
    <div className="sf-field">
      <label className="sf-field-label" htmlFor={`${ids}-${key}`}>{label}</label>
      <input id={`${ids}-${key}`} className="sf-input" value={draft[key]} onChange={(event) => change(key, event.target.value)} aria-describedby={hint ? `${ids}-${key}-hint` : undefined} />
      {hint ? <span id={`${ids}-${key}-hint`} className="sf-hint">{hint}</span> : null}
    </div>
  );

  const section = (key: string, title: string, children: React.ReactNode) => (
    <section className="sf-new-factory-section" aria-labelledby={`${ids}-${key}-h`}>
      <h2 id={`${ids}-${key}-h`}>{title}</h2>
      {children}
    </section>
  );

  return (
    <div className="sf-new-factory-body">
      <form
        className="sf-form sf-panel"
        aria-label="New factory"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void saving.save(draft);
        }}
      >
        {section("name", "Name it", (
          <>
            {field("name", "Name", "Shown on the Board and in the factory filter.")}
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-factoryId`}>Factory id</label>
              <input
                id={`${ids}-factoryId`}
                className="sf-input sf-mono"
                value={draft.factoryId}
                onChange={(event) => change("factoryId", event.target.value)}
                aria-describedby={`${ids}-factoryId-hint`}
              />
              <span id={`${ids}-factoryId-hint`} className="sf-hint">Lowercase letters, digits and hyphens, starting with a letter. It can't change later.</span>
            </div>
            <label className="sf-switch">
              <input type="checkbox" role="switch" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
              <span>Active: the factory takes new work as soon as it's saved</span>
            </label>
          </>
        ))}
        {section("github", "GitHub", (
          <>
            {field("ghUser", "GitHub login", "The gh account the factory opens PRs with. Run gh auth login on this Mac first; the Board stores the login, never a token.")}
            {field("gitName", "Commit name")}
            {field("gitEmail", "Commit email", "Used on every commit the factory makes.")}
          </>
        ))}
        {section("branches", "Protected branches", (
          <>
            <p className="sf-hint">The factory never pushes to these. Work reaches them only through a PR you merge.</p>
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
            <div className="sf-field">
              <label className="sf-field-label" htmlFor={`${ids}-branch`}>Add a branch</label>
              <div className="sf-actions">
                <input
                  id={`${ids}-branch`}
                  className="sf-input sf-mono"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addBranch();
                    }
                  }}
                />
                <button type="button" className="sf-button" onClick={addBranch}>Add</button>
              </div>
            </div>
          </>
        ))}
        {section("reading", "Background reading", field("docsPath", "Docs folder", "The spec writer reads each repo's overview here. Read only: nothing in the factory writes to it."))}
        {saving.invalidText ? <p className="sf-problem" role="alert">{saving.invalidText}</p> : null}
        <WriteProblemNotice problem={saving.problem} />
        <div className="sf-actions sf-action-bar">
          <button type="submit" className="sf-button sf-button-primary" disabled={saving.busy}>Create factory</button>
          <button type="button" className="sf-button" onClick={() => onNavigate("/settings")}>Cancel</button>
        </div>
        <p className="sf-hint">
          {draft.name.trim() || "The factory"} starts with the global gates and limits; change them in{" "}
          <a href="/settings" onClick={(event) => followInApp(event, "/settings", onNavigate)}>Settings</a>.
        </p>
      </form>
      <FactorySummary draft={draft} />
    </div>
  );
}

const DASH = "—";

/** What the form will create, kept in step with it as the owner types. */
function FactorySummary({ draft }: { draft: Draft }) {
  const heading = useId();
  const name = draft.name.trim();
  const id = draft.factoryId.trim();
  const gitName = draft.gitName.trim();
  const gitEmail = draft.gitEmail.trim();
  const commits = gitName && gitEmail ? `${gitName} <${gitEmail}>` : gitName || (gitEmail ? `<${gitEmail}>` : DASH);
  return (
    <aside className="sf-panel sf-new-task-aside sf-new-factory-aside" aria-labelledby={heading}>
      <h2 id={heading}>Summary</h2>
      <dl className="sf-facts">
        <dt>Name (id)</dt>
        <dd>{name && id ? `${name} (${id})` : name || id || DASH}</dd>
        <dt>Opens PRs as</dt>
        <dd className="sf-mono">{draft.ghUser.trim() || DASH}</dd>
        <dt>Commits as</dt>
        <dd>{commits}</dd>
        <dt>Protected</dt>
        <dd className="sf-mono">{draft.protectedBranches.join(", ")}</dd>
        <dt>Starts</dt>
        <dd>{draft.active ? "Active" : "Paused"}</dd>
      </dl>
      <p className="sf-hint">After you create it, the Board's factory filter shows it, and new tasks can be made for it.</p>
    </aside>
  );
}
