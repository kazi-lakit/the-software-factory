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
  const missing = value.filter((v) => !tasks.some((t) => t.taskId === v));
  if (options.length === 0 && missing.length === 0) return null;
  const toggle = (taskId: string, checked: boolean) =>
    onChange(normalizeDeps(checked ? value.filter((v) => v !== taskId) : [...value, taskId]));
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
              onChange={() => toggle(t.taskId, checked)}
            />
            <span>{t.taskId} · {t.title}</span>
          </label>
        );
      })}
      {missing.map((taskId) => (
        <label key={taskId} className="sf-switch" htmlFor={`${id}-${taskId}`}>
          <input id={`${id}-${taskId}`} type="checkbox" value={taskId} checked onChange={() => toggle(taskId, true)} />
          <span>{taskId} (missing)</span>
        </label>
      ))}
    </fieldset>
  );
}
