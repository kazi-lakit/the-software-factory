import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_SCHEMA_MISSING } from "@factory/core";
import { blocksFactories } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { FactoryForm } from "./FactoryForm";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const owner = () => fakeBoard().owner;

async function openForm() {
  const before = (await owner().listFactoryDefs()).find((d) => d.factoryId === "blocks")!;
  const onSaved = vi.fn();
  renderWithClient(<FactoryForm before={before} onCancel={() => {}} onReload={async () => before} onSaved={onSaved} />);
  await screen.findByRole("group", { name: "GitHub" });
  return onSaved;
}

const connect = () => fireEvent.change(screen.getByLabelText("GitHub mode"), { target: { value: "connected" } });

beforeEach(() => { resetFakeBoard(blocksFactories()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GitHub section", () => {
  it("turning_connected_on_shows_the_prefilled_status_map_and_saves_a_valid_def", async () => {
    const onSaved = await openForm();
    expect(screen.queryByLabelText("Project")).toBeNull();
    connect();
    expect(screen.getAllByLabelText(/ option$/)).toHaveLength(13);
    expect(screen.getByLabelText("done option")).toHaveValue("Merged");
    expect(screen.getByLabelText("Label")).toHaveValue("factory");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "o/3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save factory" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const stored = (await owner().listFactoryDefs()).find((d) => d.factoryId === "blocks")!;
    expect(stored.github).toMatchObject({ mode: "connected", project: { owner: "o", number: 3 }, statusMap: { done: "Merged" } });
  });

  it("an_invalid_map_shows_the_cores_message", async () => {
    await openForm();
    connect();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "o/3" } });
    fireEvent.change(screen.getByLabelText("ready option"), { target: { value: "Backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Save factory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("github.statusMap: inbox and ready must map to different options");
  });

  it("the_watchers_problems_show_above_the_table", async () => {
    await fakeBoard().core.setFactoryHealth({ checkedAt: "2026-11-10T08:00:00.000Z", factoryId: "blocks", ghLoggedIn: true, watcherSeenAt: "2026-11-10T08:00:00.000Z", githubProblems: ["Project 3 has no Status option Merged"] });
    await openForm();
    connect();
    const problem = await screen.findByText("Project 3 has no Status option Merged");
    expect(screen.getByText("The factory machine reports:")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(problem.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/checks these names when/)).toBeNull();
  });

  it("without_a_watcher_the_hint_names_the_command", async () => {
    await openForm();
    connect();
    expect(screen.getByText("The factory machine checks these names when factory sync --watch --store blocks runs.")).toBeInTheDocument();
  });

  it("a_missing_schema_shows_the_message_and_the_rest_of_the_form_saves", async () => {
    vi.spyOn(owner(), "githubSchemaReady").mockResolvedValue(false);
    const onSaved = await openForm();
    expect(await screen.findByText(GITHUB_SCHEMA_MISSING)).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub mode")).toBeDisabled();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save factory" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(within(document.body).queryByRole("alert")).toBeNull();
  });
});
