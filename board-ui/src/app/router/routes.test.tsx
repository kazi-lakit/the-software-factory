import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksClient } from "../../lib/blocks/client";
import { completeLogin, fetchSessionClaims, renewSession } from "../../lib/blocks/auth";
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

const me = vi.mocked(blocksClient.iam.me);
const claims = vi.mocked(fetchSessionClaims);

function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe("the owner check", () => {
  it("shows_the_board_to_a_factory_owner", async () => {
    claims.mockResolvedValue({ sub: "me" });
    me.mockResolvedValue({ data: { roles: ["factory-owner"] } } as never);
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
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

describe("the callback route", () => {
  it("is_never_behind_the_sign_in_guard", async () => {
    claims.mockResolvedValue(undefined);
    vi.mocked(completeLogin).mockReturnValue(new Promise(() => undefined));
    renderAt("/login/callback?code=c&state=s");
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/login/callback");
  });
});
