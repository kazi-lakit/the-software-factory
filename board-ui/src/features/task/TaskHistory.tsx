import type { FactoryEvent } from "@factory/core";
import { describeEvent, eventContexts } from "../../lib/describeEvent";
import { formatTime, formatWhenShort } from "../../lib/formatTime";

/** The task's history as a When / Who / What table, newest first. `events` are oldest first. */
export function TaskHistory({ events, now = new Date() }: { events: readonly FactoryEvent[]; now?: Date }) {
  if (events.length === 0) return <p className="sf-empty">No history yet.</p>;
  const newestFirst = [...events].reverse();
  const contexts = eventContexts(newestFirst);
  return (
    <div className="sf-table-wrap">
      <table className="sf-table" aria-label="History">
        <thead>
          <tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr>
        </thead>
        <tbody>
          {newestFirst.map((event, index) => {
            const description = describeEvent(event, contexts.get(event));
            return (
              <tr key={`${event.at}-${index}`}>
                <td className="sf-nowrap"><time dateTime={event.at} title={formatTime(event.at)}>{formatWhenShort(event.at, now)}</time></td>
                <td>{event.actor}</td>
                <td>
                  {description.parts.map((part, i) =>
                    typeof part === "string" ? part : <span key={i} className="sf-chip">{part.label}</span>
                  )}
                  {event.reason ? <span className="sf-muted"> ({event.reason})</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
