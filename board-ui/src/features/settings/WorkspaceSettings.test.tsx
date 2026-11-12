import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksFactories, factory, merge } from "../../test/factories";
import { renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { SettingsView } from "./SettingsView";
vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
beforeEach(() => { window.history.replaceState({}, "", "/settings"); window.localStorage.clear(); resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"]))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });
it("keeps edits across sections and asks before changing factory", async () => {
  renderWithClient(<SettingsView />);
  const picker = await screen.findByLabelText("Editing factory");
  fireEvent.click(screen.getByRole("tab", { name: "Gates & limits" }));
  const input = await screen.findByLabelText("Tasks at once");
  fireEvent.change(input, { target: { value: "4" } });
  fireEvent.click(screen.getByRole("tab", { name: "General" }));
  fireEvent.click(screen.getByRole("tab", { name: "Gates & limits" }));
  expect(screen.getByLabelText("Tasks at once")).toHaveValue("4");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const previous = (picker as HTMLSelectElement).value;
  fireEvent.change(picker, { target: { value: previous === "delta" ? "blocks" : "delta" } });
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(picker).toHaveValue(previous);
  expect(screen.getByLabelText("Tasks at once")).toHaveValue("4");
});
it("opens legacy settings fragments", async () => {
  window.history.replaceState({}, "", "/settings#settings-repos");
  renderWithClient(<SettingsView />);
  expect(await screen.findByRole("table", { name: "Repos" })).toBeVisible();
});
