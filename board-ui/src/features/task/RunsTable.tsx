import type { Run } from "@factory/core";
import { formatTime, formatWhenShort } from "../../lib/formatTime";
import { runRows } from "./taskDetails";

/** Every run of the task in start order, one row each. */
export function RunsTable({ now = new Date(), runs }: { now?: Date; runs: readonly Run[] }) {
  if (runs.length === 0) return <p className="sf-empty">No runs yet.</p>;
  return (
    <div className="sf-table-wrap">
      <table className="sf-table" aria-label="Runs">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Status</th>
            <th scope="col">Mode</th>
            <th scope="col">Agent</th>
            <th scope="col">Started</th>
            <th scope="col">Turns</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {runRows(runs).map((row) => (
            <tr key={row.runId}>
              <td>{row.step}</td>
              <td>{row.status}</td>
              <td>{row.mode}</td>
              <td>{row.agent}</td>
              <td className="sf-nowrap"><time dateTime={row.startedAt} title={formatTime(row.startedAt)}>{formatWhenShort(row.startedAt, now)}</time></td>
              <td className="sf-mono">{row.turns}</td>
              <td className="sf-mono">{row.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
