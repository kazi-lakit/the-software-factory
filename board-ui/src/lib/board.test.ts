import { afterEach, describe, expect, it, vi } from "vitest";
import { blocksClient } from "./blocks/client";
import { onSessionExpired } from "./blocks/auth";
import { boardStore, cookieTokenSource } from "./board";

// The real auth module over a mocked SDK client: invalidate() goes through the same
// renewal path as the SDK's onUnauthorized hook.
vi.mock("./blocks/client", () => ({ blocksClient: { auth: { oidc: { refreshToken: vi.fn() } } } }));

const refreshToken = vi.mocked(blocksClient.auth.oidc.refreshToken);
const expired = vi.fn();
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  vi.clearAllMocks();
});

function listen() {
  stop = onSessionExpired(expired);
}

describe("cookieTokenSource", () => {
  it("never_hands_out_a_token_so_the_browser_sends_the_cookie", async () => {
    await expect(cookieTokenSource.get()).resolves.toBe("");
  });

  it("invalidate_waits_for_the_renewal_before_the_retry", async () => {
    listen();
    let answer!: (value: Record<string, unknown>) => void;
    refreshToken.mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
    let settled = false;
    const done = Promise.resolve(cookieTokenSource.invalidate()).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    answer({ cookie_set: true });
    await done;
    expect(refreshToken).toHaveBeenCalledWith({});
    expect(expired).not.toHaveBeenCalled();
  });

  it("invalidate_ends_the_session_when_renewal_is_rejected", async () => {
    listen();
    refreshToken.mockResolvedValue({ error: "invalid_grant" });
    await cookieTokenSource.invalidate();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("invalidate_keeps_the_session_when_renewal_is_unavailable", async () => {
    listen();
    refreshToken.mockRejectedValue(new TypeError("Failed to fetch"));
    await cookieTokenSource.invalidate();
    expect(expired).not.toHaveBeenCalled();
  });

  it("invalidate_shares_the_renewal_with_the_sdk_hook", async () => {
    let answer!: (value: Record<string, unknown>) => void;
    refreshToken.mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
    const { handleUnauthorized } = await import("./blocks/auth");
    const both = Promise.all([cookieTokenSource.invalidate(), handleUnauthorized()]);
    answer({ cookie_set: true });
    await both;
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe("boardStore", () => {
  it("is_a_board_store_acting_as_the_owner", () => {
    expect(typeof boardStore.listTasks).toBe("function");
    expect((boardStore as unknown as { identity: string }).identity).toBe("owner");
  });
});
