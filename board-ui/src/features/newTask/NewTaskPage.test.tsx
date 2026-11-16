import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, saveSettings } from "@factory/core";
import { clearAllUnsent, keepUnsent } from "../../lib/unsent";
import { factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TopBarLeadContext, type Lead } from "../../app/topBarLead";
import { resetSelectedFactoryForTests, SELECTED_FACTORY_KEY } from "../factories/useFactories";
import { now } from "../task/writeOutcome";
import { peekReadyProblem } from "./createdNotice";
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../../test/phoneWidth";
import { NewTaskPage } from "./NewTaskPage";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const READY_LABEL = "Mark ready now, so the factory starts it at its next sync";
const DESCRIPTION_HINT = "Plain words are fine. Acceptance criteria help the spec writer; it asks you if something is unclear.";
const BASE_HINT = "dev or stg. The factory never targets main.";
const STEPS = [
  "The spec writer turns this into a spec with acceptance criteria.",
  "You approve the spec (or ask for changes).",
  "The factory plans, builds test-first, checks, verifies and reviews.",
  "It opens a PR into the base branch. You merge it on GitHub."
];

function renderPage(leads?: Array<Lead | null>) {
  const onNavigate = vi.fn();
  const page = <NewTaskPage onNavigate={onNavigate} />;
  if (!leads) return { onNavigate, ...renderWithClient(page) };
  const setter = (lead: Lead | null) => void leads.push(lead);
  return { onNavigate, ...renderWithClient(<TopBarLeadContext.Provider value={setter}>{page}</TopBarLeadContext.Provider>) };
}

const openForm = () => screen.findByRole("form", { name: "New task" });
const ready = (form: HTMLElement) => within(form).getByRole("switch", { name: READY_LABEL });
const two = () => merge(factory("alpha", ["api", "web"], { name: "Alpha" }), factory("delta", ["api", "ui"], { name: "Delta" }));
/** A paragraph whose whole text (across its link) is `text`. */
const paragraph = (text: string) => screen.queryByText((_, el) => el?.tagName === "P" && el.textContent === text);

async function createdPath(): Promise<string> {
  const [stored] = await fakeBoard().owner.listTasks();
  return `/tasks/${stored!.taskId}`;
}

