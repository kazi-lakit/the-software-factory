import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSettings } from "@factory/core";
import { blocksClient } from "../lib/blocks/client";
import { fetchSessionClaims, logout } from "../lib/blocks/auth";
import { boardStore } from "../lib/board";
import { defFixture } from "../test/factories";
import { resetSelectedFactoryForTests, useSelectedFactory } from "../features/factories/useFactories";
import type { Task } from "@factory/core";
import { AppShell } from "./AppShell";
import { AuthProvider } from "./providers/AuthProvider";
import { useTopBarLead } from "./topBarLead";

function LeadProbe({ onClick }: { onClick: () => void }) {
  useTopBarLead({ label: "Back", onClick });
  return <h2>Page body</h2>;
}

vi.mock("../lib/blocks/client", () => ({ blocksClient: { iam: { me: vi.fn() } } }));

vi.mock("../lib/blocks/auth", () => ({
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(async () => "rejected"),
  startLogin: vi.fn(async () => undefined)
}));

vi.mock("../lib/board", () => ({ boardStore: { getSettings: vi.fn(), listFactoryDefs: vi.fn(), listFactoryRepos: vi.fn(), listTasks: vi.fn() } }));

const task = (id: string, status: string, factoryId = "blocks") => ({ taskId: id, status, factoryId, title: id }) as unknown as Task;

const getSettings = vi.mocked(boardStore.getSettings);

const entry = (paused: boolean) => ({ factory: { gates: { spec: true, plan: true, pr: true }, maxParallel: 2, maxTurnsPerStage: 40, maxCostPerTaskUsd: 5, paused }, repos: {} });

function settings(paused: boolean, others: Record<string, boolean> = {}): StoredSettings {
  return { factories: { blocks: entry(paused), ...Object.fromEntries(Object.entries(others).map(([id, p]) => [id, entry(p)])) } };
}

function Picker() {
  const [, setPicked] = useSelectedFactory();
  return <button type="button" onClick={() => setPicked("delta")}>Pick delta</button>;
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Account (Kazi)" }));
  return screen.getByRole("menu");
}

const signOutItem = (menu: HTMLElement) => within(menu).getByRole("menuitem", { name: "Sign out" });

function renderShell(activePath = "/", body: ReactNode = <h2>Page body</h2>) {
  const onNavigate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AppShell activePath={activePath} onNavigate={onNavigate}>
          {body}
        </AppShell>
      </AuthProvider>
    </QueryClientProvider>
  );
  return { onNavigate };
}

