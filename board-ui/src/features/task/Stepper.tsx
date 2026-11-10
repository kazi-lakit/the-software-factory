import type { Status, Task } from "@factory/core";
import { progressLabel, progressSteps, STEPS } from "../board/status";

/** The six-step progress of a task: finished steps, the current one, and the one waiting for the owner. */
export function Stepper({ stage, status }: { stage: Task["stage"]; status: Status }) {
  const states = progressSteps(status, stage);
  return (
    <ol className="sf-stepper" role="img" aria-label={progressLabel(status, stage)}>
      {STEPS.map((step, i) => {
        const state = states[i];
        const waiting = state === "waiting";
        return (
          <li key={step} className={waiting ? "sf-stepper-item sf-stepper-item-waiting" : "sf-stepper-item"} data-state={state}>
            <span className="sf-step" data-state={state} />
            <span className={waiting ? "sf-stepper-label sf-label sf-stepper-label-waiting" : "sf-stepper-label sf-label"}>
              {step}
              {waiting ? <span className="sf-visually-hidden"> (waiting for you)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
