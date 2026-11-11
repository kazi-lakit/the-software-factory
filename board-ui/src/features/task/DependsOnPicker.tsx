import { normalizeDeps, type Task } from "@factory/core";

type Props = {
  factoryId: string;
  id: string;
  /** The field's label; the Edit task form keeps the default. */
  label?: string;
  onChange: (ids: string[]) => void;
  selfId?: string;
  tasks: readonly Task[];
  value: readonly string[];
};

/**
 * The tasks this one waits on: a dropdown of the open tasks of the same factory not yet picked, and the picked ones
 * (including finished or missing ones already selected) as removable chips.
 */
export function DependsOnPicker({ factoryId, id, label = "Depends on", onChange, selfId, tasks, value }: Props) {
  const options = tasks.filter(
    (t) => t.factoryId === factoryId && t.taskId !== selfId && (value.includes(t.taskId) || t.status !== "done" && t.status !== "cancelled")
  );
  const missing = value.filter((v) => !tasks.some((t) => t.taskId === v));
  if (options.length === 0 && missing.length === 0) return null;
  const pickable = options.filter((t) => !value.includes(t.taskId));
  const chipText = (taskId: string) => {
    const t = tasks.find((x) => x.taskId === taskId);
    return t ? `${t.taskId} · ${t.title}` : `${taskId} (missing)`;
  };
  return (
    <div className="sf-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="sf-select"
        value=""
        onChange={(event) => {
          const picked = event.target.value;
          if (picked) onChange(normalizeDeps([...value, picked]));
        }}
      >
        <option value="">Pick a task</option>
        {pickable.map((t) => <option key={t.taskId} value={t.taskId}>{t.taskId} · {t.title}</option>)}
      </select>
      {value.length > 0 ? (
        <ul className="sf-chips">
          {value.map((taskId) => (
            <li key={taskId} className="sf-chip">
              <span>{chipText(taskId)}</span>
              <button
                type="button"
                className="sf-chip-remove"
                aria-label={`Remove ${taskId}`}
                onClick={() => onChange(normalizeDeps(value.filter((v) => v !== taskId)))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