beforeEach(() => {
  vi.mocked(fetchSessionClaims).mockResolvedValue({ sub: "me" });
  vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { firstName: "Kazi", lastName: "Rahman", email: "kazi@example.test", roles: ["factory-owner"] } } as never);
  getSettings.mockResolvedValue(settings(false));
  vi.mocked(boardStore.listFactoryDefs).mockResolvedValue(["blocks", "delta", "mods"].map((id) => defFixture(id)));
  vi.mocked(boardStore.listFactoryRepos).mockResolvedValue([]);
  vi.mocked(boardStore.listTasks).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("AppShell", () => {
  it("app_shell_renders_the_theme_switch_first_in_the_right_group", () => {
    renderShell("/");
    const group = screen.getByRole("group", { name: "Theme" });
    const end = document.querySelector(".sf-topbar-end");
    expect(end).toContainElement(group);
    expect(end?.firstElementChild).toBe(group);
    fireEvent.click(within(group).getByRole("button", { name: "Dark theme" }));
    expect(within(group).getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "false");
  });

  it("project_name_carries_the_label_class", () => {
    renderShell("/");
    expect(screen.getByText("the-software-factory")).toHaveClass("sf-label");
  });

  it("shows_the_project_the_three_views_the_user_and_sign_out", async () => {
    renderShell("/history");
    const views = screen.getByRole("navigation", { name: "Views" });
    const board = within(views).getByRole("link", { name: "Board" });
    const history = within(views).getByRole("link", { name: "History" });
    const settingsLink = within(views).getByRole("link", { name: "Settings" });
    expect(board).toHaveAttribute("href", "/");
    expect(history).toHaveAttribute("href", "/history");
    expect(settingsLink).toHaveAttribute("href", "/settings");
    expect(history).toHaveAttribute("aria-current", "page");
    expect(board).not.toHaveAttribute("aria-current");
    expect(screen.getByText("the-software-factory")).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "Page body" }));
    const pill = await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(pill).toHaveTextContent("KR");
    expect(pill).toHaveTextContent("Kazi");
  });

  it("shows_the_email_when_the_profile_has_no_name", async () => {
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { email: "kazi@example.test", roles: ["factory-owner"] } } as never);
    renderShell();
    expect(await screen.findByText("kazi@example.test")).toHaveClass("sf-account-name");
  });

  it("shows_factory_paused_when_the_global_settings_pause_it", async () => {
    getSettings.mockResolvedValue(settings(true));
    renderShell();
    expect(await screen.findByText("Factory paused: blocks")).toBeInTheDocument();
  });

  it("under_all_lists_every_paused_factory", async () => {
    getSettings.mockResolvedValue(settings(true, { delta: true, mods: false }));
    renderShell();
    expect(await screen.findByText("Factories paused: blocks, delta")).toBeInTheDocument();
  });

  it("ignores_paused_settings_of_a_factory_that_is_not_listed", async () => {
    getSettings.mockResolvedValue(settings(false, { ghost: true }));
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^Account \(/ });
    await waitFor(() => expect(screen.queryByText(/paused/)).not.toBeInTheDocument());
  });

  it("shows_the_picked_factorys_pause_while_the_factory_list_is_still_loading", async () => {
    vi.mocked(boardStore.listFactoryDefs).mockReturnValue(new Promise(() => undefined));
    getSettings.mockResolvedValue(settings(false, { delta: true }));
    window.localStorage.setItem("factory-board:factory", "delta");
    renderShell();
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
  });

  it("says_the_pause_state_is_unknown_when_the_factory_list_cannot_load", async () => {
    vi.mocked(boardStore.listFactoryDefs).mockRejectedValue(new Error("blocks: unavailable"));
    renderShell();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pause state unknown"));
  });

  it("still_shows_a_paused_factory_when_the_factory_list_cannot_load", async () => {
    vi.mocked(boardStore.listFactoryDefs).mockRejectedValue(new Error("blocks: unavailable"));
    getSettings.mockResolvedValue(settings(true));
    renderShell();
    expect(await screen.findByText("Factory paused: blocks")).toBeInTheDocument();
  });

  it("follows_the_selected_factory_and_ignores_the_others", async () => {
    getSettings.mockResolvedValue(settings(false, { delta: true }));
    window.localStorage.setItem("factory-board:factory", "blocks");
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^Account \(/ });
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
    cleanup();
    resetSelectedFactoryForTests();
    window.localStorage.setItem("factory-board:factory", "delta");
    renderShell();
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
  });

  it("changes_the_indicator_when_a_view_changes_the_pick", async () => {
    getSettings.mockResolvedValue(settings(false, { delta: true }));
    window.localStorage.setItem("factory-board:factory", "blocks");
    renderShell("/", <Picker />);
    await screen.findByRole("button", { name: /^Account \(/ });
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pick delta" }));
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
  });

  it("shows_a_running_state_for_a_selected_factory_that_has_no_stored_settings", async () => {
    window.localStorage.setItem("factory-board:factory", "newbie");
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^Account \(/ });
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
  });

  it("shows_no_pause_indicator_while_the_factory_runs", async () => {
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^Account \(/ });
    expect(screen.queryByText("Factory paused")).not.toBeInTheDocument();
  });

  it("navigates_in_the_app_on_a_plain_click", () => {
    const { onNavigate } = renderShell();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });

  it("leaves_a_modified_click_to_the_browser", () => {
    const { onNavigate } = renderShell();
    // jsdom cannot navigate: the browser's own handling of the click ends here.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole("link", { name: "History" }), { metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps_board_current_on_a_task_page", () => {
    renderShell("/tasks/T-3");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
  });

  it("says_the_pause_state_is_unknown_when_the_settings_cannot_load", async () => {
    getSettings.mockRejectedValue(new Error("blocks: unavailable"));
    renderShell();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pause state unknown"));
    expect(screen.queryByText("Factory paused")).not.toBeInTheDocument();
  });

  it("keeps_a_live_region_for_the_pause_state_while_running", async () => {
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
  });

  it("titles_the_user_text_so_a_truncated_name_can_be_read", async () => {
    renderShell();
    expect(await screen.findByRole("button", { name: "Account (Kazi)" })).toHaveAttribute("title", "Kazi Rahman");
  });

  it("goes_to_login_even_when_sign_out_fails", async () => {
    vi.mocked(logout).mockRejectedValueOnce(new Error("network"));
    const { onNavigate } = renderShell();
    fireEvent.click(signOutItem(await openMenu()));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/login"));
  });

  it("drops_unsent_text_on_sign_out", async () => {
    sessionStorage.setItem("factory-board:unsent:answer:T-1", "draft");
    const { onNavigate } = renderShell();
    fireEvent.click(signOutItem(await openMenu()));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/login"));
    expect(sessionStorage.getItem("factory-board:unsent:answer:T-1")).toBeNull();
  });

  it("signs_out_and_goes_to_login", async () => {
    const { onNavigate } = renderShell();
    fireEvent.click(signOutItem(await openMenu()));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/login"));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("factory_name_is_a_link_to_the_board", () => {
    renderShell("/history");
    const link = screen.getByRole("link", { name: "the-software-factory" });
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveClass("sf-project", "sf-label");
    expect(link).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Views" })).not.toContainElement(link);
    expect(document.querySelectorAll("nav.sf-views a")).toHaveLength(3);
  });

  it("factory_name_plain_click_navigates_to_the_board", () => {
    const { onNavigate } = renderShell("/history");
    fireEvent.click(screen.getByRole("link", { name: "the-software-factory" }));
    expect(onNavigate).toHaveBeenCalledWith("/");
  });

  it("factory_name_modified_click_is_left_to_the_browser", () => {
    const { onNavigate } = renderShell("/history");
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole("link", { name: "the-software-factory" }), { metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("ctrl_shift_alt_and_middle_clicks_do_not_navigate", () => {
    const { onNavigate } = renderShell();
    for (const init of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      document.addEventListener("click", (event) => event.preventDefault(), { once: true });
      fireEvent.click(screen.getByRole("link", { name: "History" }), init);
    }
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("AppShell waiting badge", () => {
  const badgeText = () => document.querySelector(".sf-topbar")?.textContent ?? "";

  it("shows_a_waiting_badge_counting_tasks_that_need_you", async () => {
    vi.mocked(boardStore.listTasks).mockResolvedValue([task("a", "spec_review"), task("b", "spec_review"), task("c", "blocked"), task("d", "build")]);
    renderShell();
    const badge = await screen.findByText("3 waiting for you");
    expect(badge).toHaveClass("sf-badge");
    expect(document.querySelector(".sf-topbar-end")).toContainElement(badge);
  });

  it("counts_plan_review_and_pr_open_too", async () => {
    vi.mocked(boardStore.listTasks).mockResolvedValue([task("a", "plan_review"), task("b", "pr_open")]);
    renderShell();
    expect(await screen.findByText("2 waiting for you")).toBeInTheDocument();
  });

  it("shows_no_badge_when_nothing_waits", async () => {
    vi.mocked(boardStore.listTasks).mockResolvedValue([task("a", "build"), task("b", "done")]);
    renderShell();
    await waitFor(() => expect(boardStore.listTasks).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(screen.queryByText(/waiting for you/)).toBeNull();
  });

  it("shows_no_badge_and_no_error_while_tasks_load", async () => {
    vi.mocked(boardStore.listTasks).mockReturnValue(new Promise(() => undefined));
    renderShell();
    await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    expect(badgeText()).not.toMatch(/error|failed/i);
  });

  it("shows_no_badge_and_no_error_when_tasks_fail", async () => {
    vi.mocked(boardStore.listTasks).mockRejectedValue(new Error("boom"));
    renderShell();
    await waitFor(() => expect(boardStore.listTasks).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    expect(badgeText()).not.toMatch(/error|failed|boom/i);
  });

  it("counts_only_the_picked_factory", async () => {
    window.localStorage.setItem("factory-board:factory", "delta");
    vi.mocked(boardStore.listTasks).mockResolvedValue([task("a", "blocked", "delta"), task("b", "blocked"), task("c", "pr_open")]);
    renderShell();
    expect(await screen.findByText("1 waiting for you")).toBeInTheDocument();
  });

  it("badge_changes_do_not_reorder_the_bar", async () => {
    vi.mocked(boardStore.listTasks).mockResolvedValue([task("a", "blocked")]);
    renderShell();
    const project = screen.getByText("the-software-factory");
    const nav = screen.getByRole("navigation", { name: "Views" });
    const parent = project.parentElement;
    const badge = await screen.findByText("1 waiting for you");
    expect(project.parentElement).toBe(parent);
    expect(nav.parentElement).toBe(document.querySelector(".sf-sidebar"));
    expect(badge.parentElement).toBe(document.querySelector(".sf-topbar-end"));
    expect(nav).not.toContainElement(badge);
  });

  it("lists_tasks_once_per_poll_interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderShell();
    await waitFor(() => expect(boardStore.listTasks).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(boardStore.listTasks).toHaveBeenCalledTimes(2));
    expect(boardStore.listTasks).toHaveBeenCalledTimes(2);
  });
});

describe("AppShell account pill", () => {
  it("pill_shows_initials_in_a_circle_and_the_first_name", async () => {
    renderShell();
    const pill = await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(pill).toHaveClass("sf-account");
    expect(pill).toHaveAttribute("type", "button");
    expect(pill).toHaveAttribute("title", "Kazi Rahman");
    expect(pill.querySelector(".sf-avatar")).toHaveTextContent("KR");
    expect(pill.querySelector(".sf-account-name")).toHaveTextContent("Kazi");
  });

  it("pill_falls_back_to_the_email_when_there_is_no_first_name", async () => {
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { email: "kazi@example.test", roles: [] } } as never);
    renderShell();
    const pill = await screen.findByRole("button", { name: "Account (kazi@example.test)" });
    expect(pill.querySelector(".sf-avatar")).toHaveTextContent("K");
    expect(pill.querySelector(".sf-account-name")).toHaveTextContent("kazi@example.test");
  });

  it("pill_shows_a_question_mark_before_a_profile_exists", async () => {
    vi.mocked(blocksClient.iam.me).mockRejectedValue(new Error("nope"));
    renderShell();
    const pill = await screen.findByRole("button", { name: "Account" });
    expect(pill.querySelector(".sf-avatar")).toHaveTextContent("?");
  });

  it("long_first_name_is_truncated_by_css_with_the_full_name_in_title", async () => {
    const long = "A".repeat(40);
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { firstName: long, lastName: "Rahman", roles: [] } } as never);
    renderShell();
    const pill = await screen.findByRole("button", { name: `Account (${long})` });
    expect(pill.querySelector(".sf-account-name")).toHaveTextContent(long);
    expect(pill).toHaveAttribute("title", `${long} Rahman`);
  });

  it("no_separate_sign_out_button_or_user_text", async () => {
    renderShell();
    await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(screen.queryAllByRole("button", { name: /Sign out/ })).toHaveLength(0);
    expect(screen.queryByRole("menuitem")).toBeNull();
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    expect(signOutItem(menu)).toBeInTheDocument();
    expect(document.querySelector(".sf-user")).toBeNull();
  });

  it("renders the lead button first in the top bar and marks the shell sf-shell-detail", () => {
    renderShell("/tasks/T-1", <LeadProbe onClick={() => undefined} />);
    const lead = screen.getByRole("button", { name: "Back" });
    expect(lead).toHaveClass("sf-topbar-lead");
    expect(document.querySelector(".sf-topbar")?.firstElementChild).toBe(lead);
    expect(document.querySelector(".sf-app")).toHaveClass("sf-shell-detail");
  });

  it("clicking the lead button calls its onClick", () => {
    const onClick = vi.fn();
    renderShell("/tasks/T-1", <LeadProbe onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("has no lead button and no sf-shell-detail by default", () => {
    renderShell("/");
    expect(document.querySelector(".sf-topbar-lead")).toBeNull();
    expect(document.querySelector(".sf-app")).not.toHaveClass("sf-shell-detail");
  });

  it("keeps one nav.sf-views with three links", () => {
    renderShell("/", <LeadProbe onClick={() => undefined} />);
    expect(document.querySelectorAll("nav.sf-views")).toHaveLength(1);
    expect(document.querySelectorAll("nav.sf-views a")).toHaveLength(3);
  });
});

describe("AppShell account menu", () => {
  it("account_button_announces_a_menu", async () => {
    renderShell();
    const pill = await screen.findByRole("button", { name: "Account (Kazi)" });
    expect(pill).toHaveAttribute("aria-haspopup", "menu");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(pill);
    const menu = screen.getByRole("menu");
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(pill.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.id).not.toBe("");
  });

  it("opening_the_menu_shows_the_email_and_sign_out_and_does_not_sign_out", async () => {
    const { onNavigate } = renderShell();
    const menu = await openMenu();
    expect(within(menu).getByText("kazi@example.test")).not.toHaveAttribute("role", "menuitem");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    const item = signOutItem(menu);
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(logout).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalledWith("/login");
  });

  it("menu_leaves_out_the_email_when_the_profile_has_none", async () => {
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { firstName: "Kazi", roles: [] } } as never);
    renderShell();
    const menu = await openMenu();
    expect(menu).toHaveTextContent(/^Sign out$/);
  });

  it("escape_closes_the_menu_and_returns_focus_to_the_pill", async () => {
    renderShell();
    const menu = await openMenu();
    const pill = screen.getByRole("button", { name: "Account (Kazi)" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(pill);
  });

  it("clicking_outside_closes_the_menu", async () => {
    renderShell();
    await openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it("clicking_the_pill_again_closes_the_menu", async () => {
    renderShell();
    await openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Account (Kazi)" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// Tablet navigation hides its visible labels; every icon link still needs a name.
it("keeps icon-only navigation named", () => {
  renderShell();
  for (const label of ["Board", "History", "Settings"]) {
    const link = within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name: label });
    expect(link).toHaveAttribute("aria-label", label);
    expect(link).toHaveAttribute("title", label);
  }
  expect(screen.getByRole("link", { name: "Software Factory home" })).toBeInTheDocument();
});
