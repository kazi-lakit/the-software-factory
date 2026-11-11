import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSettings, VersionConflictError, type StoredSettings } from "@factory/core";
import { AppShell } from "../../app/AppShell";
import { AuthProvider } from "../../app/providers/AuthProvider";
import { blocksClient } from "../../lib/blocks/client";
import { fetchSessionClaims } from "../../lib/blocks/auth";
import { clearAllUnsent } from "../../lib/unsent";
import { blocksFactories, factory, merge, repoFixture } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { checksSummary, gatesSummary, prGateNote, SettingsView } from "./SettingsView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
vi.mock("../../lib/blocks/client", () => ({ blocksClient: { iam: { me: vi.fn() } } }));
vi.mock("../../lib/blocks/auth", () => ({
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(async () => "rejected"),
  startLogin: vi.fn(async () => undefined)
}));

const PR_NOTE = "A PR into dev, stg or main always waits for you, whatever this says.";
const PAUSE_HINT = "While paused, the factory starts no new work. Steps already running finish. This saves at once.";
const SECTION_NAMES = ["Factory", "Gates and limits", "Repos", "Factories"];
const now = () => new Date("2026-11-10T09:00:00.000Z");

function renderSettings() {
  return renderWithClient(<SettingsView />);
}

const globalForm = () => screen.getByRole("form", { name: "Gates and limits" });
const repoRow = (repo: string) => screen.getByRole("row", { name: repo });
const openOverrides = (repo: string) => fireEvent.click(within(repoRow(repo)).getByRole("button", { name: `Edit overrides for ${repo}` }));
const overrides = (repo: string) => screen.getByRole("form", { name: `${repo} overrides` });
const region = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  resetFakeBoard();
  window.localStorage.setItem("factory-board:factory", "blocks");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearAllUnsent();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsView", () => {
  it("shows_the_global_settings_and_the_pr_gate_note", async () => {
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(within(region("Gates and limits")).getByText("These apply to every repo unless a repo overrides them below.")).toBeInTheDocument();
    const form = globalForm();
    const group = within(form).getByRole("group", { name: "Where the factory stops for you" });
    expect(within(group).getByRole("switch", { name: "Spec: you approve every spec" })).toBeChecked();
    expect(within(group).getByRole("switch", { name: "Plan: you approve every plan" })).not.toBeChecked();
    const pr = within(group).getByRole("switch", { name: "PR: you merge every PR" });
    expect(pr).toBeChecked();
    expect(within(group).getByText(PR_NOTE)).toBeInTheDocument();
    expect(pr).toHaveAccessibleDescription(PR_NOTE);
    expect(within(form).getByLabelText("Tasks at once")).toHaveValue("2");
    expect(within(form).getByLabelText("Tasks at once")).toHaveAccessibleDescription("1 to 10");
    expect(within(form).getByLabelText("Turns per stage")).toHaveValue("60");
    expect(within(form).getByLabelText("Turns per stage")).toHaveAccessibleDescription("1 to 500");
    expect(within(form).getByLabelText("Cost per task (USD)")).toHaveValue("5");
    expect(within(form).getByLabelText("Cost per task (USD)")).toHaveAccessibleDescription("The runner stops a task above this");
    expect(screen.getByRole("switch", { name: "Pause the factory" })).not.toBeChecked();
  });

  it("builds_the_pr_gate_note_from_the_selected_factory's_list", async () => {
    resetFakeBoard(factory("blocks", ["data"], { protectedBranches: ["rel", "main"] }));
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    const note = "A PR into rel or main always waits for you, whatever this says.";
    expect(within(globalForm()).getByRole("switch", { name: "PR: you merge every PR" })).toHaveAccessibleDescription(note);
  });

  it("words_the_pr_gate_note_for_all_factories", () => {
    expect(prGateNote()).toBe("A PR into each factory's protected branches always waits for you, whatever this says.");
    expect(prGateNote(["main"])).toBe("A PR into main always waits for you, whatever this says.");
    expect(prGateNote(["dev", "stg", "main"])).toBe(PR_NOTE);
  });

  it("drops_unsaved_changes_when_the_view_unmounts", async () => {
    const first = renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" }));
    expect(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" })).toBeChecked();
    first.unmount();
    expect(sessionStorage.length).toBe(0);
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" })).not.toBeChecked();
  });

  it("lists_the_seven_repos_with_inherit_on_off_per_gate", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/iam", { gates: { pr: false }, maxTurnsPerStage: 30 });
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    for (const repo of ["os", "iam", "monitor", "logic", "data", "localization", "release"]) {
      expect(within(repoRow(repo)).getByRole("button", { name: `Edit overrides for ${repo}` })).toBeInTheDocument();
    }
    openOverrides("iam");
    const form = overrides("iam");
    for (const gate of ["spec", "plan", "PR"]) {
      const select = within(form).getByRole("combobox", { name: `iam ${gate} gate` });
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Inherit", "On", "Off"]);
    }
    expect(within(form).getByRole("combobox", { name: "iam PR gate" })).toHaveValue("off");
    expect(within(form).getByRole("combobox", { name: "iam spec gate" })).toHaveValue("inherit");
    expect(within(form).getByLabelText("iam turn limit")).toHaveValue("30");
    expect(within(form).getByLabelText("iam cost limit")).toHaveValue("");
    expect(within(form).getByRole("button", { name: "Save iam" })).toBeInTheDocument();
  });

  it("refuses_max_parallel_0_with_the_validation_message", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "0" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("maxParallel must be a whole number from 1 to 10");
    expect(write).not.toHaveBeenCalled();
    expect(within(globalForm()).getByLabelText("Tasks at once")).toHaveValue("0");
  });

  it("refuses_a_repo_limit_out_of_range_next_to_that_repo", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("logic");
    fireEvent.change(within(overrides("logic")).getByLabelText("logic cost limit"), { target: { value: "5000" } });
    fireEvent.click(within(overrides("logic")).getByRole("button", { name: "Save logic" }));
    expect(await within(overrides("logic")).findByRole("alert")).toHaveTextContent("maxCostPerTaskUsd must be a number from 0 to 1000");
  });

  it("saves_the_global_scope_with_only_the_changed_keys", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" }));
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "4" } });
    fireEvent.change(within(globalForm()).getByLabelText("Cost per task (USD)"), { target: { value: "7.5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    await screen.findByText("Saved gates and limits.");
    expect(within(globalForm()).getByText("Saved.")).toBeInTheDocument();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe("blocks");
    // Only the changed keys are saved, so only they leave a history event.
    expect((await fakeBoard().owner.listEvents("-")).map((e) => e.field).sort()).toEqual(
      ["settings.blocks.gates", "settings.blocks.maxCostPerTaskUsd", "settings.blocks.maxParallel"]
    );
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.blocks!.factory).toEqual({ gates: { spec: true, plan: true, pr: true }, maxParallel: 4, maxTurnsPerStage: 60, maxCostPerTaskUsd: 7.5, paused: false });
  });

  it("saves_a_repo_override_to_that_scope_only", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("iam");
    fireEvent.change(within(overrides("iam")).getByRole("combobox", { name: "iam spec gate" }), { target: { value: "off" } });
    fireEvent.change(within(overrides("iam")).getByLabelText("iam turn limit"), { target: { value: "25" } });
    // An unsaved edit elsewhere stays out of the iam save.
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "3" } });
    fireEvent.click(within(overrides("iam")).getByRole("button", { name: "Save iam" }));
    await screen.findByText("Saved iam settings.");
    expect(write.mock.calls.map((call) => call[0])).toEqual(["blocks/iam"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.blocks!.repos).toEqual({ iam: { gates: { spec: false }, maxTurnsPerStage: 25 } });
    expect(stored.factories.blocks!.factory.maxParallel).toBe(2);
  });

  it("sends_inherit_as_null_so_the_repo_takes_the_global_value_again", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/data", { gates: { pr: false, spec: true }, maxCostPerTaskUsd: 2 });
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("data");
    const form = overrides("data");
    expect(within(form).getByRole("combobox", { name: "data PR gate" })).toHaveValue("off");
    fireEvent.change(within(form).getByRole("combobox", { name: "data PR gate" }), { target: { value: "inherit" } });
    fireEvent.change(within(form).getByLabelText("data cost limit"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save data" }));
    await screen.findByText("Saved data settings.");
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.blocks!.repos.data).toEqual({ gates: { spec: true } });
    const events = await fakeBoard().owner.listEvents("-");
    expect(events.filter((e) => e.at !== now().toISOString()).map((e) => [e.field, e.to]).sort()).toEqual([
      ["settings.blocks/data.maxCostPerTaskUsd", "inherit"],
      ["settings.blocks/data.gates", '{"spec":true}']
    ].sort());
  });

  it("keeps_unsaved_edits_through_a_conflict_and_reload", async () => {
    const owner = fakeBoard().owner;
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "4" } });
    // Someone else saves the turn limit, and this save loses the race.
    await saveSettings(owner, now, "blocks", { maxTurnsPerStage: 80 });
    vi.spyOn(owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(within(globalForm()).getByLabelText("Turns per stage")).toHaveValue("80"));
    expect(within(globalForm()).getByLabelText("Tasks at once")).toHaveValue("4");
    expect(within(globalForm()).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    await screen.findByText("Saved gates and limits.");
    const stored = await owner.getSettings();
    expect(stored.factories.blocks!.factory.maxParallel).toBe(4);
    expect(stored.factories.blocks!.factory.maxTurnsPerStage).toBe(80);
  });

  it("refreshes_settings_and_history_after_a_save", async () => {
    const { client } = renderSettings();
    client.setQueryData(["history", { showTest: false }], { events: [], taskIds: [] });
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Turns per stage"), { target: { value: "70" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    await screen.findByText("Saved gates and limits.");
    expect(client.getQueryState(["history", { showTest: false }])?.isInvalidated).toBe(true);
    await waitFor(() => expect(client.getQueryData<StoredSettings>(["settings"])?.factories.blocks?.factory.maxTurnsPerStage).toBe(70));
  });

  it("shows_an_error_with_retry_instead_of_the_form_when_settings_cannot_load", async () => {
    const getSettings = vi.spyOn(fakeBoard().owner, "getSettings").mockRejectedValueOnce(new Error("blocks: unavailable"));
    renderSettings();
    expect(await screen.findByText("Could not load the settings.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Gates and limits" })).not.toBeInTheDocument();
    expect(region("Factories")).toBeInTheDocument();
    for (const name of ["Factory", "Gates and limits", "Repos"]) {
      expect(within(region(name)).getByText("Settings are not available.")).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});