beforeEach(() => {
  resetFakeBoard();
  resetSelectedFactoryForTests();
  window.history.replaceState({}, "", "/tasks/new");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetSelectedFactoryForTests();
  window.history.replaceState({}, "", "/tasks/new");
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("NewTaskPage layout", () => {
  it("shows_breadcrumb_and_h1", async () => {
    const { onNavigate } = renderPage();
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const board = within(nav).getByRole("link", { name: "Board" });
    expect(board).toHaveAttribute("href", "/");
    expect(nav).toHaveTextContent("New task");
    expect(screen.getByRole("heading", { level: 1, name: "New task" })).toHaveClass("sf-page-title");
    fireEvent.click(board);
    expect(onNavigate).toHaveBeenCalledWith("/");
    await openForm();
  });

  it("form_fields_are_in_order", async () => {
    await seedTask({ title: "Dep" });
    renderPage();
    const form = await openForm();
    await within(form).findByLabelText("Waits for");
    const controls = ["Factory", "Repo", "Title", "What do you want done?", "Base branch", "Waits for"].map((name) => within(form).getByLabelText(name));
    const sw = ready(form);
    const all = [...controls, sw];
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.compareDocumentPosition(all[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(sw).not.toBeChecked();
    expect(sw.closest("label")).toHaveClass("sf-switch");
    const create = within(form).getByRole("button", { name: "Create task" });
    const cancel = within(form).getByRole("button", { name: "Cancel" });
    expect(sw.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create).toHaveClass("sf-button", "sf-button-primary");
    expect(create).toHaveAttribute("type", "submit");
    expect(cancel).toHaveClass("sf-button", "sf-action-close");
    expect(cancel).not.toHaveClass("sf-button-primary");
    expect(create.parentElement).toHaveClass("sf-actions", "sf-action-bar");
    expect(create.parentElement).toContainElement(cancel);
    expect(form).toHaveClass("sf-form", "sf-panel");
  });

  it("hints_are_described_by", async () => {
    renderPage();
    const form = await openForm();
    const hintOf = (label: string) => document.getElementById(within(form).getByLabelText(label).getAttribute("aria-describedby") ?? "");
    expect(hintOf("What do you want done?")).toHaveTextContent(DESCRIPTION_HINT);
    expect(hintOf("What do you want done?")).toHaveClass("sf-hint");
    expect(hintOf("Base branch")).toHaveTextContent(BASE_HINT);
    expect(hintOf("Base branch")).toHaveClass("sf-hint");
  });

  it("title_has_autofocus", async () => {
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Title")).toHaveFocus();
  });

  it("aside_lists_the_four_steps", async () => {
    renderPage();
    const aside = screen.getByRole("complementary", { name: "What happens next" });
    expect(aside).toHaveClass("sf-panel");
    const items = within(within(aside).getByRole("list")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(STEPS);
    expect(within(aside).getByRole("list").tagName).toBe("OL");
    await openForm();
  });

  it("gates_line_shows_the_factory_gates_and_settings_link", async () => {
    const { onNavigate } = renderPage();
    await openForm();
    await waitFor(() => expect(paragraph("Gates you have on: Spec, PR. Change them in Settings.")).not.toBeNull());
    expect(paragraph("Gates you have on: Spec, PR. Change them in Settings.")).toHaveClass("sf-hint");
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/settings");
    fireEvent.click(settings);
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });

  it("gates_line_follows_the_factory_field", async () => {
    resetFakeBoard(two());
    await saveSettings(fakeBoard().owner, now, "delta", { gates: { plan: true, pr: false, spec: false } });
    renderPage();
    const form = await openForm();
    await waitFor(() => expect(paragraph("Gates you have on: Spec, PR. Change them in Settings.")).not.toBeNull());
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(paragraph("Gates you have on: Plan. Change them in Settings.")).not.toBeNull();
  });

  it("gates_line_says_none_when_all_off", async () => {
    await saveSettings(fakeBoard().owner, now, "blocks", { gates: { plan: false, pr: false, spec: false } });
    renderPage();
    await openForm();
    await waitFor(() => expect(paragraph("Gates you have on: none. Change them in Settings.")).not.toBeNull());
  });

  it("gates_line_hidden_while_settings_load", async () => {
    vi.spyOn(fakeBoard().owner, "getSettings").mockReturnValue(new Promise(() => undefined));
    renderPage();
    await openForm();
    expect(screen.queryByText(/Gates you have on/)).toBeNull();
  });

  it("has_no_draft_it_control", async () => {
    renderPage();
    await openForm();
    expect(screen.queryByRole("button", { name: /draft it/i })).toBeNull();
    expect(screen.queryByText(/draft it/i)).toBeNull();
  });

  it("loading_and_failure_states", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = fakeBoard().owner.listFactoryDefs.bind(fakeBoard().owner);
    vi.spyOn(fakeBoard().owner, "listFactoryDefs").mockImplementation(async () => { await gate; return list(); });
    const { container } = renderPage();
    const loading = await screen.findByText("Loading factories…");
    expect(container.querySelector(".sf-new-task-main")).toContainElement(loading);
    release();
    await openForm();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(fakeBoard().owner, "listFactoryDefs").mockRejectedValue(new Error("down"));
    const failed = renderPage();
    const problem = await screen.findByText("Could not load the factories.", {}, { timeout: 5000 });
    expect(failed.container.querySelector(".sf-new-task-main")).toContainElement(problem);
  });
});

describe("NewTaskPage create", () => {
  it("creates_a_task_and_goes_to_its_page", async () => {
    const { onNavigate } = renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Base branch")).toHaveValue("dev");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Add paging" } });
    fireEvent.change(within(form).getByLabelText("What do you want done?"), { target: { value: "Page the list endpoint." } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "iam" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored).toMatchObject({ baseBranch: "dev", description: "Page the list endpoint.", repo: "iam", title: "Add paging" });
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${stored!.taskId}`);
    expect(await fakeBoard().owner.listEvents(stored!.taskId)).toEqual([expect.objectContaining({ action: "create", actor: "you" })]);
  });

  it("asks_for_a_title_before_creating", async () => {
    const { onNavigate } = renderPage();
    fireEvent.click(within(await openForm()).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("title must not be blank");
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps_the_form_text_when_blocks_refuses_it", async () => {
    vi.spyOn(fakeBoard().owner, "createTask").mockRejectedValue(new ForbiddenError("no"));
    renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Keep me" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocks refused this change for your account.");
    expect(within(form).getByLabelText("Title")).toHaveValue("Keep me");
  });

  it("creates_a_task_with_the_picked_dependency", async () => {
    const dep = await seedTask({ title: "Dep" });
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Child" } });
    fireEvent.change(await within(form).findByLabelText("Waits for"), { target: { value: dep.taskId } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    const tasks = await fakeBoard().owner.listTasks();
    expect(tasks.find((x) => x.title === "Child")?.dependsOn).toEqual([dep.taskId]);
  });
});

describe("NewTaskPage with several factories", () => {
  it("lists_only_the_chosen_factorys_repos_and_creates_in_that_factory", async () => {
    resetFakeBoard(two());
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(within(within(form).getByLabelText("Repo")).getAllByRole("option").map((o) => o.textContent)).toEqual(["api", "ui"]);
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "In delta" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(await fakeBoard().owner.listTasks()).toEqual([expect.objectContaining({ factoryId: "delta", repo: "api", title: "In delta" })]);
    expect(onNavigate).toHaveBeenCalledWith(await createdPath());
  });

  it("starts_in_the_picked_factory", async () => {
    resetFakeBoard(two());
    window.localStorage.setItem(SELECTED_FACTORY_KEY, "delta");
    resetSelectedFactoryForTests();
    renderPage();
    expect(within(await openForm()).getByLabelText("Factory")).toHaveValue("delta");
  });

  it("lists_only_valid_factories", async () => {
    resetFakeBoard(merge(two(), factory("GATE-gate", ["api"])));
    renderPage();
    const form = await openForm();
    expect(within(within(form).getByLabelText("Factory")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alpha", "Delta"]);
  });

  it("keeps_the_right_factory_for_an_api_repo_that_two_factories_have", async () => {
    resetFakeBoard(two());
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "api" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Delta api" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect((await fakeBoard().owner.listTasks())[0]).toMatchObject({ factoryId: "delta", repo: "api" });
  });

  it("defaults_the_base_to_the_repos_base_branch_and_follows_a_repo_change", async () => {
    resetFakeBoard({ defs: two().defs, repos: [...two().repos.filter((r) => r.factoryId !== "delta"), ...factory("delta", ["api"]).repos.map((r) => ({ ...r, baseBranch: "stg" })), ...factory("delta", ["ui"]).repos] });
    renderPage();
    const form = await openForm();
    const base = within(form).getByLabelText("Base branch");
    expect(base).toHaveValue("dev");
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(base).toHaveValue("stg");
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "ui" } });
    expect(base).toHaveValue("dev");
    fireEvent.change(base, { target: { value: "release/1" } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "api" } });
    expect(base).toHaveValue("release/1");
  });

  it.each([" Main ", "origin/main", "refs/heads/main"])("refuses_main_as_the_base_inline (%j)", async (value) => {
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("never uses main");
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("NewTaskPage Mark ready now", () => {
  it("mark_ready_now_is_a_shared_switch_off_by_default", async () => {
    renderPage();
    const form = await openForm();
    expect(ready(form)).not.toBeChecked();
    expect(ready(form).closest("label")).toHaveClass("sf-switch");
  });

  it("switch_off_creates_only", async () => {
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Plain" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect((await fakeBoard().owner.listTasks())[0]!.status).toBe("inbox");
  });

  it("switch_on_creates_then_marks_ready_then_navigates", async () => {
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Go now" } });
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(update.mock.invocationCallOrder[0]!).toBeLessThan(onNavigate.mock.invocationCallOrder[0]!);
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored!.status).toBe("ready");
    expect((await fakeBoard().owner.listEvents(stored!.taskId)).length).toBe(2);
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${stored!.taskId}`);
  });

  it("create_failure_never_marks_ready", async () => {
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    renderPage();
    const form = await openForm();
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("title must not be blank");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Keep" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "main" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText(/never uses main as a base/)).toBeInTheDocument();
    create.mockRejectedValueOnce(new ForbiddenError("no"));
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "dev" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Blocks refused this change for your account.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(within(form).getByLabelText("Title")).toHaveValue("Keep");
  });

  it("mark_ready_failure_navigates_and_leaves_the_notice", async () => {
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new ForbiddenError("no"));
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Half" } });
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored!.status).toBe("inbox");
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${stored!.taskId}`);
    expect(peekReadyProblem(stored!.taskId)?.message).toBe("Blocks refused this change for your account.");
  });

  it("submit_disabled_while_in_flight", async () => {
    let release: () => void = () => undefined;
    const real = fakeBoard().owner.createTask.bind(fakeBoard().owner);
    const create = vi.spyOn(fakeBoard().owner, "createTask").mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return real(...args);
    });
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Once" } });
    const button = within(form).getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });

  it("ready_now_is_not_persisted_in_unsent", async () => {
    const first = renderPage();
    fireEvent.click(ready(await openForm()));
    first.unmount();
    renderPage();
    expect(ready(await openForm())).not.toBeChecked();
  });
});

describe("NewTaskPage Cancel and draft", () => {
  it("cancel_navigates_to_the_board_and_keeps_the_draft", async () => {
    const { onNavigate } = renderPage();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Half typed" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(onNavigate).toHaveBeenCalledWith("/");
    cleanup();
    renderPage();
    expect(within(await openForm()).getByLabelText("Title")).toHaveValue("Half typed");
  });

  it("draft_restores_every_field_and_is_cleared_after_create", async () => {
    resetFakeBoard(two());
    const first = renderPage();
    let form = await openForm();
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "ui" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Kept" } });
    fireEvent.change(within(form).getByLabelText("What do you want done?"), { target: { value: "Words" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "stg" } });
    first.unmount();
    const second = renderPage();
    form = await openForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("delta");
    expect(within(form).getByLabelText("Repo")).toHaveValue("ui");
    expect(within(form).getByLabelText("Title")).toHaveValue("Kept");
    expect(within(form).getByLabelText("What do you want done?")).toHaveValue("Words");
    expect(within(form).getByLabelText("Base branch")).toHaveValue("stg");
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(second.onNavigate).toHaveBeenCalled());
    second.unmount();
    renderPage();
    form = await openForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("alpha");
    expect(within(form).getByLabelText("Repo")).toHaveValue("api");
    expect(within(form).getByLabelText("Title")).toHaveValue("");
    expect(within(form).getByLabelText("What do you want done?")).toHaveValue("");
    expect(within(form).getByLabelText("Base branch")).toHaveValue("dev");
  });

  it("registers_Cancel_in_the_top_bar", async () => {
    const leads: Array<Lead | null> = [];
    renderPage(leads);
    await openForm();
    expect(leads[leads.length - 1]?.label).toBe("Cancel");
  });

  it("the_Cancel_lead_navigates_to_the_board_and_keeps_the_draft", async () => {
    const leads: Array<Lead | null> = [];
    const { onNavigate } = renderPage(leads);
    fireEvent.change(within(await openForm()).getByLabelText("Title"), { target: { value: "Half typed" } });
    act(() => leads[leads.length - 1]?.onClick());
    expect(onNavigate).toHaveBeenCalledWith("/");
    cleanup();
    renderPage();
    expect(within(await openForm()).getByLabelText("Title")).toHaveValue("Half typed");
  });
});

describe("NewTaskPage link prefill", () => {
  const link = (query: string) => window.history.replaceState({}, "", `/tasks/new?${query}`);
  const params = (values: Record<string, string>) => new URLSearchParams({ new: "1", ...values }).toString();

  it("opens_the_form_prefilled_from_the_link", async () => {
    link(params({ base: "stg", description: "Fix it & more\nline two #1 é", repo: "iam", title: "Fix the typo" }));
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Title")).toHaveValue("Fix the typo");
    expect(within(form).getByLabelText("What do you want done?")).toHaveValue("Fix it & more\nline two #1 é");
    expect(within(form).getByLabelText("Repo")).toHaveValue("iam");
    expect(within(form).getByLabelText("Base branch")).toHaveValue("stg");
  });

  it("falls_back_to_the_default_repo_and_shows_a_note_for_an_unknown_repo", async () => {
    link(params({ repo: "nope", title: "T" }));
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Repo")).toHaveValue("data");
    expect(screen.getByText('Unknown repo "nope" in the link; pick one.')).toBeInTheDocument();
  });

  it("caps_the_repo_shown_in_the_note_at_40_characters", async () => {
    link(params({ repo: "r".repeat(100), title: "T" }));
    renderPage();
    await openForm();
    expect(screen.getByText(`Unknown repo "${"r".repeat(40)}" in the link; pick one.`)).toBeInTheDocument();
  });

  it("clears_the_note_on_a_repo_change", async () => {
    link(params({ repo: "nope", title: "T" }));
    renderPage();
    const form = await openForm();
    expect(screen.getByText(/Unknown repo/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "iam" } });
    expect(screen.queryByText(/Unknown repo/)).not.toBeInTheDocument();
  });

  it("trims_the_base_and_uses_dev_when_it_is_empty", async () => {
    link(params({ base: "   ", title: "T" }));
    renderPage();
    expect(within(await openForm()).getByLabelText("Base branch")).toHaveValue("dev");
    cleanup();
    clearAllUnsent();
    link(params({ base: "  stg  ", title: "T" }));
    renderPage();
    expect(within(await openForm()).getByLabelText("Base branch")).toHaveValue("stg");
  });

  it("caps_the_title_at_200_and_the_description_at_8000", async () => {
    link(params({ description: "d".repeat(9000), title: "t".repeat(300) }));
    renderPage();
    const form = await openForm();
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toHaveLength(200);
    expect((within(form).getByLabelText("What do you want done?") as HTMLTextAreaElement).value).toHaveLength(8000);
  });

  it("clears_the_parameters_from_the_address_bar_after_reading_them", async () => {
    link(params({ title: "T" }));
    renderPage();
    await openForm();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/tasks/new");
  });

  it("replaces_unsent_draft_text_with_the_link", async () => {
    keepUnsent("new-task:title", "old draft");
    keepUnsent("new-task:description", "old description");
    link(params({ title: "From the link" }));
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Title")).toHaveValue("From the link");
    expect(within(form).getByLabelText("What do you want done?")).toHaveValue("");
  });

  it("creates_nothing_until_create_task_is_clicked", async () => {
    link(params({ description: "D", repo: "data", title: "Drafted" }));
    const { onNavigate } = renderPage();
    const form = await openForm();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(await fakeBoard().owner.listTasks()).toEqual([expect.objectContaining({ description: "D", repo: "data", title: "Drafted" })]);
    expect(onNavigate).toHaveBeenCalledWith(await createdPath());
  });

  it("prefills_the_factory_and_then_its_repo", async () => {
    resetFakeBoard(two());
    link(params({ factory: "delta", repo: "ui", title: "T" }));
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("delta");
    expect(within(form).getByLabelText("Repo")).toHaveValue("ui");
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument();
  });

  it("shows_a_capped_note_for_an_unknown_factory_and_clears_it_on_change", async () => {
    resetFakeBoard(two());
    link(params({ factory: "z".repeat(100), repo: "ui", title: "T" }));
    renderPage();
    const form = await openForm();
    expect(screen.getByText(`Unknown factory "${"z".repeat(40)}" in the link; pick one.`)).toBeInTheDocument();
    expect(within(form).getByLabelText("Factory")).toHaveValue("alpha");
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(screen.queryByText(/Unknown factory/)).not.toBeInTheDocument();
  });

  it("notes_a_repo_the_named_factory_does_not_have", async () => {
    resetFakeBoard(two());
    link(params({ factory: "delta", repo: "web", title: "T" }));
    renderPage();
    const form = await openForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("delta");
    expect(within(form).getByLabelText("Repo")).toHaveValue("api");
    expect(screen.getByText('Unknown repo "web" in the link; pick one.')).toBeInTheDocument();
  });
});

describe("NewTaskPage phone", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("description_label_reads_what_do_you_want_done", async () => {
    renderPage();
    const form = await openForm();
    const field = within(form).getByLabelText("What do you want done?");
    expect(field.tagName).toBe("TEXTAREA");
    expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")).toHaveTextContent(DESCRIPTION_HINT);
  });

  it("new_task_phone_markup_at_360", async () => {
    const leads: Array<Lead | null> = [];
    const { container } = renderPage(leads);
    const form = await openForm();
    expect(within(form).getByLabelText("What do you want done?")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Create task" }).parentElement).toHaveClass("sf-action-bar");
    expect(leads[leads.length - 1]?.label).toBe("Cancel");
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
  });
});
