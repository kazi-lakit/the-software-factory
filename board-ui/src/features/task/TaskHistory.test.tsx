import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { STATUS_LABEL } from "../board/status";
import { TaskHistory } from "./TaskHistory";

const now = new Date(2026, 10, 12, 18, 0);

const event = (at: Date, rest: Partial<FactoryEvent> = {}): FactoryEvent => ({
  action: "move",
  actor: "core",
  at: at.toISOString(),
  factoryId: "blocks",
  field: "status",
  from: "ready",
  reason: "",
  taskId: "T-1",
  to: "spec",
  ...rest
});

const bodyRows = () => within(screen.getByRole("table", { name: "History" })).getAllByRole("row").slice(1);

afterEach(cleanup);

describe("TaskHistory", () => {
  it("shows_when_who_what_newest_first", () => {
    const events = [
      event(new Date(2026, 10, 12, 9, 0), { actor: "you", from: "inbox", reason: "marked ready", to: "ready" }),
      event(new Date(2026, 10, 12, 10, 0), { actor: "core", reason: "claimed" })
    ];
    render(<TaskHistory events={events} now={now} />);
    const table = screen.getByRole("table", { name: "History" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Who", "What"]);
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getAllByRole("cell")[1]).toHaveTextContent("core");
    expect(rows[0]).toHaveTextContent("claimed");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent("you");
    expect(rows[1]).toHaveTextContent("Marked ready");
  });

  it("when_reads_HH_MM_today_and_Yesterday_HH_MM_otherwise", () => {
    const today = event(new Date(2026, 10, 12, 10, 42));
    const yesterday = event(new Date(2026, 10, 11, 17, 5));
    const { container } = render(<TaskHistory events={[yesterday, today]} now={now} />);
    const times = [...container.querySelectorAll("time")];
    expect(times.map((t) => t.textContent)).toEqual(["10:42", "Yesterday 17:05"]);
    expect(times[0]).toHaveAttribute("dateTime", today.at);
    expect(times[1]).toHaveAttribute("dateTime", yesterday.at);
    for (const time of times) expect(time.getAttribute("title")).toBeTruthy();
  });

  it("what_uses_describeEvent_with_status_chips_and_reason", () => {
    const events = [
      event(new Date(2026, 10, 12, 9, 0), { from: "spec", reason: "spec written", to: "spec_review" }),
      event(new Date(2026, 10, 12, 10, 0), { from: "spec_review", reason: "looks odd", to: "plan" })
    ];
    render(<TaskHistory events={events} now={now} />);
    const [newest, oldest] = bodyRows();
    expect(newest!.querySelector(".sf-chip")?.textContent).toBe(STATUS_LABEL.plan);
    expect(newest!.querySelector(".sf-muted")?.textContent).toContain("looks odd");
    expect(oldest).toHaveTextContent("Spec v1 written");
  });

  it("says_no_history_yet", () => {
    render(<TaskHistory events={[]} now={now} />);
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });
});