describe("repo summaries", () => {
  it("gates_summary_says_same_as_factory_without_overrides", () => {
    expect(gatesSummary(undefined)).toBe("Same as factory");
    expect(gatesSummary({})).toBe("Same as factory");
    expect(gatesSummary({ gates: {} })).toBe("Same as factory");
  });

  it("gates_summary_lists_overrides_in_spec_plan_pr_order", () => {
    expect(gatesSummary({ gates: { plan: true } })).toBe("Plan gate on");
    expect(gatesSummary({ gates: { pr: false, spec: true } })).toBe("Spec gate on, PR gate off");
  });

  it("checks_summary_joins_commands_in_run_order", () => {
    expect(checksSummary(repoFixture("blocks", "iam").checks)).toBe("b · t · i · tc · l · t");
  });
});

describe("repos table", () => {
  it("repos_table_has_repo_base_gates_checks_and_actions_columns", async () => {
    renderSettings();
    const table = await screen.findByRole("table", { name: "Repos" });
    expect(table.closest(".sf-table-wrap")).not.toBeNull();
    expect(region("Repos").contains(table)).toBe(true);
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Repo", "Base", "Gates", "Checks", "Actions"]);
    expect(within(headers[4]!).getByText("Actions")).toHaveClass("sf-visually-hidden");
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    const iam = repoRow("iam");
    expect(within(iam).getByText("dev")).toBeInTheDocument();
    expect(within(iam).getByText("Same as factory")).toBeInTheDocument();
    expect(within(iam).getByText("b · t · i · tc · l · t")).toBeInTheDocument();
  });

  it("repos_table_shows_plan_gate_on_for_a_plan_override", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/iam", { gates: { plan: true } });
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    expect(within(repoRow("iam")).getByText("Plan gate on")).toBeInTheDocument();
  });

  it("opening_another_repo_closes_the_first_and_close_hides_it", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("iam");
    expect(overrides("iam")).toBeInTheDocument();
    openOverrides("data");
    expect(screen.queryByRole("form", { name: "iam overrides" })).not.toBeInTheDocument();
    fireEvent.click(within(overrides("data")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("form", { name: "data overrides" })).not.toBeInTheDocument();
  });

  it("keeps_a_repo's_unsaved_overrides_when_its_form_is_closed_and_opened_again", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("iam");
    fireEvent.change(within(overrides("iam")).getByLabelText("iam turn limit"), { target: { value: "25" } });
    openOverrides("data");
    expect(screen.queryByRole("form", { name: "iam overrides" })).not.toBeInTheDocument();
    openOverrides("iam");
    expect(within(overrides("iam")).getByLabelText("iam turn limit")).toHaveValue("25");
    fireEvent.click(within(overrides("iam")).getByRole("button", { name: "Close" }));
    openOverrides("iam");
    expect(within(overrides("iam")).getByLabelText("iam turn limit")).toHaveValue("25");
    expect(write).not.toHaveBeenCalled();
  });

  it("marks_a_closed_repo_row_that_has_unsaved_overrides", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    const row = () => repoRow("iam");
    openOverrides("iam");
    expect(within(row()).queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(within(overrides("iam")).getByLabelText("iam turn limit"), { target: { value: "25" } });
    fireEvent.click(within(overrides("iam")).getByRole("button", { name: "Close" }));
    expect(within(row()).getByText("Unsaved changes")).toBeInTheDocument();
    expect(within(repoRow("data")).queryByText("Unsaved changes")).toBeNull();
    openOverrides("iam");
    expect(within(row()).queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(within(overrides("iam")).getByLabelText("iam turn limit"), { target: { value: "" } });
    fireEvent.click(within(overrides("iam")).getByRole("button", { name: "Close" }));
    expect(within(row()).queryByText("Unsaved changes")).toBeNull();
  });
});

