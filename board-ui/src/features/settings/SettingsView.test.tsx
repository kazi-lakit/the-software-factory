import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSettings, VersionConflictError } from "@factory/core";
import { AppShell } from "../../app/AppShell";
import { AuthProvider } from "../../app/providers/AuthProvider";
import { blocksClient } from "../../lib/blocks/client";
import { fetchSessionClaims } from "../../lib/blocks/auth";
import { clearAllUnsent } from "../../lib/unsent";
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

const globalForm = () => screen.getByRole("form", { name: "Global settings" });
const repoRow = (repo: string) => screen.getByRole("row", { name: repo });

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("SettingsView", () => {
  it("shows_the_global_settings_and_the_pr_gate_note", async () => {
    renderSettings();
    await screen.findByRole("form", { name: "Global settings" });
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

  it("lists_the_seven_repos_with_inherit_on_off_per_gate", async () => {
    await saveSettings(fakeBoard().owner, now, "iam", { gates: { pr: false }, maxTurnsPerStage: 30 });
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
    await screen.findByRole("form", { name: "Global settings" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "0" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save global settings" }));
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
    await screen.findByRole("form", { name: "Global settings" });
    fireEvent.click(within(globalForm()).getByRole("switch", { name: "Plan gate" }));
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "4" } });
    fireEvent.change(within(globalForm()).getByLabelText("Cost limit per task (USD)"), { target: { value: "7.5" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save global settings" }));
    await screen.findByText("Saved global settings.");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe("global");
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.global).toEqual({ gates: { spec: true, plan: true, pr: true }, maxParallel: 4, maxTurnsPerStage: 60, maxCostPerTaskUsd: 7.5, paused: false });
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
    expect(write.mock.calls.map((call) => call[0])).toEqual(["iam"]);
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.repos).toEqual({ iam: { gates: { spec: false }, maxTurnsPerStage: 25 } });
    expect(stored.global.maxParallel).toBe(2);
    expect(within(repoRow("data")).getByRole("combobox", { name: "data PR gate" })).toHaveValue("off");
  });

  it("sends_inherit_as_null_so_the_repo_takes_the_global_value_again", async () => {
    await saveSettings(fakeBoard().owner, now, "data", { gates: { pr: false, spec: true }, maxCostPerTaskUsd: 2 });
    renderSettings();
    await screen.findByRole("table", { name: "Repo overrides" });
    const row = repoRow("data");
    expect(within(row).getByRole("combobox", { name: "data PR gate" })).toHaveValue("off");
    fireEvent.change(within(row).getByRole("combobox", { name: "data PR gate" }), { target: { value: "inherit" } });
    fireEvent.change(within(row).getByLabelText("data cost limit"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save data" }));
    await screen.findByText("Saved data settings.");
    const stored = await fakeBoard().owner.getSettings();
    expect(stored.repos.data).toEqual({ gates: { spec: true } });
    const events = await fakeBoard().owner.listEvents("-");
    expect(events.filter((e) => e.at !== now().toISOString()).map((e) => [e.field, e.to]).sort()).toEqual([
      ["settings.data.maxCostPerTaskUsd", "inherit"],
      ["settings.data.gates", '{"spec":true}']
    ].sort());
  });

  it("keeps_unsaved_edits_through_a_conflict_and_reload", async () => {
    const owner = fakeBoard().owner;
    renderSettings();
    await screen.findByRole("form", { name: "Global settings" });
    fireEvent.change(within(globalForm()).getByLabelText("Max parallel tasks"), { target: { value: "4" } });
    // Someone else saves the turn limit, and this save loses the race.
    await saveSettings(owner, now, "global", { maxTurnsPerStage: 80 });
    vi.spyOn(owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save global settings" }));
    expect(await within(globalForm()).findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(within(globalForm()).getByLabelText("Turn limit per stage")).toHaveValue("80"));
    expect(within(globalForm()).getByLabelText("Max parallel tasks")).toHaveValue("4");
    expect(within(globalForm()).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save global settings" }));
    await screen.findByText("Saved global settings.");
    const stored = await owner.getSettings();
    expect(stored.global.maxParallel).toBe(4);
    expect(stored.global.maxTurnsPerStage).toBe(80);
  });

  it("refreshes_settings_and_history_after_a_save", async () => {
    const { client } = renderSettings();
    client.setQueryData(["history", { showTest: false }], { events: [], taskIds: [] });
    await screen.findByRole("form", { name: "Global settings" });
    fireEvent.change(within(globalForm()).getByLabelText("Turn limit per stage"), { target: { value: "70" } });
    fireEvent.click(within(globalForm()).getByRole("button", { name: "Save global settings" }));
    await screen.findByText("Saved global settings.");
    expect(client.getQueryState(["history", { showTest: false }])?.isInvalidated).toBe(true);
    await waitFor(() => expect(client.getQueryData<{ global: { maxTurnsPerStage: number } }>(["settings"])?.global.maxTurnsPerStage).toBe(70));
  });

  it("shows_an_error_with_retry_instead_of_the_form_when_settings_cannot_load", async () => {
    const getSettings = vi.spyOn(fakeBoard().owner, "getSettings").mockRejectedValueOnce(new Error("blocks: unavailable"));
    renderSettings();
    expect(await screen.findByText("Could not load the settings.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Global settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("form", { name: "Global settings" })).toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(2);
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
    expect(write.mock.calls.map((call) => [call[0], (call[2] as { paused: boolean }).paused])).toEqual([["global", true]]);
    expect((await fakeBoard().owner.getSettings()).global.paused).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Pause factory" }));
    await waitFor(() => expect(screen.queryByText("Factory paused")).not.toBeInTheDocument());
    expect((await fakeBoard().owner.getSettings()).global.paused).toBe(false);
  });

  it("shows_why_a_pause_was_not_saved", async () => {
    vi.spyOn(fakeBoard().owner, "updateSettingsScope").mockRejectedValueOnce(new VersionConflictError("settings global", Number.NaN, Number.NaN, "changed"));
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "Pause factory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings changed elsewhere. Reload to see the latest.");
    expect(screen.getByRole("switch", { name: "Pause factory" })).not.toBeChecked();
  });
});
