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
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../../test/phoneWidth";
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
const SECTION_NAMES = ["General", "Gates & limits", "Repositories", "Manage factories"];
const selectSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
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
  window.history.replaceState({}, "", "/settings");
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
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(within(region("Gates & limits")).getByText("These apply to every repo unless a repo overrides them below.")).toBeInTheDocument();
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
    selectSection("General");
    expect(screen.getByRole("switch", { name: "Pause the factory" })).not.toBeChecked();
  });

  it("builds_the_pr_gate_note_from_the_selected_factory's_list", async () => {
    resetFakeBoard(factory("blocks", ["data"], { protectedBranches: ["rel", "main"] }));
    renderSettings();
    selectSection("Gates & limits");
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
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" }));
    expect(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" })).toBeChecked();
    first.unmount();
    expect(sessionStorage.length).toBe(0);
    renderSettings();
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(within(globalForm()).getByRole("switch", { name: "Plan: you approve every plan" })).not.toBeChecked();
  });

  it("lists_the_seven_repos_with_inherit_on_off_per_gate", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/iam", { gates: { pr: false }, maxTurnsPerStage: 30 });
    renderSettings();
    selectSection("Repositories");
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
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "0" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("maxParallel must be a whole number from 1 to 10");
    expect(write).not.toHaveBeenCalled();
    expect(within(globalForm()).getByLabelText("Tasks at once")).toHaveValue("0");
  });

  it("refuses_a_repo_limit_out_of_range_next_to_that_repo", async () => {
    renderSettings();
    selectSection("Repositories");
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("logic");
    fireEvent.change(within(overrides("logic")).getByLabelText("logic cost limit"), { target: { value: "5000" } });
    fireEvent.click(within(overrides("logic")).getByRole("button", { name: "Save logic" }));
    expect(await within(overrides("logic")).findByRole("alert")).toHaveTextContent("maxCostPerTaskUsd must be a number from 0 to 1000");
  });

  it("saves_the_global_scope_with_only_the_changed_keys", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    selectSection("Gates & limits");
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
    selectSection("Repositories");
    await screen.findByRole("table", { name: "Repos" });
    openOverrides("iam");
    fireEvent.change(within(overrides("iam")).getByRole("combobox", { name: "iam spec gate" }), { target: { value: "off" } });
    fireEvent.change(within(overrides("iam")).getByLabelText("iam turn limit"), { target: { value: "25" } });
    // An unsaved edit elsewhere stays out of the iam save.
    selectSection("Gates & limits");
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "3" } });
    selectSection("Repositories");
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
    selectSection("Repositories");
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
    selectSection("Gates & limits");
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
    selectSection("Gates & limits");
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
    expect(within(region("General")).getByText("Settings are not available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    selectSection("Gates & limits");
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
    selectSection("Repositories");
    const table = await screen.findByRole("table", { name: "Repos" });
    expect(table.closest(".sf-table-wrap")).not.toBeNull();
    expect(region("Repositories").contains(table)).toBe(true);
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
    selectSection("Repositories");
    await screen.findByRole("table", { name: "Repos" });
    expect(within(repoRow("iam")).getByText("Plan gate on")).toBeInTheDocument();
  });

  it("opening_another_repo_closes_the_first_and_close_hides_it", async () => {
    renderSettings();
    selectSection("Repositories");
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
    selectSection("Repositories");
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
    selectSection("Repositories");
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
  it("defaults_to_a_valid_factory_and_shows_its_scope", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    window.localStorage.clear();
    renderSettings();
    const picker = await screen.findByLabelText("Editing factory");
    expect(["blocks", "delta"]).toContain((picker as HTMLSelectElement).value);
    expect(within(picker).queryByRole("option", { name: "All factories" })).toBeNull();
    selectSection("Gates & limits");
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeVisible();
  });

  it("shows_the_only_factory_without_storing_a_pick", async () => {
    window.localStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderSettings();
    expect(await screen.findByLabelText("Editing factory")).toHaveValue("blocks");
    expect(setItem.mock.calls.filter((call) => call[0] === "factory-board:factory")).toEqual([]);
  });

  it("uses_the_only_factory_even_with_a_stale_pick", async () => {
    window.localStorage.setItem("factory-board:factory", "gone");
    renderSettings();
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    selectSection("Repositories");
    expect(repoRow("iam")).toBeInTheDocument();
  });

  it("switching_the_picker_switches_the_scoped_sections", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    renderSettings();
    selectSection("Repositories");
    await screen.findByRole("table", { name: "Repos" });
    expect(repoRow("iam")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Editing factory", { selector: "select" }), { target: { value: "delta" } });
    expect(await screen.findByRole("row", { name: "api" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "iam" })).not.toBeInTheDocument();
    selectSection("Gates & limits");
    expect(globalForm()).toBeInTheDocument();
  });

  it("updates_only_the_scope_of_the_selected_factorys_repo", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api", "ui"])));
    window.localStorage.setItem("factory-board:factory", "delta");
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    selectSection("Repositories");
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
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save gates and limits" }));
    await screen.findByText("Saved gates and limits.");
    selectSection("General");
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
    selectSection("Repositories");
    const section = (await screen.findByRole("heading", { name: "Settings for removed repos" })).closest("section")!;
    expect(within(region("Repositories")).getByRole("heading", { name: "Settings for removed repos" })).toBeInTheDocument();
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
    selectSection("Repositories");
    const invalid = await screen.findByRole("region", { name: "Settings for invalid repos" });
    expect(region("Repositories").contains(invalid)).toBe(true);
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
    expect(within(region("General")).getByText("Settings are not available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    selectSection("Gates & limits");
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeInTheDocument();
    expect(screen.getByLabelText("Editing factory", { selector: "select" })).toHaveValue("blocks");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps_a_draft_when_another_tab_changes_the_pick", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    renderSettings();
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(within(globalForm()).getByLabelText("Tasks at once"), { target: { value: "4" } });
    window.localStorage.setItem("factory-board:factory", "delta");
    window.dispatchEvent(new StorageEvent("storage", { key: "factory-board:factory", newValue: "delta" }));
    await Promise.resolve();
    expect(within(globalForm()).getByLabelText("Tasks at once")).toHaveValue("4");
    expect(screen.getByLabelText("Editing factory", { selector: "select" })).toHaveValue("blocks");
  });

  it("applies_a_pick_in_this_tab_even_when_it_cannot_be_stored", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    renderSettings();
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    fireEvent.change(screen.getByLabelText("Editing factory", { selector: "select" }), { target: { value: "delta" } });
    await waitFor(() => expect(screen.getByLabelText("Editing factory", { selector: "select" })).toHaveValue("delta"));
    cleanup();
    renderSettings();
    selectSection("Repositories");
    await screen.findByRole("table", { name: "Repos" });
    expect(screen.getByLabelText("Editing factory", { selector: "select" })).toHaveValue("delta");
  });

  it("shows_no_removed_repo_section_when_every_scope_has_its_repo", async () => {
    renderSettings();
    selectSection("Repositories");
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

    selectSection("General");
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
    expect(within(region("General")).getByRole("switch", { name: "Pause the factory" })).toHaveAccessibleDescription(PAUSE_HINT);
  });
});

