import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_STATUS_MAP } from "@factory/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksFactories, factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { SettingsView } from "./SettingsView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

async function openFactoriesSection() {
  const view = renderWithClient(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Manage factories" }));
  await screen.findByRole("link", { name: "Add factory" });
  const delta = await screen.findByRole("button", { name: /Delta delta/ }).catch(() => null);
  if (delta) fireEvent.click(delta);
  return view;
}

const owner = () => fakeBoard().owner;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
/** Clicks Add check, then fills row n. */
function addCheck(n: number, name: string, cwd: string, run: string, needs = "") {
  click("Add check");
  changeField(`Check ${n} name`, name);
  changeField(`Check ${n} folder`, cwd);
  changeField(`Check ${n} command`, run);
  if (needs) changeField(`Check ${n} needs`, needs);
}
const changeField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"], { name: "Delta" })));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Factories tab", () => {
  it("lists_each_factory_with_its_id_active_flag_protected_branches_and_repos", async () => {
    await openFactoriesSection();
    const delta = await screen.findByRole("region", { name: "Factory delta" });
    expect(within(delta).getByRole("heading", { name: "Delta" })).toBeInTheDocument();
    expect(within(delta).getByText("Active")).toBeInTheDocument();
    expect(within(delta).getByText("dev, stg, main")).toBeInTheDocument();
    expect(within(delta).getByText("api")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Factory blocks" })).toBeInTheDocument();
  });

  it("renders_the_gh_login_with_its_state_from_a_health_row_and_unknown_without_one", async () => {
    await fakeBoard().core.setFactoryHealth({ checkedAt: "2026-11-10T08:00:00.000Z", factoryId: "delta", ghLoggedIn: false });
    await fakeBoard().core.setFactoryHealth({ checkedAt: "2026-11-10T08:00:00.000Z", factoryId: "blocks", ghLoggedIn: true });
    await openFactoriesSection();
    const delta = await screen.findByRole("region", { name: "Factory delta" });
    await waitFor(() => expect(within(delta).getByText("gh signed out")).toHaveClass("sf-chip"));
    expect(within(delta).getByText("GitHub login gh-delta")).toBeInTheDocument();
    expect(within(delta).getByText(/checked/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Factory blocks" })).getByText("gh signed in")).toHaveClass("sf-chip");
    cleanup();
    resetFakeBoard(factory("alpha", ["api"]));
    await openFactoriesSection();
    expect(within(await screen.findByRole("region", { name: "Factory alpha" })).getByText("gh unknown")).toHaveClass("sf-chip");
  });

  it("lists_each_factory_with_name_login_chip_and_edit", async () => {
    await openFactoriesSection();
    const section = screen.getByRole("region", { name: "Manage factories" });
    expect(within(section).getByRole("region", { name: "Factory blocks" })).toBeInTheDocument();
    const delta = within(section).getByRole("region", { name: "Factory delta" });
    expect(within(delta).getByRole("heading", { name: "Delta" })).toBeInTheDocument();
    expect(within(delta).getByText("GitHub login gh-delta")).toBeInTheDocument();
    expect(within(delta).getByRole("button", { name: "Edit factory delta" })).toBeInTheDocument();
    expect(delta.querySelectorAll(".sf-chip")).toHaveLength(1);
  });

  it("add_factory_links_to_the_new_factory_page_and_no_inline_form", async () => {
    const onNavigate = vi.fn();
    renderWithClient(<SettingsView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("tab", { name: "Manage factories" }));
    const section = await screen.findByRole("region", { name: "Manage factories" });
    const link = await within(section).findByRole("link", { name: "Add factory" });
    expect(link).toHaveAttribute("href", "/settings/factories/new");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("/settings/factories/new");
    expect(screen.queryByRole("form", { name: "Add factory" })).not.toBeInTheDocument();
  });

  it("keeps_the_id_read_only_once_the_factory_exists", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    expect(within(form).getByLabelText("Factory id")).toHaveAttribute("readonly");
    changeField("Name", "Delta Two");
    fireEvent.click(within(form).getByRole("button", { name: "Save factory" }));
    await screen.findByText("Saved factory delta.");
    expect((await owner().listFactoryDefs()).find((d) => d.factoryId === "delta")).toMatchObject({ name: "Delta Two", version: 2 });
    expect((await owner().listEvents("-")).find((e) => e.field === "def.name")).toMatchObject({ from: "Delta", to: "Delta Two", factoryId: "delta", actor: "you" });
  });

  it("shows_one_model_picker_per_stage_with_same_as_session_by_default", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    for (const label of ["Spec model", "Plan model", "Build model", "Verify model", "Review model"]) {
      const select = within(form).getByRole("combobox", { name: label });
      expect(within(form).getByLabelText(label)).toBe(select);
      expect(select).toHaveValue("");
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Same as session", "Opus", "Sonnet", "Haiku", "Fable"]);
    }
  });

  it("saves_a_chosen_model_under_its_stage_and_leaves_same_as_session_out", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    changeField("Build model", "sonnet");
    changeField("Review model", "fable");
    fireEvent.click(within(form).getByRole("button", { name: "Save factory" }));
    await screen.findByText("Saved factory delta.");
    const saved = (await owner().listFactoryDefs()).find((d) => d.factoryId === "delta");
    expect(saved?.agentModels).toEqual({ build: "sonnet", review: "fable" });

    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const edit = await screen.findByRole("form", { name: "Edit factory delta" });
    expect(within(edit).getByLabelText("Build model")).toHaveValue("sonnet");
    changeField("Build model", "");
    fireEvent.click(within(edit).getByRole("button", { name: "Save factory" }));
    await screen.findByText("Saved factory delta.");
    const edited = (await owner().listFactoryDefs()).find((d) => d.factoryId === "delta");
    expect(edited?.agentModels).toEqual({ review: "fable" });
  });

  it("shows_the_changed_message_with_reload_on_a_conflict_and_reloads_the_latest", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    changeField("Name", "Mine");
    const current = (await owner().listFactoryDefs()).find((d) => d.factoryId === "delta")!;
    await owner().saveFactoryDef(current, { ...current, name: "Theirs" });
    fireEvent.click(within(form).getByRole("button", { name: "Save factory" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("This definition changed elsewhere. Reload to see the latest.");
    fireEvent.click(within(form).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Theirs"));
    fireEvent.click(within(form).getByRole("button", { name: "Save factory" }));
    await screen.findByText("Saved factory delta.");
  });

  it("adds_a_repo_to_a_factory_with_repo_id_fixed_afterwards", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "web");
    changeField("Remote", "git@github.com:org/web.git");
    addCheck(1, "build", "server", "make build");
    addCheck(2, "test", "server", "make test", "build");
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    await screen.findByText("Saved repo web of delta.");
    expect((await owner().listFactoryRepos("delta"))[1]!.checks).toEqual([
      { name: "build", cwd: "server", run: "make build" }, { name: "test", cwd: "server", run: "make test", needs: "build" }
    ]);
    expect((await owner().listFactoryRepos("delta")).map((r) => r.repoId)).toEqual(["api", "web"]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/web" }));
    expect(within(await screen.findByRole("form", { name: "Edit repo web" })).getByLabelText("Repo id")).toHaveAttribute("readonly");
  });

  it("refuses_a_repo_with_a_base_of_main_or_invalid_checks", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "web");
    changeField("Remote", "git@github.com:org/web.git");
    changeField("Base branch", "main");
    addCheck(1, "build", ".", "make");
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("main is never a base");
    changeField("Base branch", "dev");
    addCheck(2, "build", ".", "make again");
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("duplicate check name build");
    expect(save).not.toHaveBeenCalled();
  });

  it("reorders and removes checks", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    click("Remove check 6");
    click("Remove check 5");
    click("Remove check 4");
    click("Remove check 3");
    click("Remove check 2");
    expect(screen.queryByLabelText("Check 2 name")).toBeNull();
    addCheck(2, "extra", ".", "x");
    expect(within(form).getByLabelText("Check 2 needs").querySelectorAll("option")).toHaveLength(2);
    click("Move check 2 up");
    expect(screen.getByLabelText("Check 1 name")).toHaveValue("extra");
    expect(screen.getByLabelText("Check 2 name")).toHaveValue("server.build");
    expect(screen.getByRole("button", { name: "Move check 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move check 2 down" })).toBeDisabled();
  });

  it("an old-shape repo opens as its six checks", async () => {
    const old = { server: { cwd: "server", build: "b", test: "t" }, client: { cwd: "client", install: "i", typecheck: "tc", lint: "l", test: "t" }, e2e: "off" };
    fakeBoard().ownerData.seed("FactoryRepo", { baseBranch: "dev", checks: JSON.stringify(old), factoryId: "delta", remote: "git@github.com:org/old.git", repoId: "old", repoKey: "delta/old", version: 1, writeId: "" });
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/old" }));
    await screen.findByRole("form", { name: "Edit repo old" });
    expect(screen.getByLabelText("Check 1 name")).toHaveValue("server.build");
    expect(screen.getByLabelText("Check 6 name")).toHaveValue("client.test");
    expect(screen.getByLabelText("Check 6 needs")).toHaveValue("client.install");
    expect(screen.queryByLabelText("Check 7 name")).toBeNull();
  });

  it("saves_a_checks_change_only_after_confirm_change_and_records_a_history_event", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    changeField("Check 2 command", "npm run test:all");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    const review = await within(form).findByRole("region", { name: "Checks change" });
    expect(within(review).getByLabelText("Old checks")).toHaveTextContent('"run": "t"');
    expect(within(review).getByLabelText("New checks")).toHaveTextContent('"run": "npm run test:all"');
    expect(save).not.toHaveBeenCalled();
    expect((await owner().listFactoryRepos("delta"))[0]!.checks.find((c) => c.name === "server.test")!.run).toBe("t");

    fireEvent.click(within(review).getByRole("button", { name: "Confirm change" }));
    await screen.findByText("Saved repo api of delta.");
    expect(save).toHaveBeenCalledTimes(1);
    expect((await owner().listFactoryRepos("delta"))[0]!.checks.find((c) => c.name === "server.test")!.run).toBe("npm run test:all");
    const event = (await owner().listEvents("-")).find((e) => e.field === "repo.api.checks");
    expect(event).toMatchObject({ actor: "you", factoryId: "delta" });
    expect(event!.to).toContain("npm run test:all");
  });

  it("shows_a_check_error_with_the_form's_1_based_check_label", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    changeField("Check 2 command", "");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/^Check 2 command: must not be empty$/);
    expect(within(form).queryByText(/checks\.1/)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves_a_base_branch_change_without_a_checks_review", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    changeField("Base branch", "stg");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await screen.findByText("Saved repo api of delta.");
    expect((await owner().listFactoryRepos("delta"))[0]!.baseBranch).toBe("stg");
  });

  it("lists_skipped_definitions_with_the_reason_and_never_a_gate_id", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("Bad_One", []), factory("GATE-gate", ["x"])));
    await openFactoriesSection();
    const summary = await screen.findByText("Skipped definitions (1)");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Bad_One").closest("li")).toHaveTextContent("factoryId must match");
    expect(screen.queryByText(/GATE-gate/)).not.toBeInTheDocument();
  });

  it("shows_no_skipped_list_when_every_definition_is_valid", async () => {
    await openFactoriesSection();
    await screen.findByRole("region", { name: "Factory delta" });
    expect(screen.queryByText(/Skipped definitions/)).not.toBeInTheDocument();
  });

  it("says_an_added_repo_id_already_exists_and_keeps_the_draft", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "api");
    changeField("Remote", "git@github.com:org/api2.git");
    addCheck(1, "build", ".", "make");
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Repo api already exists in delta. Pick another id.");
    expect(within(form).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote")).toHaveValue("git@github.com:org/api2.git");
  });
});

