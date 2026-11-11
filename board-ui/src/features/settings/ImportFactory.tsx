import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ChangeEvent } from "react";
import { importFactory, planImport, validateImportFile, type ImportAction, type ImportFile, type ImportPlan, type ImportPlanRow, type ImportResult } from "@factory/core";
import { boardStore } from "../../lib/board";
import { FACTORIES_KEY } from "../factories/useFactories";
import { HISTORY_KEY } from "../history/useHistory";
import { describeWriteError, now, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { SETTINGS_KEY } from "./useSettings";

type Review = { file: ImportFile; legacy: string[]; plan: ImportPlan };

const ACTION_TEXT: Record<ImportAction, string> = { already: "already there", create: "will be created", kept: "exists and differs; it is kept as it is" };
const actionText = (row: ImportPlanRow) => (row.action === "kept" && row.differs.length > 0 ? `${ACTION_TEXT.kept} (${row.differs.join(", ")})` : ACTION_TEXT[row.action]);

const OUTCOME_TEXT = { already: "already there", created: "created", kept: "kept (differs from the file)" } as const;

/**
 * Imports the JSON `factory migrate --export` wrote: pick or paste it, review what it creates, confirm. The owner's
 * session does the writes (repos, then the definition, then the legacy settings move). Repeating it is safe.
 */
export function ImportFactory({ heading = true, onClose }: { heading?: boolean; onClose: () => void }) {
  const ids = useId();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Review>();
  const [problem, setProblem] = useState<WriteProblem>();
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setText(await readText(file));
      setError("");
      setPlan(undefined);
    } catch {
      setError("Could not read that file.");
    }
  }

  async function review() {
    setPlan(undefined);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setError("The import is not valid JSON.");
      return;
    }
    const checked = validateImportFile(json);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError("");
    // Only a note on the review: when the status cannot be read, the import still says what it moved.
    const status = await boardStore.legacySettingsStatus().catch(() => ({ unmoved: [] as string[], unretired: [] as string[] }));
    try {
      // The same comparison the import itself acts on, over the stored rows.
      setPlan({ file: checked.value, legacy: [...status.unmoved, ...status.unretired], plan: await planImport(boardStore, checked.value) });
    } catch (e) {
      setError(describeWriteError(e).message);
    }
  }

  async function confirm() {
    if (!plan || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      setResult(await importFactory(boardStore, now, plan.file));
      setPlan(undefined);
      await Promise.all([
        client.invalidateQueries({ queryKey: FACTORIES_KEY }),
        client.invalidateQueries({ queryKey: SETTINGS_KEY }),
        client.invalidateQueries({ queryKey: HISTORY_KEY })
      ]);
    } catch (e) {
      setProblem(describeWriteError(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="sf-panel sf-import" aria-label="Import result">
        <h3>Import finished</h3>
        <ul className="sf-plain-list">
          <li>Factory: {OUTCOME_TEXT[result.factory]}.</li>
          {result.repos.map((r) => <li key={r.repoId}><span className="sf-mono">{r.repoId}</span>: {OUTCOME_TEXT[r.outcome]}.</li>)}
          <li>Legacy settings moved: {result.settingsMoved.join(", ") || "none"}.</li>
          {result.settingsNotMoved.length > 0 ? <li>Legacy settings not moved (no readable value): {result.settingsNotMoved.join(", ")}.</li> : null}
          <li>Legacy settings retired: {result.retired.join(", ") || "none"}.</li>
          <li>Legacy settings left: {result.remaining.join(", ") || "none"}.</li>
        </ul>
        {result.remaining.length > 0 ? <p className="sf-hint">Left rows have no value under the new scopes yet. Import again after fixing the factory.</p> : null}
        <div className="sf-actions"><button type="button" className="sf-button" onClick={onClose}>Done</button></div>
      </section>
    );
  }

  return (
    <section className="sf-panel sf-form sf-import" aria-label="Import factory">
      {heading ? <h3>Import factory</h3> : null}
      <p className="sf-hint">Use the file written by <span className="sf-mono">factory migrate --export</span>. It holds no secrets.</p>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-file`}>Import file</label>
        <input id={`${ids}-file`} type="file" accept=".json,application/json" onChange={(event) => void pick(event)} />
      </div>
      <div className="sf-field">
        <label className="sf-field-label" htmlFor={`${ids}-text`}>Or paste the JSON</label>
        <textarea id={`${ids}-text`} className="sf-input sf-mono" rows={8} value={text} onChange={(event) => { setText(event.target.value); setPlan(undefined); }} />
      </div>
      {error ? <p className="sf-problem" role="alert">{error}</p> : null}
      {plan ? (
        <div className="sf-panel" role="region" aria-label="Import review">
          <p>
            Factory <strong>{plan.file.factory.name}</strong> (<span className="sf-mono">{plan.file.factory.factoryId}</span>) {actionText(plan.plan.factory)}.
          </p>
          <ul className="sf-plain-list">
            {plan.plan.repos.map((r) => <li key={r.repoId}><span className="sf-mono">{r.repoId}</span> {actionText(r)}.</li>)}
          </ul>
          {plan.file.factory.factoryId === "blocks" ? (
            <p className="sf-hint">
              {plan.legacy.length > 0 ? `Settings saved before factories (${plan.legacy.join(", ")}) move under blocks, then those rows are retired.` : "No settings from before factories are left to move."}
            </p>
          ) : null}
          <p>Nothing is written until you confirm.</p>
          <WriteProblemNotice problem={problem} />
          <div className="sf-actions">
            <button type="button" className="sf-button sf-button-primary" disabled={busy} onClick={() => void confirm()}>Confirm import</button>
          </div>
        </div>
      ) : (
        <div className="sf-actions">
          <button type="button" className="sf-button sf-button-primary" disabled={text.trim() === ""} onClick={() => void review()}>Review import</button>
          <button type="button" className="sf-button" onClick={onClose}>Cancel</button>
        </div>
      )}
    </section>
  );
}

/** Blob.text where the browser has it; FileReader otherwise. */
function readText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
