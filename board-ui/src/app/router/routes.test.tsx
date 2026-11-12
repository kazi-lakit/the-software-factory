import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksClient } from "../../lib/blocks/client";
import { completeLogin, fetchSessionClaims, onSessionExpired, renewSession, startLogin } from "../../lib/blocks/auth";
import { LocalizationProvider } from "../../lib/i18n/LocalizationProvider";
import { AuthProvider } from "../providers/AuthProvider";
import { AppRouter } from "./routes";

vi.mock("../../lib/blocks/client", () => ({
  blocksClient: {
    iam: { me: vi.fn() },
    localization: { languages: vi.fn(async () => []), translations: vi.fn(async () => ({})) }
  }
}));

vi.mock("../../lib/blocks/auth", () => ({
  completeLogin: vi.fn(),
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(async () => "rejected"),
  startLogin: vi.fn(async () => undefined)
}));

// Login is configured so the landing page's sign-in buttons are enabled.
vi.mock("../../lib/blocks/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/blocks/config")>()),
  isLoginConfigured: () => true
}));

// The shell reads the settings for its pause indicator; no test reaches Blocks Data.
vi.mock("../../lib/board", () => ({
  boardStore: {
    getSettings: vi.fn(async () => ({ factories: { blocks: { factory: { gates: { spec: true, plan: true, pr: true }, maxParallel: 1, maxTurnsPerStage: 1, maxCostPerTaskUsd: 1, paused: false }, repos: {} } } })),
    getTask: vi.fn(async (id: string) => ({
      answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0, description: "",
      factoryId: "blocks", gateOverrides: {}, dependsOn: [], prUrl: null, question: null, repo: "data", stage: null, status: "inbox", taskId: id, title: "Routed task", version: 1
    })),
    listApprovals: vi.fn(async () => []),
    listDocs: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    listFactoryDefs: vi.fn(async () => [{
      active: true, docsPath: "/docs", factoryId: "blocks", gitEmail: "f@example.com", gitName: "Factory", name: "Blocks",
      ghUser: "kazi-lakit", protectedBranches: ["dev", "stg", "main"], version: 1
    }]),
    listFactoryRepos: vi.fn(async () => [{
      baseBranch: "dev", checks: { client: { build: "b", cwd: "c", install: "i", lint: "l", test: "t", typecheck: "tc" }, e2e: "off", server: { build: "b", cwd: "s", test: "t" } },
      factoryId: "blocks", remote: "git@github.com:org/iam.git", repoId: "iam", version: 1
    }]),
    listRuns: vi.fn(async () => []),
    listTasks: vi.fn(async () => [])
  }
}));

const me = vi.mocked(blocksClient.iam.me);
const claims = vi.mocked(fetchSessionClaims);

let lastClient: QueryClient | undefined;

function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  return render(
    <QueryClientProvider client={client}>
      <LocalizationProvider>
        <AuthProvider>
          <AppRouter />
        </AuthProvider>
      </LocalizationProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(renewSession).mockResolvedValue("rejected");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequireAuth", () => {
  it("sends_a_signed_out_visitor_to_login_with_the_page_to_return_to", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/profile");
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/profile")}`);
    expect(me).not.toHaveBeenCalled();
  });
});

describe("RequireAuth with a query string", () => {
  it("keeps_the_query_of_the_page_to_return_to", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/?new=1&title=Fix%20it%20%26%20more");
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/?new=1&title=Fix%20it%20%26%20more")}`);
  });
});

describe("a New task link and an expiring session", () => {
  it("does_not_carry_the_link_into_the_sign_in_return", async () => {
    let expire: () => void = () => undefined;
    vi.mocked(onSessionExpired).mockImplementation((listener) => {
      expire = listener;
      return () => undefined;
    });
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/?new=1&title=Draft&repo=iam");
    expect(await screen.findByRole("form", { name: "New task" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
    act(() => expire());
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/tasks/new")}`);
  });
});

describe("the new task route", () => {
  const signIn = () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
  };

  it("renders_the_new_task_page_not_a_task", async () => {
    signIn();
    const { boardStore } = await import("../../lib/board");
    renderAt("/tasks/new");
    expect(await screen.findByRole("heading", { level: 1, name: "New task" })).toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "New task" })).toBeInTheDocument();
    expect(boardStore.getTask).not.toHaveBeenCalled();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });

  it("returns_to_tasks_new_with_its_query_after_sign_in", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/tasks/new?new=1&title=T");
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/tasks/new?new=1&title=T")}`);
  });

  it("forwards_the_board_link_to_tasks_new_prefilled", async () => {
    signIn();
    renderAt("/?new=1&title=Draft&repo=iam");
    const form = await screen.findByRole("form", { name: "New task" });
    expect(within(form).getByLabelText("Title")).toHaveValue("Draft");
    expect(within(form).getByLabelText("Repo")).toHaveValue("iam");
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/tasks/new");
  });

  it("the_board_new_task_link_opens_the_page_without_reload", async () => {
    signIn();
    renderAt("/");
    fireEvent.click(await screen.findByRole("link", { name: "New task" }));
    expect(window.location.pathname).toBe("/tasks/new");
    expect(await screen.findByRole("heading", { level: 1, name: "New task" })).toBeInTheDocument();
    const form = await screen.findByRole("form", { name: "New task" });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Board" })).toBeInTheDocument();
  });
});

