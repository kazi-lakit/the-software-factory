// Ported from ACR origin/main apps/web/src/app/providers/AuthProvider.test.tsx, plus the visibility and expiry cases.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSessionClaims, onSessionExpired, renewSession } from "../../lib/blocks/auth";
import { AuthProvider, useAuth } from "./AuthProvider";

vi.mock("../../lib/blocks/auth", () => ({
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(),
  startLogin: vi.fn(async () => undefined)
}));

const claims = vi.mocked(fetchSessionClaims), renew = vi.mocked(renewSession);

function Status() {
  const { refresh, status } = useAuth();
  return <><p>{status}</p><button onClick={() => void refresh()}>check</button></>;
}

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function mount() {
  render(<AuthProvider><Status /></AuthProvider>);
  await settle();
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  // Drop the instance override so document.visibilityState reads jsdom's own value again.
  delete (document as { visibilityState?: unknown }).visibilityState;
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("AuthProvider session renewal", () => {
  it("renews_an_expired_access_cookie_before_calling_the_session_over", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValueOnce(undefined).mockResolvedValue({ sub: "me" });
    renew.mockResolvedValue("renewed");
    await mount();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(screen.getByText("authenticated")).toBeInTheDocument();
  });

  it("signs_out_when_the_refresh_cookie_is_rejected_too", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValue(undefined);
    renew.mockResolvedValue("rejected");
    await mount();
    expect(screen.getByText("unauthenticated")).toBeInTheDocument();
  });

  it("keeps_a_signed_in_session_alive_on_each_check", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValue({ sub: "me" });
    renew.mockResolvedValue("renewed");
    await mount();
    expect(renew).not.toHaveBeenCalled();
    await settle(5 * 60_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(claims).toHaveBeenCalledTimes(2);
    expect(screen.getByText("authenticated")).toBeInTheDocument();
  });

  it("does_not_try_to_renew_once_signed_out", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValue(undefined);
    renew.mockResolvedValue("rejected");
    await mount();
    renew.mockClear();
    await settle(5 * 60_000);
    expect(renew).not.toHaveBeenCalled();
    expect(screen.getByText("unauthenticated")).toBeInTheDocument();
  });

  it("keeps_a_signed_in_user_when_renewal_is_unavailable", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValueOnce({ sub: "me" }).mockResolvedValue(undefined);
    await mount();
    renew.mockResolvedValue("unavailable");
    await settle(5 * 60_000);
    expect(screen.getByText("authenticated")).toBeInTheDocument();
  });

  it("re_checks_the_session_when_the_tab_becomes_visible", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValueOnce({ sub: "me" }).mockResolvedValue(undefined);
    renew.mockResolvedValue("rejected");
    await mount();
    expect(screen.getByText("authenticated")).toBeInTheDocument();
    setVisibility("hidden");
    await settle();
    expect(claims).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await settle();
    expect(screen.getByText("unauthenticated")).toBeInTheDocument();
  });

  it("flips_to_signed_out_when_the_session_expires_out_of_band", async () => {
    vi.useFakeTimers();
    claims.mockResolvedValue({ sub: "me" });
    await mount();
    expect(screen.getByText("authenticated")).toBeInTheDocument();
    const listener = vi.mocked(onSessionExpired).mock.calls.at(-1)?.[0];
    expect(listener).toBeTypeOf("function");
    await act(async () => { listener!(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("unauthenticated")).toBeInTheDocument();
  });

  it("ignores_an_older_check_that_answers_after_a_newer_one", async () => {
    vi.useFakeTimers();
    // The first check (on mount) is slow and finds no session; the check run
    // after sign-in (/login/callback) answers first and finds one.
    let firstAnswer!: (value: undefined) => void;
    claims.mockReturnValueOnce(new Promise(resolve => { firstAnswer = resolve; })).mockResolvedValue({ sub: "me" });
    renew.mockResolvedValue("rejected");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "check" }));
    await settle();
    expect(screen.getByText("authenticated")).toBeInTheDocument();
    await act(async () => { firstAnswer(undefined); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("authenticated")).toBeInTheDocument();
  });
});
