import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySessionExpired, renewSession } from "./blocks/auth";
import { boardStore, cookieTokenSource } from "./board";

vi.mock("./blocks/auth", () => ({ notifySessionExpired: vi.fn(), renewSession: vi.fn() }));

const renew = vi.mocked(renewSession), expired = vi.mocked(notifySessionExpired);

afterEach(() => vi.clearAllMocks());

describe("cookieTokenSource", () => {
  it("never_hands_out_a_token_so_the_browser_sends_the_cookie", async () => {
    await expect(cookieTokenSource.get()).resolves.toBe("");
  });

  it("invalidate_waits_for_the_renewal_before_the_retry", async () => {
    let answer!: (value: "renewed") => void;
    renew.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    let settled = false;
    const done = Promise.resolve(cookieTokenSource.invalidate()).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    answer("renewed");
    await done;
    expect(expired).not.toHaveBeenCalled();
  });

  it("invalidate_ends_the_session_when_renewal_is_rejected", async () => {
    renew.mockResolvedValue("rejected");
    await cookieTokenSource.invalidate();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("invalidate_keeps_the_session_when_renewal_is_unavailable", async () => {
    renew.mockResolvedValue("unavailable");
    await cookieTokenSource.invalidate();
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("boardStore", () => {
  it("is_a_board_store_acting_as_the_owner", () => {
    expect(typeof boardStore.listTasks).toBe("function");
    expect((boardStore as unknown as { identity: string }).identity).toBe("owner");
  });
});