describe("the owner check", () => {
  it("shows_the_board_to_a_factory_owner", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
  });

  it("keeps_the_board_when_a_later_profile_refetch_fails", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValueOnce({ data: { roles: ["factory-owner"] } } as never).mockRejectedValue(new Error("blocks: unavailable"));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    await act(async () => { await lastClient!.refetchQueries({ queryKey: ["iam", "me"] }); });
    expect(lastClient!.getQueryState(["iam", "me"])?.status).toBe("error");
    // TanStack Query notifies components on a later tick.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows_not_owner_to_a_signed_in_user_without_the_role", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["viewer"] } } as never);
    renderAt("/");
    expect(await screen.findByText("This account doesn't have the factory-owner role.")).toBeInTheDocument();
    expect(screen.queryByText("Board")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Not a factory owner" }).closest(".sf-screen-panel")).not.toBeNull();
  });

  it("does_not_claim_a_missing_role_when_the_profile_cannot_be_read", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockRejectedValue(new Error("blocks: unavailable"));
    renderAt("/");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("This account doesn't have the factory-owner role.")).not.toBeInTheDocument();
    expect(screen.queryByText("Board")).not.toBeInTheDocument();
    const h1 = screen.getByRole("heading", { level: 1, name: "Could not load your account" });
    expect(h1).toHaveClass("sf-page-title");
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveClass("sf-button", "sf-button-primary");
    expect(h1.closest(".sf-screen-panel")).not.toBeNull();
    expect(retry.closest(".sf-screen-panel")).toBe(h1.closest(".sf-screen-panel"));
  });
});

describe("the owner views", () => {
  it.each([["/history", "History"], ["/settings", "Settings"]])("renders_%s_in_the_shell", async (path, heading) => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt(path);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: heading })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
  });
});

describe("the new factory route", () => {
  const signIn = () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
  };

  it("renders_the_new_factory_page_in_the_shell_with_settings_current", async () => {
    signIn();
    renderAt("/settings/factories/new");
    expect(await screen.findByRole("heading", { level: 1, name: "New factory" })).toBeInTheDocument();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  it("settings_add_factory_link_opens_the_page_in_app", async () => {
    signIn();
    renderAt("/settings");
    fireEvent.click(await screen.findByRole("tab", { name: "Manage factories" }));
    fireEvent.click(await screen.findByRole("link", { name: "Add factory" }));
    expect(window.location.pathname).toBe("/settings/factories/new");
    expect(await screen.findByRole("heading", { level: 1, name: "New factory" })).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "New factory" });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(window.location.pathname).toBe("/settings");
  });

  it("factories_breadcrumb_opens_settings_at_the_factories_section", async () => {
    signIn();
    renderAt("/settings/factories/new");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("link", { name: "Factories" }));
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.hash).toBe("#settings-factories");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });
});

describe("the task route", () => {
  it("renders_a_task_in_the_shell_under_board", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/tasks/T-12");
    expect(await screen.findByRole("heading", { name: "Routed task" })).toBeInTheDocument();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });

  it("returns_to_the_task_after_sign_in", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/tasks/T-12");
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/tasks/T-12")}`);
  });
});

describe("the 404 page", () => {
  it("shows_page_not_found_with_a_link_to_the_board", async () => {
    renderAt("/nope");
    const h1 = await screen.findByRole("heading", { level: 1, name: "Page not found" });
    expect(h1).toHaveClass("sf-page-title");
    expect(h1.closest(".sf-screen-panel")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to the Board" })).toHaveAttribute("href", "/");
  });

  it("the_link_navigates_to_the_board", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/nope");
    fireEvent.click(await screen.findByRole("link", { name: "Back to the Board" }));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
  });
});