describe("factory picker and scope", () => {
  it("asks_to_pick_a_factory_while_all_is_selected", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    window.localStorage.clear();
    renderSettings();
    expect(await screen.findAllByText("Pick a factory to see its settings.")).toHaveLength(3);
    for (const name of ["Factory", "Gates and limits", "Repos"]) {
      expect(within(region(name)).getByText("Pick a factory to see its settings.")).toBeInTheDocument();
    }
    expect(within(region("Factories")).getByRole("link", { name: "Add factory" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Gates and limits" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Factory", { selector: "select" }), { target: { value: "blocks" } });
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeInTheDocument();
  });

  it("uses_the_only_factory_without_a_picker_and_does_not_store_the_pick", async () => {
    window.localStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(screen.queryByLabelText("Factory", { selector: "select" })).toBeNull();
    expect(setItem.mock.calls.filter((call) => call[0] === "factory-board:factory")).toEqual([]);
  });

  it("uses_the_only_factory_even_with_a_stale_pick", async () => {
    window.localStorage.setItem("factory-board:factory", "gone");
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(repoRow("iam")).toBeInTheDocument();
  });

  it("switching_the_picker_switches_the_scoped_sections", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    expect(repoRow("iam")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Factory", { selector: "select" }), { target: { value: "delta" } });
    expect(await screen.findByRole("row", { name: "api" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "iam" })).not.toBeInTheDocument();
    expect(globalForm()).toBeInTheDocument();
  });

  it("updates_only_the_scope_of_the_selected_factorys_repo", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api", "ui"])));
    window.localStorage.setItem("factory-board:factory", "delta");
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    expect(screen.queryByRole("row", { name: "iam" })).not.toBeInTheDocument();
    openOverrides("api");
    fireEvent.change(within(overrides("api")).getByLabelText("api turn limit"), { target: { value: "25" } });
    fireEvent.click(within(overrides("api")).getByRole("button", { name: "Save api" }));
    await screen.findByText("Saved api settings.");
    expect(write.mock.calls.map((call) => call[0])).toEqual(["delta/api"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.delta!.repos).toEqual({ api: { maxTurnsPerStage: 25 } });
    expect(stored.factories.blocks).toBeUndefined();
  });

  it("saves_the_factory_defaults_and_the_pause_under_the_selected_factory", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    window.localStorage.setItem("factory-board:factory", "delta");
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    await screen.findByText("Saved gates and limits.");
    fireEvent.click(screen.getByRole("switch", { name: "Pause the factory" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pause the factory" })).toBeChecked());
    expect(write.mock.calls.map((call) => call[0])).toEqual(["delta", "delta"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.delta!.factory).toMatchObject({ maxParallel: 5, paused: true });
    expect(stored.factories.blocks).toBeUndefined();
  });

  it("lists_settings_of_removed_repos_and_resets_them_to_inherit", async () => {
    await fakeBoard().owner.updateSettingsScope("blocks/gone", undefined, { gates: { pr: false }, maxParallel: 3 });
    renderSettings();
    const section = (await screen.findByRole("heading", { name: "Settings for removed repos" })).closest("section")!;
    expect(within(region("Repos")).getByRole("heading", { name: "Settings for removed repos" })).toBeInTheDocument();
    expect(within(section).getByText("gone")).toBeInTheDocument();
    expect(within(section).getByText(/max parallel 3/)).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "gone" })).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Reset gone settings" }));
    await screen.findByText("Reset gone settings.");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Settings for removed repos" })).not.toBeInTheDocument());
    expect((await fakeBoard().owner.getSettings()).factories.blocks?.repos.gone).toBeUndefined();
    expect((await fakeBoard().owner.listEvents("-")).map((e) => [e.field, e.to])).toEqual([
      ["settings.blocks/gone.maxParallel", "inherit"],
      ["settings.blocks/gone.gates", "inherit"]
    ]);
  });

  it("lists_settings_of_an_invalid_repo_separately_without_reset", async () => {
    resetFakeBoard({ defs: blocksFactories().defs, repos: [...blocksFactories().repos, { ...blocksFactories().repos[0]!, repoId: "bad", remote: "" }] });
    await fakeBoard().owner.updateSettingsScope("blocks/bad", undefined, { maxParallel: 3 });
    await fakeBoard().owner.updateSettingsScope("blocks/gone", undefined, { maxParallel: 2 });
    renderSettings();
    const invalid = await screen.findByRole("region", { name: "Settings for invalid repos" });
    expect(region("Repos").contains(invalid)).toBe(true);
    expect(within(invalid).getByText(/Fix them in the Factories section\./)).toBeInTheDocument();
    expect(within(invalid).getByText("bad")).toBeInTheDocument();
    expect(within(invalid).queryByRole("button")).not.toBeInTheDocument();
    const removed = screen.getByRole("heading", { name: "Settings for removed repos" }).closest("section")!;
    expect(within(removed).getByText("gone")).toBeInTheDocument();
    expect(within(removed).queryByText("bad")).not.toBeInTheDocument();
  });

  it("shows_an_error_with_retry_when_the_factories_cannot_load", async () => {
    window.localStorage.clear();
    const list = vi.spyOn(fakeBoard().owner, "listFactoryDefs").mockRejectedValueOnce(new Error("blocks: unavailable"));
    renderSettings();
    expect(await screen.findAllByText("Could not load the factories.")).toHaveLength(1);
    expect(within(region("Factories")).getByText("Settings are not available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Factory", { selector: "select" })).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps_a_draft_when_another_tab_changes_the_pick", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "4" } });
    window.localStorage.setItem("factory-board:factory", "delta");
    window.dispatchEvent(new StorageEvent("storage", { key: "factory-board:factory", newValue: "delta" }));
    await Promise.resolve();
    expect(within(globalForm()).getByLabelText("Tasks at once")).toHaveValue("4");
    expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("blocks");
  });

  it("applies_a_pick_in_this_tab_even_when_it_cannot_be_stored", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(screen.getByLabelText("Factory", { selector: "select" }), { target: { value: "delta" } });
    await waitFor(() => expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("delta"));
    cleanup();
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("delta");
  });

  it("shows_no_removed_repo_section_when_every_scope_has_its_repo", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repos" });
    expect(screen.queryByRole("heading", { name: "Settings for removed repos" })).not.toBeInTheDocument();
  });
});