describe("Factories tab restyle", () => {
  it("form_labels_and_inputs_follow_the_design", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    const labels = Array.from(form.querySelectorAll("label.sf-field-label"));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const control = form.querySelector(`#${CSS.escape(label.getAttribute("for") ?? "")}`);
      expect(control, label.textContent ?? "").not.toBeNull();
      if (control?.tagName === "INPUT" || control?.tagName === "TEXTAREA") expect(control, label.textContent ?? "").toHaveClass("sf-input");
    }
    expect(within(form).getByRole("button", { name: "Save factory" })).toHaveClass("sf-button-primary");
    expect(within(form).getByRole("button", { name: "Cancel" })).not.toHaveClass("sf-button-primary");
  });

  it("repo_form_inputs_are_outlined_and_actions_split", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    for (const name of ["Repo id", "Remote", "Base branch"]) expect(within(form).getByLabelText(name), name).toHaveClass("sf-input");
    expect(within(form).getByRole("button", { name: "Add repo" })).toHaveClass("sf-button-primary");
    expect(within(form).getByRole("button", { name: "Cancel" })).not.toHaveClass("sf-button-primary");
  });

  it("edit_save_is_primary", async () => {
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: /Edit factory/ });
    expect(within(form).getByRole("button", { name: "Save factory" })).toHaveClass("sf-button-primary");
  });

  it("checks_change_stops_at_review_and_only_confirm_and_save_are_primary", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    changeField("Check 2 command", "x");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await within(form).findByRole("region", { name: "Checks change" });
    expect(save).not.toHaveBeenCalled();
    const primary = within(form).getAllByRole("button").filter((b) => b.classList.contains("sf-button-primary")).map((b) => b.textContent);
    expect(primary.sort()).toEqual(["Confirm change", "Save repo"]);
  });
});

