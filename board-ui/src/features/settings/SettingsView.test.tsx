import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSettings, VersionConflictError, type StoredSettings } from "@factory/core";
import { AppShell } from "../../app/AppShell";
import { AuthProvider } from "../../app/providers/AuthProvider";
import { blocksClient } from "../../lib/blocks/client";
import { fetchSessionClaims } from "../../lib/blocks/auth";
import { clearAllUnsent } from "../../lib/unsent";
import { blocksFactories, factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { SettingsView } from "./SettingsView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));
vi.mock("../../lib/blocks/client", () => ({ blocksClient: { iam: { me: vi.fn() } } }));
vi.mock("../../lib/blocks/auth", () => ({
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(async () => "rejected"),
  startLogin: vi.fn(async () => undefined)
}));

const PR_NOTE = "Turning this off lets the factory merge into other branches. A PR into dev, stg or main always waits for you.";
const now = () => new Date("2026-11-10T09:00:00.000Z");

function renderSettings() {
  return renderWithClient(<SettingsView />);
}

const globalForm = () => screen.getByRole("form", { name: "Factory defaults" });
const repoRow = (repo: string) => screen.getByRole("row", { name: repo });

beforeEach(() => {
  resetFakeBoard();
  window.localStorage.setItem("factory-board:factory", "blocks");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("SettingsView", () => {
  it("shows_the_global_settings_and_the_pr_gate_note", async () => {
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    const form = globalForm();
    expect(within(form).getByRole("switch", { name: "Spec gate" })).toBeChecked();
    expect(within(form).getByRole("switch", { name: "Plan gate" })).not.toBeChecked();
    const pr = within(form).getByRole("switch", { name: "PR gate" });
    expect(pr).toBeChecked();
    expect(screen.getByText(PR_NOTE)).toBeInTheDocument();
    expect(pr).toHaveAccessibleDescription(PR_NOTE);
    expect(within(form).getByLabelText("Max parallel tasks")).toHaveValue("2");
    expect(within(form).getByLabelText("Turn limit per stage")).toHaveValue("60");
    expect(within(form).getByLabelText("Cost limit per task (USD)")).toHaveValue("5");
    expect(screen.getByRole("switch", { name: "Pause factory" })).not.toBeChecked();
  });

  it("drops_unsaved_changes_when_the_view_unmounts", async () => {
    const first = renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan gate" }));
    expect(within(globalForm()).getByRole("switch", { name: "Plan gate" })).toBeChecked();
    first.unmount();
    expect(sessionStorage.length).toBe(0);
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    expect(within(globalForm()).getByRole("switch", { name: "Plan gate" })).not.toBeChecked();
  });

  it("lists_the_seven_repos_with_inherit_on_off_per_gate", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/iam", { gates: { pr: false }, maxTurnsPerStage: 30 });
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    for (const repo of ["os", "iam", "monitor", "logic", "data", "localization", "release"]) {
      const row = repoRow(repo);
      for (const gate of ["spec", "plan", "PR"]) {
        const select = within(row).getByRole("combobox", { name: `${repo} ${gate} gate` });
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Inherit", "On", "Off"]);
      }
      expect(within(row).getByRole("button", { name: `Save ${repo}` })).toBeInTheDocument();
    }
    expect(within(repoRow("iam")).getByRole("combobox", { name: "iam PR gate" })).toHaveValue("off");
    expect(within(repoRow("iam")).getByRole("combobox", { name: "iam spec gate" })).toHaveValue("inherit");
    expect(within(repoRow("iam")).getByLabelText("iam turn limit")).toHaveValue("30");
    expect(within(repoRow("data")).getByLabelText("data turn limit")).toHaveValue("");
  });

  it("refuses_max_parallel_0_with_the_validation_message", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "0" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("maxParallel must be a whole number from 1 to 10");
    expect(write).not.toHaveBeenCalled();
    expect(within(globalForm()).getByLabelText("Max parallel tasks")).toHaveValue("0");
  });

  it("refuses_a_repo_limit_out_of_range_next_to_that_repo", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    fireEvent.change(within(repoRow("logic")).getByLabelText("logic cost limit"), { target: { value: "5000" } });
    fireEvent.click(within(repoRow("logic")).getByRole("button", { name: "Save logic" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("maxCostPerTaskUsd must be a number from 0 to 1000");
    expect(screen.getByRole("alert").closest("tr")?.previousElementSibling).toBe(repoRow("logic"));
  });

  it("saves_the_global_scope_with_only_the_changed_keys", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan gate" }));
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "4" } });
    fireEvent.change(within(globalForm()).getByLabelText("Cost limit per task (USD)"), { target: { value: "7.5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    await screen.findByText("Saved factory defaults.");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe("blocks");
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.blocks!.factory).toEqual({ gates: { spec: true, plan: true, pr: true }, maxParallel: 4, maxTurnsPerStage: 60, maxCostPerTaskUsd: 7.5, paused: false });
  });

  it("saves_a_repo_override_to_that_scope_only", async () => {
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    fireEvent.change(within(repoRow("iam")).getByRole("combobox", { name: "iam spec gate" }), { target: { value: "off" } });
    fireEvent.change(within(repoRow("iam")).getByLabelText("iam turn limit"), { target: { value: "25" } });
    // An unsaved edit elsewhere stays out of the iam save.
    fireEvent.change(within(repoRow("data")).getByRole("combobox", { name: "data PR gate" }), { target: { value: "off" } });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "3" } });
    fireEvent.click(within(repoRow("iam")).getByRole("button", { name: "Save iam" }));
    await screen.findByText("Saved iam settings.");
    expect(write.mock.calls.map((call) => call[0])).toEqual(["blocks/iam"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.blocks!.repos).toEqual({ iam: { gates: { spec: false }, maxTurnsPerStage: 25 } });
    expect(stored.factories.blocks!.factory.maxParallel).toBe(2);
    expect(within(repoRow("data")).getByRole("combobox", { name: "data PR gate" })).toHaveValue("off");
  });

  it("sends_inherit_as_null_so_the_repo_takes_the_global_value_again", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks/data", { gates: { pr: false, spec: true }, maxCostPerTaskUsd: 2 });
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    const row = repoRow("data");
    expect(within(row).getByRole("combobox", { name: "data PR gate" })).toHaveValue("off");
    fireEvent.change(within(row).getByRole("combobox", { name: "data PR gate" }), { target: { value: "inherit" } });
    fireEvent.change(within(row).getByLabelText("data cost limit"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save data" }));
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
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "4" } });
    // Someone else saves the turn limit, and this save loses the race.
    await saveSettings(owner, now, "blocks", { maxTurnsPerStage: 80 });
    vi.spyOn(owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(within(globalForm()).getByLabelText("Turn limit per stage")).toHaveValue("80"));
    expect(within(globalForm()).getByLabelText("Max parallel tasks")).toHaveValue("4");
    expect(within(globalForm()).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    await screen.findByText("Saved factory defaults.");
    const stored = await owner.getSettings();
    expect(stored.factories.blocks!.factory.maxParallel).toBe(4);
    expect(stored.factories.blocks!.factory.maxTurnsPerStage).toBe(80);
  });

  it("refreshes_settings_and_history_after_a_save", async () => {
    const { client } = renderSettings();
    client.setQueryData(["history", { showTest: false }], { events: [], taskIds: [] });
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(within(globalForm()).getByLabelText("Turn limit per stage"), { target: { value: "70" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    await screen.findByText("Saved factory defaults.");
    expect(client.getQueryState(["history", { showTest: false }])?.isInvalidated).toBe(true);
    await waitFor(() => expect(client.getQueryData<StoredSettings>(["settings"])?.factories.blocks?.factory.maxTurnsPerStage).toBe(70));
  });

  it("shows_an_error_with_retry_instead_of_the_form_when_settings_cannot_load", async () => {
    const getSettings = vi.spyOn(fakeBoard().owner, "getSettings").mockRejectedValueOnce(new Error("blocks: unavailable"));
    renderSettings();
    expect(await screen.findByText("Could not load the settings.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Factory defaults" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("form", { name: "Factory defaults" })).toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});

describe("Factory settings tab", () => {
  it("asks_to_pick_a_factory_while_all_is_selected", async () => {
    window.localStorage.clear();
    renderSettings();
    expect(await screen.findByText("Pick a factory to see its settings.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Factory defaults" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Factory", { selector: "select" }), { target: { value: "blocks" } });
    expect(await screen.findByRole("form", { name: "Factory defaults" })).toBeInTheDocument();
  });

  it("updates_only_the_scope_of_the_selected_factorys_repo", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api", "ui"])));
    window.localStorage.setItem("factory-board:factory", "delta");
    const write = vi.spyOn(fakeBoard().owner, "updateSettingsScope");
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    expect(screen.queryByRole("row", { name: "iam" })).not.toBeInTheDocument();
    fireEvent.change(within(repoRow("api")).getByLabelText("api turn limit"), { target: { value: "25" } });
    fireEvent.click(within(repoRow("api")).getByRole("button", { name: "Save api" }));
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
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save factory defaults" }));
    await screen.findByText("Saved factory defaults.");
    fireEvent.click(screen.getByRole("switch", { name: "Pause factory" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pause factory" })).toBeChecked());
    expect(write.mock.calls.map((call) => call[0])).toEqual(["delta", "delta"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.factories.delta!.factory).toMatchObject({ maxParallel: 5, paused: true });
    expect(stored.factories.blocks).toBeUndefined();
  });

  it("lists_settings_of_removed_repos_and_resets_them_to_inherit", async () => {
    await fakeBoard().owner.updateSettingsScope("blocks/gone", undefined, { gates: { pr: false }, maxParallel: 3 });
    renderSettings();
    const section = (await screen.findByRole("heading", { name: "Settings for removed repos" })).closest("section")!;
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
    expect(await screen.findByText("Could not load the factories.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("all"));
    expect(screen.getByText("Pick a factory to see its settings.")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps_a_draft_when_another_tab_changes_the_pick", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "4" } });
    window.localStorage.setItem("factory-board:factory", "delta");
    window.dispatchEvent(new StorageEvent("storage", { key: "factory-board:factory", newValue: "delta" }));
    await Promise.resolve();
    expect(within(globalForm()).getByLabelText("Max parallel tasks")).toHaveValue("4");
    expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("blocks");
  });

  it("applies_a_pick_in_this_tab_even_when_it_cannot_be_stored", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"])));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    renderSettings();
    await screen.findByRole("form", { name: "Factory defaults" });
    fireEvent.change(screen.getByLabelText("Factory", { selector: "select" }), { target: { value: "delta" } });
    await waitFor(() => expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("delta"));
    cleanup();
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("delta");
  });

  it("shows_no_removed_repo_section_when_every_scope_has_its_repo", async () => {
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
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
    const pause = await screen.findByRole("switch", { name: "Pause factory" });
    expect(screen.queryByText("Factory paused")).not.toBeInTheDocument();
    fireEvent.click(pause);
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pause factory" })).toBeChecked());
    expect(write.mock.calls.map((call) => [call[0], (call[2] as { paused: boolean }).paused])).toEqual([["blocks", true]]);
    expect((await fakeBoard().owner.getSettings()).factories.blocks!.factory.paused).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Pause factory" }));
    await waitFor(() => expect(screen.queryByText("Factory paused")).not.toBeInTheDocument());
    expect((await fakeBoard().owner.getSettings()).factories.blocks!.factory.paused).toBe(false);
  });

  it("shows_why_a_pause_was_not_saved", async () => {
    vi.spyOn(fakeBoard().owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "Pause factory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    expect(screen.getByRole("switch", { name: "Pause factory" })).not.toBeChecked();
  });
});