describe("the pause switch", () => {
  beforeEach(() => {
    vi.mocked(fetchSessionClaims).mockResolvedValue({ sub: "me" });
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { firstName: "Kazi", roles: ["factory-owner"] } } as never);
  });

  it("saves_at_once_and_the_shell_shows_factory_paused", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppShell activePath="/settings" onNavigate={vi.fn()}>
            <SettingsView />
          </AppShell>
        </AuthProvider>
      </QueryClientProvider>
    );
    const pause = await screen.findByRole("switch", { name: "Pause the factory" });
    expect(screen.queryByText("Factory paused")).not.toBeInTheDocument();
    fireEvent.click(pause);
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pause the factory" })).toBeChecked());
    expect(write.mock.calls.map((call) => [call[0], (call[2] as { paused: boolean }).paused])).toEqual([["blocks", true]]);
    expect((await fakeBoard().owner.getSettings()).factories.blocks!.factory.paused).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Pause the factory" }));
    await waitFor(() => expect(screen.queryByText("Factory paused")).not.toBeInTheDocument());
    expect((await fakeBoard().owner.getSettings()).factories.blocks!.factory.paused).toBe(false);
  });

  it("shows_why_a_pause_was_not_saved", async () => {
    vi.spyOn(fakeBoard().owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "Pause the factory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    expect(screen.getByRole("switch", { name: "Pause the factory" })).not.toBeChecked();
  });

  it("pause_switch_is_described_by_its_hint", async () => {
    renderSettings();
    await screen.findByRole("switch", { name: "Pause the factory" });
    expect(within(region("Factory")).getByRole("switch", { name: "Pause the factory" })).toHaveAccessibleDescription(PAUSE_HINT);
  });
});

