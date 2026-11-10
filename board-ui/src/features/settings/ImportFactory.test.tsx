import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defFixture, repoFixture, seedBlocksFactories } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { SettingsView } from "./SettingsView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const owner = () => fakeBoard().owner;
const importJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ factory: defFixture("blocks", { name: "Blocks" }), format: "factory-import/1", repos: [repoFixture("blocks", "data"), repoFixture("blocks", "os")], ...over });

async function openImport() {
  renderWithClient(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Factories" }));
  fireEvent.click(await screen.findByRole("button", { name: "Import factory" }));
  return screen.findByRole("region", { name: "Import factory" });
}

const paste = (text: string) => fireEvent.change(screen.getByLabelText("Or paste the JSON"), { target: { value: text } });

beforeEach(() => {
  resetFakeBoard({ defs: [], repos: [] });
  const data = fakeBoard().ownerData;
  data.seed("FactorySettings", { json: JSON.stringify({ paused: true }), scope: "global", version: 1 });
  data.seed("FactorySettings", { json: JSON.stringify({ maxParallel: 1 }), scope: "data", version: 1 });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Import factory", () => {
  it("shows_what_will_be_created_and_writes_nothing_until_confirmed", async () => {
    const saveDef = vi.spyOn(owner(), "saveFactoryDef");
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    const review = await screen.findByRole("region", { name: "Import review" });
    expect(review).toHaveTextContent("Factory Blocks (blocks) will be created.");
    expect(within(review).getByText("data").closest("li")).toHaveTextContent("will be created");
    expect(within(review).getByText("os").closest("li")).toHaveTextContent("will be created");
    expect(review).toHaveTextContent("Settings saved before factories (global, data) move under blocks");
    expect(saveDef).not.toHaveBeenCalled();
    expect(await owner().listFactoryDefs()).toEqual([]);
  });

  it("creates_the_repos_and_the_factory_moves_the_settings_and_shows_a_summary", async () => {
    const before = await owner().getSettings();
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    const result = await screen.findByRole("region", { name: "Import result" });
    expect(result).toHaveTextContent("Factory: created.");
    expect(result).toHaveTextContent("data: created.");
    expect(result).toHaveTextContent("Legacy settings moved: data, global.");
    expect(result).toHaveTextContent("Legacy settings retired: data, global.");
    expect(result).toHaveTextContent("Legacy settings left: none.");
    expect((await owner().listFactoryDefs()).map((d) => d.factoryId)).toEqual(["blocks"]);
    expect((await owner().listFactoryRepos("blocks")).map((r) => r.repoId).sort()).toEqual(["data", "os"]);
    expect(await owner().getSettings()).toEqual(before);
    expect(await owner().legacySettingsStatus()).toEqual({ unmoved: [], unretired: [] });
    // The new factory is listed once the dialog is closed.
    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("region", { name: "Factory blocks" })).toBeInTheDocument();
  });

  it("is_safe_to_run_again_and_reports_everything_as_already_there", async () => {
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    fireEvent.click(within(await screen.findByRole("region", { name: "Import result" })).getByRole("button", { name: "Done" }));
    const events = (await owner().listEvents("-")).length;

    fireEvent.click(await screen.findByRole("button", { name: "Import factory" }));
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    const review = await screen.findByRole("region", { name: "Import review" });
    expect(review).toHaveTextContent("Factory Blocks (blocks) already there.");
    expect(review).toHaveTextContent("No settings from before factories are left to move.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    const result = await screen.findByRole("region", { name: "Import result" });
    expect(result).toHaveTextContent("Factory: already there.");
    expect(result).toHaveTextContent("Legacy settings moved: none.");
    expect((await owner().listEvents("-")).length).toBe(events);
  });

  it("resumes_after_a_run_that_stopped_before_the_definition_was_saved", async () => {
    vi.spyOn(owner(), "saveFactoryDef").mockRejectedValueOnce(new Error("blocks: unavailable"));
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("blocks: unavailable");
    expect(await owner().listFactoryDefs()).toEqual([]);
    expect(await owner().listFactoryRepos("blocks")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    const result = await screen.findByRole("region", { name: "Import result" });
    expect(result).toHaveTextContent("Factory: created.");
    expect(result).toHaveTextContent("data: already there.");
    expect(await owner().listFactoryDefs()).toHaveLength(1);
  });

  it.each([
    ["text that is not JSON", "{nope", "The import is not valid JSON."],
    ["a file of another format", JSON.stringify({ format: "other/1" }), "format must be factory-import/1"],
    ["a repo with no remote", importJson({ repos: [{ ...repoFixture("blocks", "data"), remote: "" }] }), "repos[0]: remote must not be blank"]
  ])("refuses_%s_and_writes_nothing", async (_what, text, message) => {
    await openImport();
    paste(text);
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Confirm import" })).not.toBeInTheDocument();
    expect(await owner().listFactoryDefs()).toEqual([]);
  });

  it("reads_a_picked_file_into_the_paste_box", async () => {
    await openImport();
    const file = new File([importJson()], "factory-import.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import file"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("Or paste the JSON")).toHaveValue(importJson()));
  });

  it("previews_the_resume_case_from_the_stored_rows_and_the_import_then_does_the_same", async () => {
    seedBlocksFactories(fakeBoard().ownerData, { defs: [], repos: [repoFixture("blocks", "data"), repoFixture("blocks", "os")] });
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    const review = await screen.findByRole("region", { name: "Import review" });
    expect(review).toHaveTextContent("Factory Blocks (blocks) will be created.");
    expect(within(review).getByText("data").closest("li")).toHaveTextContent("already there");
    expect(within(review).getByText("os").closest("li")).toHaveTextContent("already there");
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    const result = await screen.findByRole("region", { name: "Import result" });
    expect(result).toHaveTextContent("Factory: created.");
    expect(result).toHaveTextContent("data: already there.");
  });

  it("previews_a_stored_definition_that_fails_validation_as_kept", async () => {
    seedBlocksFactories(fakeBoard().ownerData, { defs: [defFixture("blocks", { gitEmail: "not-an-email", name: "Blocks" })], repos: [] });
    await openImport();
    paste(importJson());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    const review = await screen.findByRole("region", { name: "Import review" });
    expect(review).toHaveTextContent("exists and differs; it is kept as it is (gitEmail)");
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("region", { name: "Import result" })).toHaveTextContent("Factory: kept (differs from the file).");
  });
});
