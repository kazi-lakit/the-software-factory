import { normalizeDeps, type Task } from "@factory/core";

type Props = {
  factoryId: string;
  id: string;
  onChange: (ids: string[]) => void;
  selfId?: string;
  tasks: readonly Task[];
  value: readonly string[];
};

/** Checkboxes for the tasks this one waits on: open tasks of the same factory, plus any already selected. */
export function DependsOnPicker({ factoryId, id, onChange, selfId, tasks, value }: Props) {
  const options = tasks.filter(
    (t) => t.factoryId === factoryId && t.taskId !== selfId && (value.includes(t.taskId) || t.status !== "done" && t.status !== "cancelled")
  );
  if (options.length === 0) return null;
  return (
    <fieldset className="sf-fieldset">
      <legend>Depends on</legend>
      {options.map((t) => {
        const checked = value.includes(t.taskId);
        return (
          <label key={t.taskId} className="sf-switch" htmlFor={`${id}-${t.taskId}`}>
            <input
              id={`${id}-${t.taskId}`}
              type="checkbox"
              value={t.taskId}
              checked={checked}
              onChange={() => onChange(normalizeDeps(checked ? value.filter((v) => v !== t.taskId) : [...value, t.taskId]))}
            />
            <span>{t.taskId} · {t.title}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
