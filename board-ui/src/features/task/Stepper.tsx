import type { Status, Task } from "@factory/core";
import { progressLabel, progressSteps, STEPS, type StepState } from "../board/status";

type Props = {
  /** The branch the PR goes into, for the last step's "PR into <base>". */
  baseBranch: string;
  stage: Task["stage"];
  status: Status;
  /** The version of the doc waiting for the owner at the spec or plan gate, when known. */
  waitingVersion?: number;
};

/** The six-step progress of a task: finished steps, the current one, and the one waiting for the owner. */
export function Stepper({ baseBranch, stage, status, waitingVersion }: Props) {
  const states = progressSteps(status, stage);
  const labelOf = (step: string, i: number, state: StepState | undefined): string => {
    if (i === STEPS.length - 1) return `PR into ${baseBranch}`;
    if ((status === "spec_review" && i === 0) || (status === "plan_review" && i === 1)) {
      return `${step} · ${waitingVersion !== undefined ? `v${waitingVersion} ` : ""}waiting`;
    }
    if (status === "blocked" && state === "waiting") return `${step} · question`;
    return step;
  };
  return (
    <ol className="sf-stepper" role="img" aria-label={progressLabel(status, stage)}>
      {STEPS.map((step, i) => {
        const state = states[i];
        const waiting = state === "waiting";
        return (
          <li key={step} className={waiting ? "sf-stepper-item sf-stepper-item-waiting" : "sf-stepper-item"} data-state={state}>
            <span
              className={waiting ? "sf-step sf-stepper-label sf-label sf-stepper-label-waiting" : "sf-step sf-stepper-label sf-label"}
              data-state={state}
            >
              {labelOf(step, i, state)}
              {waiting ? <span className="sf-visually-hidden"> (waiting for you)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
