import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../app/providers/AuthProvider";
import { completeLogin } from "../lib/blocks/auth";
import { CallbackPage } from "./Callback";

vi.mock("../lib/blocks/auth", () => ({ completeLogin: vi.fn() }));
vi.mock("../app/providers/AuthProvider", () => ({ useAuth: vi.fn() }));
vi.mock("../lib/i18n/LocalizationProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));

const refresh = vi.fn(async () => undefined);
vi.mocked(useAuth).mockReturnValue({ claims: undefined, login: vi.fn(), logout: vi.fn(), refresh, status: "loading" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CallbackPage", () => {
  it("completes_the_sign_in_once_even_when_effects_run_twice", async () => {
    vi.mocked(completeLogin).mockResolvedValue({ ok: true, returnTo: "/board" });
    const navigate = vi.fn();
    window.history.replaceState({}, "", "/login/callback?code=c&state=s");
    render(<StrictMode><CallbackPage onNavigate={navigate} /></StrictMode>);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/board"));
    expect(completeLogin).toHaveBeenCalledTimes(1);
    expect(completeLogin).toHaveBeenCalledWith(window.location.href);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("navigates_only_after_the_session_is_known", async () => {
    vi.mocked(completeLogin).mockResolvedValue({ ok: true, returnTo: "/" });
    let finish!: () => void;
    refresh.mockReturnValueOnce(new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
    const navigate = vi.fn();
    render(<CallbackPage onNavigate={navigate} />);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("shows_an_error_instead_of_spinning_when_navigation_throws", async () => {
    vi.mocked(completeLogin).mockResolvedValue({ ok: true, returnTo: "/" });
    const navigate = vi.fn(() => { throw new DOMException("blocked", "SecurityError"); });
    render(<CallbackPage onNavigate={navigate} />);
    expect(await screen.findByText("Sign-in could not be completed. Try again.")).toBeInTheDocument();
  });

  it("shows_the_provider_error", async () => {
    vi.mocked(completeLogin).mockResolvedValue({ ok: false, message: "Denied" });
    render(<CallbackPage onNavigate={vi.fn()} />);
    expect(await screen.findByText("Denied")).toBeInTheDocument();
  });

  it("shows_an_error_when_the_callback_request_fails", async () => {
    vi.mocked(completeLogin).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<CallbackPage onNavigate={vi.fn()} />);
    expect(await screen.findByText("Sign-in could not be completed. Try again.")).toBeInTheDocument();
  });
});