describe("settings page layout", () => {
  it("renders four ordered tabs and exposes only the selected section", () => {
    renderSettings();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(SECTION_NAMES);
    expect(screen.getByRole("tabpanel", { name: "General" })).toBeVisible();
    selectSection("Repositories");
    expect(screen.getByRole("tabpanel", { name: "Repositories" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Repositories" })).toHaveAttribute("aria-selected", "true");
  });
  it("supports arrow keys and a legacy fragment", () => {
    window.history.replaceState({}, "", "/settings#settings-repos");
    renderSettings();
    const repositories = screen.getByRole("tab", { name: "Repositories" });
    expect(repositories).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(repositories, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Manage factories" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Manage factories" })).toBeVisible();
    window.history.replaceState({}, "", "/");
  });
});

describe("SettingsView action bars", () => {
  it("Settings_forms_keep_plain_sf_actions", async () => {
    renderSettings();
    selectSection("Gates & limits");
    await screen.findByRole("form", { name: "Gates and limits" });
    expect(document.querySelectorAll(".sf-actions").length).toBeGreaterThan(0);
    expect(document.querySelector(".sf-action-bar")).toBeNull();
  });
});

describe("SettingsView at 360px", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("settings_fits_360", async () => {
    const { container } = renderSettings();
    selectSection("Gates & limits");
    expect(await screen.findByRole("form", { name: "Gates and limits" })).toBeInTheDocument();
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
  });
});
