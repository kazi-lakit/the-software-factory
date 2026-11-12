import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TaskView } from "./TaskView";
vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
beforeEach(() => resetFakeBoard());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("opens the description first and puts the requested sections in order", async () => {
  const task = await seedTask({ description: "A useful description" }, "ready");
  renderWithClient(<TaskView taskId={task.taskId} onNavigate={() => {}} />);
  await screen.findByText("A useful description");
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Description", "Spec (0)", "Plan (0)", "Q&A", "Checks", "Review", "Runs (0)", "History"]);
  expect(screen.getByRole("tab", { name: "Description" })).toHaveAttribute("aria-selected", "true");
});
it("the pending question action selects and focuses Q&A", async () => {
  const task = await seedTask({}, "blocked", { question: "Which approach?" });
  renderWithClient(<TaskView taskId={task.taskId} onNavigate={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "View question" }));
  const tab = screen.getByRole("tab", { name: "Q&A" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(tab).toHaveFocus();
  expect(screen.getByText("Which approach?")).toBeVisible();
});
