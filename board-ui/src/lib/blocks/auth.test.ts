// Ported from ACR origin/main apps/web/src/lib/blocks/auth.test.ts (cookie flow only).
import { afterEach, describe, expect, it, vi } from "vitest";
import { blocksClient } from "./client";
import { completeLogin, fetchSessionClaims, handleUnauthorized, logout, onSessionExpired, renewSession, startLogin } from "./auth";

vi.mock("./client", () => ({
  blocksClient: {
    auth: {
      idp: { callback: vi.fn(), redirectToProvider: vi.fn(async () => undefined) },
      isAuthenticated: vi.fn(),
      logout: vi.fn(async () => undefined),
      oidc: { refreshToken: vi.fn() },
      userInfo: vi.fn()
    }
  }
}));

const refreshToken = vi.mocked(blocksClient.auth.oidc.refreshToken);
const isAuthenticated = vi.mocked(blocksClient.auth.isAuthenticated);
const userInfo = vi.mocked(blocksClient.auth.userInfo);
const callback = vi.mocked(blocksClient.auth.idp.callback);

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("renewSession (cookie flow)", () => {
  it("renews_from_the_refresh_cookie_without_sending_a_token", async () => {
    refreshToken.mockResolvedValue({ cookie_set: true, expires_in: 900 });
    await expect(renewSession()).resolves.toBe("renewed");
    expect(refreshToken).toHaveBeenCalledWith({});
  });

  it("reports_rejected_when_iam_answers_400_with_an_error", async () => {
    refreshToken.mockResolvedValue({ error: "invalid_request", error_description: "refresh token not found" });
    await expect(renewSession()).resolves.toBe("rejected");
  });

  it("reports_unavailable_on_a_network_failure_or_an_unreadable_answer", async () => {
    refreshToken.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(renewSession()).resolves.toBe("unavailable");
    refreshToken.mockResolvedValueOnce(undefined as never);
    await expect(renewSession()).resolves.toBe("unavailable");
  });

  it("shares_one_request_between_concurrent_callers", async () => {
    let answer!: (value: Record<string, unknown>) => void;
    refreshToken.mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
    const both = Promise.all([renewSession(), renewSession()]);
    answer({ cookie_set: true });
    await expect(both).resolves.toEqual(["renewed", "renewed"]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("starts_a_new_request_once_the_previous_one_settled", async () => {
    refreshToken.mockResolvedValue({ cookie_set: true });
    await renewSession();
    await renewSession();
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("never_ends_the_session_by_itself", async () => {
    const expired = vi.fn();
    const stop = onSessionExpired(expired);
    refreshToken.mockResolvedValueOnce({ error: "invalid_grant" });
    await renewSession();
    expect(expired).not.toHaveBeenCalled();
    stop();
  });
});

describe("handleUnauthorized (the SDK's onUnauthorized hook)", () => {
  it("renews_the_cookie_and_hands_back_no_token", async () => {
    refreshToken.mockResolvedValue({ cookie_set: true });
    const expired = vi.fn();
    const stop = onSessionExpired(expired);
    await expect(handleUnauthorized()).resolves.toBeUndefined();
    expect(refreshToken).toHaveBeenCalledWith({});
    expect(expired).not.toHaveBeenCalled();
    stop();
  });

  it("reports_the_session_over_when_renewal_is_rejected", async () => {
    refreshToken.mockResolvedValue({ error: "invalid_grant" });
    const expired = vi.fn();
    const stop = onSessionExpired(expired);
    await handleUnauthorized();
    expect(expired).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does_not_sign_out_when_renewal_is_unavailable", async () => {
    refreshToken.mockRejectedValue(new TypeError("Failed to fetch"));
    const expired = vi.fn();
    const stop = onSessionExpired(expired);
    await handleUnauthorized();
    expect(expired).not.toHaveBeenCalled();
    stop();
  });
});

describe("fetchSessionClaims", () => {
  it("is_signed_out_when_iam_refuses_the_session", async () => {
    // userInfo() never throws on a 401 (the SDK returns the error body), so the status decides.
    isAuthenticated.mockResolvedValue(false);
    userInfo.mockResolvedValue({ error: "unauthorized" });
    await expect(fetchSessionClaims()).resolves.toBeUndefined();
  });

  it("returns_the_claims_of_a_live_session", async () => {
    isAuthenticated.mockResolvedValue(true);
    userInfo.mockResolvedValue({ sub: "me" });
    await expect(fetchSessionClaims()).resolves.toEqual({ sub: "me" });
  });

  it("is_signed_out_when_the_check_fails", async () => {
    isAuthenticated.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchSessionClaims()).resolves.toBeUndefined();
  });

  it("stays_signed_in_with_no_claims_when_only_the_claims_read_fails", async () => {
    isAuthenticated.mockResolvedValue(true);
    userInfo.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchSessionClaims()).resolves.toEqual({});
  });
});

describe("hosted sign-in", () => {
  it("remembers_where_to_return_and_redirects_to_the_provider", async () => {
    await startLogin("/board?x=1");
    expect(sessionStorage.getItem("blocks-app:oidc-return-to")).toBe("/board?x=1");
    expect(blocksClient.auth.idp.redirectToProvider).toHaveBeenCalledTimes(1);
  });

  it("completes_with_cookies_set_and_no_token_in_the_body", async () => {
    sessionStorage.setItem("blocks-app:oidc-return-to", "/board");
    callback.mockResolvedValue({ access_token: "not-kept" });
    await expect(completeLogin("https://app.test/login/callback?code=c&state=s")).resolves.toEqual({ ok: true, returnTo: "/board" });
    expect(sessionStorage.getItem("blocks-app:oidc-return-to")).toBeNull();
    // Cookie mode: a token in the body is never kept anywhere JS can read.
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("reports_the_provider_error", async () => {
    callback.mockResolvedValue({ error: "access_denied", error_description: "Denied" });
    await expect(completeLogin("https://app.test/login/callback?error=access_denied")).resolves.toEqual({ ok: false, message: "Denied" });
  });

  it("returns_only_to_a_path_on_this_site", async () => {
    callback.mockResolvedValue({});
    for (const unsafe of ["https://evil.test/x", "https://evil.test", "//evil.test/x", "//evil.test", "/\t/evil.test", "/\n/evil.test", "/\\evil.test", "/.//evil.test", "/..//evil.test", "/x/..//evil.test", "javascript:alert(1)", "board", ""]) {
      sessionStorage.setItem("blocks-app:oidc-return-to", unsafe);
      await expect(completeLogin("https://app.test/login/callback?code=c")).resolves.toEqual({ ok: true, returnTo: "/" });
    }
  });

  it("keeps_the_path_query_and_hash_of_a_page_on_this_site", async () => {
    callback.mockResolvedValue({});
    sessionStorage.setItem("blocks-app:oidc-return-to", "/tasks/T-3?view=plan#diff");
    await expect(completeLogin("https://app.test/login/callback?code=c")).resolves.toEqual({ ok: true, returnTo: "/tasks/T-3?view=plan#diff" });
  });

  it("logout_asks_iam_to_end_the_cookie_session_and_survives_a_failure", async () => {
    vi.mocked(blocksClient.auth.logout).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(logout()).resolves.toBeUndefined();
    expect(blocksClient.auth.logout).toHaveBeenCalledWith({});
  });
});
