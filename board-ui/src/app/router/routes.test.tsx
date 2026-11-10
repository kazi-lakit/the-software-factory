import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksClient } from "../../lib/blocks/client";
import { completeLogin, fetchSessionClaims, onSessionExpired, renewSession } from "../../lib/blocks/auth";
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

// The shell reads the settings for its pause indicator; no test reaches Blocks Data.
vi.mock("../../lib/board", () => ({
  boardStore: {
    getSettings: vi.fn(async () => ({ factories: { blocks: { factory: { gates: { spec: true, plan: true, pr: true }, maxParallel: 1, maxTurnsPerStage: 1, maxCostPerTaskUsd: 1, paused: false }, repos: {} } } })),
    getTask: vi.fn(async (id: string) => ({
      answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0, description: "",
      gateOverrides: {}, prUrl: null, question: null, repo: "data", stage: null, status: "inbox", taskId: id, title: "Routed task", version: 1
    })),
    listApprovals: vi.fn(async () => []),
    listDocs: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
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
    expect(window.location.search).toBe(`?returnTo=${encodeURIComponent("/")}`);
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
  });

  it("does_not_claim_a_missing_role_when_the_profile_cannot_be_read", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockRejectedValue(new Error("blocks: unavailable"));
    renderAt("/");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("This account doesn't have the factory-owner role.")).not.toBeInTheDocument();
    expect(screen.queryByText("Board")).not.toBeInTheDocument();
  });
});

describe("the owner views", () => {
  it.each([["/history", "History"], ["/settings", "Settings"]])("renders_%s_in_the_shell", async (path, heading) => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt(path);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: heading })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
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

describe("the callback route", () => {
  it("is_never_behind_the_sign_in_guard", async () => {
    claims.mockResolvedValue(undefined);
    vi.mocked(completeLogin).mockReturnValue(new Promise(() => undefined));
    renderAt("/login/callback?code=c&state=s");
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/login/callback");
  });
});