const currentLinks = () =>
  within(screen.getByRole("navigation", { name: "Settings sections" }))
    .getAllByRole("link")
    .filter((l) => l.getAttribute("aria-current") === "location")
    .map((l) => l.textContent);

class FakeIO {
  static last: FakeIO | undefined;
  readonly targets: Element[] = [];
  readonly callback: (entries: unknown[]) => void;
  readonly options: IntersectionObserverInit | undefined;
  constructor(callback: (entries: unknown[]) => void, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIO.last = this;
  }
  observe(target: Element) { this.targets.push(target); }
  unobserve() {}
  disconnect() {}
}

/** Queues animation frames so a test decides when they run; returns how many are queued and a flush. */
function stubFrames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => { queue.length = 0; });
  return {
    pending: () => queue.length,
    flush: () => act(() => { for (const cb of queue.splice(0)) cb(0); })
  };
}

/** Puts the app's sticky top bar in the page, its bottom edge at the given height. */
function stubTopBar(bottom: number) {
  const bar = document.createElement("header");
  bar.className = "sf-topbar";
  document.body.prepend(bar);
  vi.spyOn(bar, "getBoundingClientRect").mockImplementation(() => ({ top: 0, bottom, height: bottom }) as DOMRect);
  return bar;
}

function stubTops(tops: Record<string, number>) {
  for (const id of Object.keys(tops)) {
    vi.spyOn(document.getElementById(id)!, "getBoundingClientRect").mockImplementation(() => ({ top: tops[id] }) as DOMRect);
  }
}