describe("the profile page", () => {
  it("shows_every_profile_detail_in_the_shared_panel", async () => {
    claims.mockResolvedValue({ sub: "me", iat: 1700000000, exp: 1700003600 });
    me.mockResolvedValue({
      data: { firstName: "Kazi", lastName: "Rahman", email: "kazi@example.test", itemId: "u-1", roles: ["factory-owner"], permissions: ["p.read"] }
    } as never);
    renderAt("/profile");
    const h1 = await screen.findByRole("heading", { level: 1, name: "Profile" });
    expect(h1).toHaveClass("sf-page-title");
    const panel = h1.closest(".sf-screen-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    const inPanel = within(panel);
    expect(inPanel.getByText("Kazi Rahman")).toBeInTheDocument();
    expect(inPanel.getByText("kazi@example.test")).toBeInTheDocument();
    expect(inPanel.getByText("Authenticated")).toBeInTheDocument();
    expect(inPanel.getByText("u-1")).toBeInTheDocument();
    expect(inPanel.getByText("Tenant id (x-blocks-key)")).toBeInTheDocument();
    expect(inPanel.getByText("Session expires")).toBeInTheDocument();
    const role = inPanel.getByText("factory-owner");
    expect(role.tagName).toBe("LI");
    expect(role).toHaveClass("sf-chip");
    expect(inPanel.getByText("Permissions (1)")).toBeInTheDocument();
    expect(inPanel.getByText("p.read")).toBeInTheDocument();
    expect(inPanel.getByText(/^Signed in /)).toHaveClass("sf-chip");
    expect(inPanel.getByText(/^Expires /)).toHaveClass("sf-chip");
    const summary = inPanel.getByText("View raw response");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")!.querySelector("pre")).toHaveClass("sf-json");
    expect(inPanel.getByRole("button", { name: "Refresh profile" })).toHaveClass("sf-button");
  });

  it("shows_the_fallback_when_the_profile_cannot_be_read", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValueOnce({ data: { roles: ["factory-owner"] } } as never).mockRejectedValue(new Error("blocks: unavailable"));
    renderAt("/profile");
    fireEvent.click(await screen.findByRole("button", { name: "Refresh profile" }));
    const panel = screen.getByRole("heading", { level: 1, name: "Profile" }).closest(".sf-screen-panel") as HTMLElement;
    expect(await within(panel).findAllByText("Session unavailable")).not.toHaveLength(0);
    expect(within(panel).getAllByText("Not available").length).toBeGreaterThan(0);
  });
});

describe("the callback route", () => {
  it("is_never_behind_the_sign_in_guard", async () => {
    claims.mockResolvedValue(undefined);
    vi.mocked(completeLogin).mockReturnValue(new Promise(() => undefined));
    renderAt("/login/callback?code=c&state=s");
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/login/callback");
  });
});

describe("the landing page", () => {
  const headline = { level: 1, name: "Write the task. Merge the PR." } as const;

  it("shows_the_landing_page_to_a_signed_out_visitor_at_login", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/login");
    expect(await screen.findByRole("heading", headline)).toBeInTheDocument();
  });

  it("sends_a_signed_out_visitor_at_root_to_the_landing_page", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/");
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.location.search).toBe("?returnTo=%2F");
    expect(await screen.findByRole("heading", headline)).toBeInTheDocument();
  });

  it("sends_a_signed_in_visitor_at_login_to_the_board", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/login");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", headline)).not.toBeInTheDocument();
  });

  it("continue_with_blocks_starts_sign_in_with_the_return_to", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/login?returnTo=%2Ftasks%2FT-12");
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Blocks" }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith("/tasks/T-12"));
  });

  it("sign_in_in_the_top_bar_starts_the_same_sign_in", async () => {
    claims.mockResolvedValue(undefined);
    renderAt("/login?returnTo=%2Ftasks%2FT-12");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith("/tasks/T-12"));
  });
});

it("keeps the current route when a navigation guard rejects browser Back", async () => {
  const { setNavigationGuard } = await import("../../lib/navigationGuard");
  claims.mockResolvedValue(undefined);
  renderAt("/login");
  setNavigationGuard(() => false);
  act(() => { window.history.pushState({}, "", "/profile"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(window.location.pathname).toBe("/login");
  setNavigationGuard(undefined);
});
