import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checksFixtureForTests } from "./testChecks";
import { blocksFactories, factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { SettingsView } from "./SettingsView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

async function openFactoriesTab() {
  const view = renderWithClient(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Factories" }));
  await screen.findByRole("button", { name: "Add factory" });
  return view;
}

const owner = () => fakeBoard().owner;
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
    await openFactoriesTab();
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
    await openFactoriesTab();
    const delta = await screen.findByRole("region", { name: "Factory delta" });
    await waitFor(() => expect(within(delta).getByText("not logged in")).toBeInTheDocument());
    expect(within(delta).getByText("GitHub login")).toBeInTheDocument();
    expect(within(delta).getByText("gh-delta")).toBeInTheDocument();
    expect(within(delta).getByText(/checked/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Factory blocks" })).getByText("logged in")).toBeInTheDocument();
    cleanup();
    resetFakeBoard(factory("alpha", ["api"]));
    await openFactoriesTab();
    expect(within(await screen.findByRole("region", { name: "Factory alpha" })).getByText("unknown")).toBeInTheDocument();
  });

  it("creates_a_factory_whose_protected_branches_always_include_main", async () => {
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    changeField("Factory id", "echo");
    changeField("Name", "Echo");
    fireEvent.click(within(form).getByRole("button", { name: "Remove dev" }));
    fireEvent.click(within(form).getByRole("button", { name: "Remove stg" }));
    changeField("Branch to protect", "rel");
    fireEvent.click(within(form).getByRole("button", { name: "Add branch" }));
    fireEvent.click(within(form).getByRole("button", { name: "Create factory" }));
    await screen.findByText("Created factory echo.");
    const saved = (await owner().listFactoryDefs()).find((d) => d.factoryId === "echo");
    // The GitHub login was left empty: the core default is what is saved.
    expect(saved).toMatchObject({ active: true, ghUser: "kazi-lakit", name: "Echo", protectedBranches: ["rel", "main"] });
    expect((await owner().listEvents("-")).map((e) => e.field)).toContain("def.protectedBranches");
    expect(await screen.findByRole("region", { name: "Factory echo" })).toBeInTheDocument();
  });

  it("labels_the_github_login_with_its_hint_and_saves_the_login_given", async () => {
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    expect(within(form).getByLabelText("GitHub login")).toHaveAccessibleDescription(
      "The gh CLI account the factory opens PRs with (gh auth login on this Mac). Empty uses kazi-lakit."
    );
    changeField("Factory id", "echo");
    changeField("Name", "Echo");
    changeField("GitHub login", " octocat ");
    fireEvent.click(within(form).getByRole("button", { name: "Create factory" }));
    await screen.findByText("Created factory echo.");
    expect((await owner().listFactoryDefs()).find((d) => d.factoryId === "echo")).toMatchObject({ ghUser: "octocat" });
  });

  it("refuses_a_github_login_that_is_not_one_and_saves_nothing", async () => {
    const save = vi.spyOn(owner(), "saveFactoryDef");
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    changeField("Factory id", "echo");
    changeField("Name", "Echo");
    changeField("GitHub login", "keychain:echo");
    fireEvent.click(within(form).getByRole("button", { name: "Create factory" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("ghUser must be a GitHub login");
    expect(save).not.toHaveBeenCalled();
  });

  it("offers_no_way_to_remove_main", async () => {
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    expect(within(form).getByText("main")).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: "Remove main" })).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Remove dev" })).toBeInTheDocument();
  });

  it("shows_the_validation_message_for_an_invalid_id_and_saves_nothing", async () => {
    const save = vi.spyOn(owner(), "saveFactoryDef");
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    changeField("Factory id", "Bad_ID");
    changeField("Name", "Bad");
    fireEvent.click(within(form).getByRole("button", { name: "Create factory" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("factoryId must match");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps_the_id_read_only_once_the_factory_exists", async () => {
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit factory delta" }));
    const form = await screen.findByRole("form", { name: "Edit factory delta" });
    expect(within(form).getByLabelText("Factory id")).toHaveAttribute("readonly");
    changeField("Name", "Delta Two");
    fireEvent.click(within(form).getByRole("button", { name: "Save factory" }));
    await screen.findByText("Saved factory delta.");
    expect((await owner().listFactoryDefs()).find((d) => d.factoryId === "delta")).toMatchObject({ name: "Delta Two", version: 2 });
    expect((await owner().listEvents("-")).find((e) => e.field === "def.name")).toMatchObject({ from: "Delta", to: "Delta Two", factoryId: "delta", actor: "you" });
  });

  it("shows_the_changed_message_with_reload_on_a_conflict_and_reloads_the_latest", async () => {
    await openFactoriesTab();
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
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "web");
    changeField("Remote", "git@github.com:org/web.git");
    changeField("Checks (JSON)", JSON.stringify(checksFixtureForTests));
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    await screen.findByText("Saved repo web of delta.");
    expect((await owner().listFactoryRepos("delta")).map((r) => r.repoId)).toEqual(["api", "web"]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/web" }));
    expect(within(await screen.findByRole("form", { name: "Edit repo web" })).getByLabelText("Repo id")).toHaveAttribute("readonly");
  });

  it("refuses_a_repo_with_a_base_of_main_or_checks_that_are_not_json", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "web");
    changeField("Remote", "git@github.com:org/web.git");
    changeField("Base branch", "main");
    changeField("Checks (JSON)", JSON.stringify(checksFixtureForTests));
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("main is never a base");
    changeField("Base branch", "dev");
    changeField("Checks (JSON)", "{nope");
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("checks must be valid JSON");
    expect(save).not.toHaveBeenCalled();
  });

  it("saves_a_checks_change_only_after_confirm_change_and_records_a_history_event", async () => {
    const save = vi.spyOn(owner(), "saveFactoryRepo");
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    const checks = JSON.parse((within(form).getByLabelText("Checks (JSON)") as HTMLTextAreaElement).value) as typeof checksFixtureForTests;
    changeField("Checks (JSON)", JSON.stringify({ ...checks, server: { ...checks.server, test: "npm run test:all" } }));
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    const review = await within(form).findByRole("region", { name: "Checks change" });
    expect(within(review).getByLabelText("Old checks")).toHaveTextContent('"test": "t"');
    expect(within(review).getByLabelText("New checks")).toHaveTextContent('"test": "npm run test:all"');
    expect(save).not.toHaveBeenCalled();
    expect((await owner().listFactoryRepos("delta"))[0]!.checks.server.test).toBe("t");

    fireEvent.click(within(review).getByRole("button", { name: "Confirm change" }));
    await screen.findByText("Saved repo api of delta.");
    expect(save).toHaveBeenCalledTimes(1);
    expect((await owner().listFactoryRepos("delta"))[0]!.checks.server.test).toBe("npm run test:all");
    const event = (await owner().listEvents("-")).find((e) => e.field === "repo.api.checks");
    expect(event).toMatchObject({ actor: "you", factoryId: "delta" });
    expect(event!.to).toContain("npm run test:all");
  });

  it("saves_a_base_branch_change_without_a_checks_review", async () => {
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit repo delta/api" }));
    const form = await screen.findByRole("form", { name: "Edit repo api" });
    changeField("Base branch", "stg");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await screen.findByText("Saved repo api of delta.");
    expect((await owner().listFactoryRepos("delta"))[0]!.baseBranch).toBe("stg");
  });

  it("lists_skipped_definitions_with_the_reason_and_never_a_gate_id", async () => {
    resetFakeBoard(merge(blocksFactories(), factory("Bad_One", []), factory("GATE-gate", ["x"])));
    await openFactoriesTab();
    const summary = await screen.findByText("Skipped definitions (1)");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Bad_One").closest("li")).toHaveTextContent("factoryId must match");
    expect(screen.queryByText(/GATE-gate/)).not.toBeInTheDocument();
  });

  it("shows_no_skipped_list_when_every_definition_is_valid", async () => {
    await openFactoriesTab();
    await screen.findByRole("region", { name: "Factory delta" });
    expect(screen.queryByText(/Skipped definitions/)).not.toBeInTheDocument();
  });

  it("says_an_added_factory_id_already_exists_instead_of_a_reload_conflict_and_keeps_the_draft", async () => {
    await openFactoriesTab();
    fireEvent.click(screen.getByRole("button", { name: "Add factory" }));
    const form = await screen.findByRole("form", { name: "Add factory" });
    changeField("Factory id", "delta");
    changeField("Name", "Again");
    fireEvent.click(within(form).getByRole("button", { name: "Create factory" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Factory delta already exists. Pick another id.");
    expect(within(form).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Again");
  });

  it("says_an_added_repo_id_already_exists_and_keeps_the_draft", async () => {
    await openFactoriesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Add repo to delta" }));
    const form = await screen.findByRole("form", { name: "Add repo to delta" });
    changeField("Repo id", "api");
    changeField("Remote", "git@github.com:org/api2.git");
    changeField("Checks (JSON)", JSON.stringify(checksFixtureForTests));
    fireEvent.click(within(form).getByRole("button", { name: "Add repo" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Repo api already exists in delta. Pick another id.");
    expect(within(form).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote")).toHaveValue("git@github.com:org/api2.git");
  });
});