const enter = (io: FakeIO, tops: Record<string, number>) =>
  io.callback(Object.entries(tops).map(([id, top]) => ({ boundingClientRect: { top }, isIntersecting: true, target: document.getElementById(id) })));

describe("settings page layout", () => {
  it("renders_one_page_with_no_tabs_and_four_sections_in_order", () => {
    renderSettings();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    const sections = SECTION_NAMES.map((name) => region(name));
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i - 1]!.compareDocumentPosition(sections[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("each_section_is_an_sf_panel_section_named_by_its_h2", () => {
    renderSettings();
    for (const name of SECTION_NAMES) {
      const section = region(name);
      expect(section.tagName).toBe("SECTION");
      expect(section).toHaveClass("sf-panel");
      const heading = document.getElementById(section.getAttribute("aria-labelledby") ?? "");
      expect(heading?.tagName).toBe("H2");
      expect(heading).toHaveTextContent(name);
      expect(heading).not.toHaveClass("sf-page-title");
    }
  });

  it("nav_named_settings_sections_links_to_each_section", () => {
    renderSettings();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(SECTION_NAMES);
    for (const link of links) {
      const href = link.getAttribute("href")!;
      expect(href.startsWith("#")).toBe(true);
      expect(document.getElementById(href.slice(1))).toBe(region(link.textContent!));
    }
  });

  it("settings_title_uses_page_title_class", () => {
    renderSettings();
    expect(screen.getByRole("heading", { name: "Settings" })).toHaveClass("sf-page-title");
  });

  it("first_link_is_current_on_load_and_a_clicked_link_becomes_current", () => {
    renderSettings();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const current = () => within(nav).getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "location").map((l) => l.textContent);
    expect(current()).toEqual(["Factory"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Repos" }));
    expect(current()).toEqual(["Repos"]);
  });

  it("opening_with_a_section_hash_scrolls_to_it_and_makes_it_current", () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    window.history.pushState({}, "", "/settings#settings-factories");
    try {
      renderSettings();
      expect(scrolled).toEqual([region("Factories")]);
      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      expect(within(nav).getByRole("link", { name: "Factories" })).toHaveAttribute("aria-current", "location");
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.pushState({}, "", "/");
    }
  });

  it("section_nearest_the_top_becomes_current_while_scrolling", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    renderSettings();
    const io = FakeIO.last!;
    expect(io.targets).toHaveLength(4);
    act(() => {
      io.callback([{ boundingClientRect: { top: 10 }, isIntersecting: true, target: document.getElementById("settings-gates-and-limits") }]);
    });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const current = within(nav).getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "location").map((l) => l.textContent);
    expect(current).toEqual(["Gates and limits"]);
  });

  it("reads_live_positions_while_scrolling_not_the_ones_saved_when_a_section_entered", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const frames = stubFrames();
    renderSettings();
    const io = FakeIO.last!;
    const tops: Record<string, number> = { "settings-factory": -50, "settings-gates-and-limits": 300 };
    for (const id of Object.keys(tops)) {
      vi.spyOn(document.getElementById(id)!, "getBoundingClientRect").mockImplementation(() => ({ top: tops[id] }) as DOMRect);
    }
    act(() => {
      io.callback([
        { boundingClientRect: { top: -50 }, isIntersecting: true, target: document.getElementById("settings-factory") },
        { boundingClientRect: { top: 300 }, isIntersecting: true, target: document.getElementById("settings-gates-and-limits") }
      ]);
    });
    expect(currentLinks()).toEqual(["Factory"]);
    // Both stay visible, so the observer does not fire again; the page reads live positions on scroll.
    tops["settings-factory"] = -500;
    tops["settings-gates-and-limits"] = 20;
    act(() => { fireEvent.scroll(window); });
    frames.flush();
    expect(currentLinks()).toEqual(["Gates and limits"]);
  });

  it("a_clicked_link_stays_current_until_the_user_scrolls", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const frames = stubFrames();
    renderSettings();
    const io = FakeIO.last!;
    const tops: Record<string, number> = { "settings-repos": -10, "settings-factories": 500 };
    for (const id of Object.keys(tops)) {
      vi.spyOn(document.getElementById(id)!, "getBoundingClientRect").mockImplementation(() => ({ top: tops[id] }) as DOMRect);
    }
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "Factories" }));
    // The anchor jump cannot bring the last section to the top, so Repos stays nearest; the click still wins.
    act(() => {
      io.callback([
        { boundingClientRect: { top: -10 }, isIntersecting: true, target: document.getElementById("settings-repos") },
        { boundingClientRect: { top: 500 }, isIntersecting: true, target: document.getElementById("settings-factories") }
      ]);
      fireEvent.scroll(window);
    });
    frames.flush();
    expect(currentLinks()).toEqual(["Factories"]);
    act(() => {
      fireEvent.wheel(window);
      fireEvent.scroll(window);
    });
    frames.flush();
    expect(currentLinks()).toEqual(["Repos"]);
  });

  it("observes_sections_below_the_sticky_top_bar", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    stubTopBar(52);
    renderSettings();
    expect(FakeIO.last!.options?.rootMargin).toBe("-52px 0px -60% 0px");
  });

  it("a_section_jumped_to_below_the_top_bar_becomes_current", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    stubTopBar(52);
    renderSettings();
    // A nav jump puts the section's top 16px under the bar (scroll-margin-top); the section above has scrolled past.
    const tops = { "settings-factory": -300, "settings-gates-and-limits": 68 };
    stubTops(tops);
    act(() => enter(FakeIO.last!, tops));
    expect(currentLinks()).toEqual(["Gates and limits"]);
  });

  it("a_long_section_filling_the_top_stays_current_while_the_next_one_comes_up", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    stubTopBar(52);
    renderSettings();
    // Repos still fills the space under the bar; Factories is near, but its top is not up to the bar yet.
    const tops = { "settings-repos": -400, "settings-factories": 200 };
    stubTops(tops);
    act(() => enter(FakeIO.last!, tops));
    expect(currentLinks()).toEqual(["Repos"]);
  });

  it("reads_positions_at_most_once_per_frame_while_scrolling", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const frames = stubFrames();
    renderSettings();
    const tops: Record<string, number> = { "settings-factory": -50, "settings-gates-and-limits": 300 };
    stubTops(tops);
    act(() => enter(FakeIO.last!, tops));
    const reads = vi.spyOn(document.getElementById("settings-gates-and-limits")!, "getBoundingClientRect");
    reads.mockClear();
    tops["settings-factory"] = -500;
    tops["settings-gates-and-limits"] = 10;
    act(() => {
      fireEvent.scroll(window);
      fireEvent.scroll(window);
      fireEvent.scroll(window);
    });
    expect(frames.pending()).toBe(1);
    expect(reads).not.toHaveBeenCalled();
    frames.flush();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(currentLinks()).toEqual(["Gates and limits"]);
  });

  it("does_not_crash_without_intersection_observer", () => {
    expect(typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver).toBe("undefined");
    renderSettings();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("repo_overrides_table_in_wrap_and_buttons_split_primary_and_outlined", async () => {
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(screen.getByRole("table", { name: "Repos" }).closest(".sf-table-wrap")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save gates and limits" })).toHaveClass("sf-button-primary");
    openOverrides("data");
    expect(within(overrides("data")).getByRole("button", { name: "Save data" })).not.toHaveClass("sf-button-primary");
  });
});

describe("SettingsView action bars", () => {
  it("Settings_forms_keep_plain_sf_actions", async () => {
    renderSettings();
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(document.querySelectorAll(".sf-actions").length).toBeGreaterThan(0);
    expect(document.querySelector(".sf-action-bar")).toBeNull();
  });
});
