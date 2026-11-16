import { useId } from "react";
import { ALL_STATUSES, GITHUB_SCHEMA_MISSING, type FactoryHealth, type Status } from "@factory/core";
import type { GitHubDraft } from "./factoryDraft";

type Props = {
  draft: GitHubDraft;
  onChange: (next: GitHubDraft) => void;
  health: FactoryHealth | undefined;
  /** False while the GitHub tables are missing in Blocks Data; undefined while unknown. */
  schemaReady: boolean | undefined;
  /** The stored mode: `github-only` is offered only when it is already stored. */
  storedMode?: GitHubDraft["mode"];
};

/** The factory's GitHub settings: mode, Project, label, approvers and the status map. */
export function GitHubSection({ draft, onChange, health, schemaReady, storedMode }: Props) {
  const ids = useId();
  const set = <K extends keyof GitHubDraft>(key: K, value: GitHubDraft[K]) => onChange({ ...draft, [key]: value });
  const missing = schemaReady === false;
  const problems = health?.githubProblems ?? [];
  const field = (key: "project" | "label" | "approvers", label: string, hint: string) => (
    <div className="sf-field">
      <label className="sf-field-label" htmlFor={`${ids}-${key}`}>{label}</label>
      <input id={`${ids}-${key}`} className="sf-input" value={draft[key]} onChange={(event) => set(key, event.target.value)} aria-describedby={`${ids}-${key}-hint`} />
      <span id={`${ids}-${key}-hint`} className="sf-hint">{hint}</span>
    </div>
  );

  return (
    <fieldset className="sf-fieldset sf-github">
      <legend>GitHub</legend>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-mode`}>GitHub mode</label>
        <select id={`${ids}-mode`} className="sf-select" value={draft.mode} disabled={missing} onChange={(event) => set("mode", event.target.value as GitHubDraft["mode"])}>
          <option value="off">Off</option>
          <option value="connected">Connected</option>
          {storedMode === "github-only" ? <option value="github-only" disabled>GitHub only</option> : null}
        </select>
        <span className="sf-hint">Connected keeps the factory's tasks and a GitHub Project in step. Off leaves GitHub alone.</span>
      </div>
      {missing ? <p className="sf-hint">{GITHUB_SCHEMA_MISSING}</p> : draft.mode === "off" ? null : (
        <>
          {field("project", "Project", "The GitHub Project as owner/number, for example acme/3.")}
          {field("label", "Label", "Only issues with this label are pulled in. Empty pulls every issue of the Project.")}
          {field("approvers", "Approvers", "GitHub logins whose approval counts, separated by commas. Empty uses the GitHub login above.")}
          {problems.length > 0 ? (
            <div className="sf-problem" role="status">
              <p>The factory machine reports:</p>
              <ul className="sf-plain-list">{problems.map((p, i) => <li key={`${i}-${p}`}>{p}</li>)}</ul>
            </div>
          ) : null}
          {!health?.watcherSeenAt ? <span className="sf-hint">The factory machine checks these names when factory sync --watch --store blocks runs.</span> : null}
          <div className="sf-table-wrap">
            <table className="sf-table sf-status-map">
              <caption className="sf-visually-hidden">Status map</caption>
              <thead><tr><th scope="col">Factory status</th><th scope="col">Project Status option</th></tr></thead>
              <tbody>
                {ALL_STATUSES.map((status: Status) => (
                  <tr key={status}>
                    <th scope="row" className="sf-mono">{status}</th>
                    <td><input className="sf-input" aria-label={`${status} option`} value={draft.statusMap[status]} onChange={(event) => set("statusMap", { ...draft.statusMap, [status]: event.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="sf-hint">The Project Status option each factory status shows as. Inbox and Ready need options of their own.</span>
        </>
      )}
    </fieldset>
  );
}