it("preserves a dirty factory form when switching editors is declined", async () => {
  await openFactoriesSection();
  fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
  changeField("Name", "Unfinished name");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Add repo to delta" }));
  expect(confirm).toHaveBeenCalled();
  expect(screen.getByLabelText("Name")).toHaveValue("Unfinished name");
  expect(screen.queryByRole("form", { name: "Add repo to delta" })).toBeNull();
});

it("filters factories by id and clears the search", async () => {
  await openFactoriesSection();
  fireEvent.change(screen.getByLabelText("Search factories"), { target: { value: "blocks" } });
  expect(screen.getByRole("region", { name: "Factory blocks" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Factory delta" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("region", { name: "Factory delta" })).toBeInTheDocument();
});

it("a_connected_factory_shows_watcher_seen_not_seen_since_or_not_running", async () => {
  const github = { mode: "connected" as const, project: { owner: "o", number: 3 }, label: "factory", approvers: ["a"], statusMap: DEFAULT_STATUS_MAP };
  resetFakeBoard(merge(factory("blocks", ["os"], { github }), factory("delta", ["api"], { name: "Delta", github }), factory("echo", ["api"], { name: "Echo", github })));
  const recent = new Date(Date.now() - 10_000).toISOString();
  await fakeBoard().core.setFactoryHealth({ checkedAt: recent, factoryId: "blocks", ghLoggedIn: true, watcherSeenAt: recent });
  await fakeBoard().core.setFactoryHealth({ checkedAt: recent, factoryId: "delta", ghLoggedIn: true, watcherSeenAt: "2026-01-01T00:00:00.000Z" });
  await openFactoriesSection();
  const chip = async (id: string) => (await screen.findByRole("region", { name: `Factory ${id}` })).querySelector(".sf-watcher");
  await waitFor(() => expect(screen.getByRole("region", { name: "Factory blocks" }).querySelector(".sf-watcher")).toHaveTextContent(/^watcher seen /));
  expect(await chip("delta")).toHaveTextContent(/^watcher not seen since /);
  expect(await chip("echo")).toHaveTextContent("watcher not running");
});

it("a_factory_that_is_not_connected_shows_no_watcher_chip", async () => {
  const github = { mode: "github-only" as const, project: { owner: "o", number: 3 }, label: "factory", approvers: ["a"], statusMap: DEFAULT_STATUS_MAP };
  resetFakeBoard(merge(factory("blocks", ["os"]), factory("delta", ["api"], { name: "Delta", github })));
  await openFactoriesSection();
  await screen.findByRole("region", { name: "Factory delta" });
  expect(screen.getByRole("region", { name: "Factory blocks" }).querySelector(".sf-watcher")).toBeNull();
  expect(screen.getByRole("region", { name: "Factory delta" }).querySelector(".sf-watcher")).toBeNull();
});
