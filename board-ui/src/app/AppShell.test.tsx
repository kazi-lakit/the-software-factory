import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSettings } from "@factory/core";
import { blocksClient } from "../lib/blocks/client";
import { fetchSessionClaims, logout } from "../lib/blocks/auth";
import { boardStore } from "../lib/board";
import { AppShell } from "./AppShell";
import { AuthProvider } from "./providers/AuthProvider";

vi.mock("../lib/blocks/client", () => ({ blocksClient: { iam: { me: vi.fn() } } }));

vi.mock("../lib/blocks/auth", () => ({
  fetchSessionClaims: vi.fn(),
  logout: vi.fn(async () => undefined),
  onSessionExpired: vi.fn(() => () => undefined),
  renewSession: vi.fn(async () => "rejected"),
  startLogin: vi.fn(async () => undefined)
}));

vi.mock("../lib/board", () => ({ boardStore: { getSettings: vi.fn() } }));

const getSettings = vi.mocked(boardStore.getSettings);

function settings(paused: boolean): StoredSettings {
  return {
    global: { gates: { spec: true, plan: true, pr: true }, maxParallel: 2, maxTurnsPerStage: 40, maxCostPerTaskUsd: 5, paused },
    repos: {}
  };
}

function renderShell(activePath = "/") {
  const onNavigate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AppShell activePath={activePath} onNavigate={onNavigate}>
          <h2>Page body</h2>
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppShell", () => {
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
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "Page body" }));
    expect(await screen.findByText("Kazi Rahman")).toBeInTheDocument();
  });

  it("shows_the_email_when_the_profile_has_no_name", async () => {
    vi.mocked(blocksClient.iam.me).mockResolvedValue({ data: { email: "kazi@example.test", roles: ["factory-owner"] } } as never);
    renderShell();
    expect(await screen.findByText("kazi@example.test")).toBeInTheDocument();
  });

  it("shows_factory_paused_when_the_global_settings_pause_it", async () => {
    getSettings.mockResolvedValue(settings(true));
    renderShell();
    expect(await screen.findByText("Factory paused")).toBeInTheDocument();
  });

  it("shows_no_pause_indicator_while_the_factory_runs", async () => {
    renderShell();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await screen.findByText("Kazi Rahman");
    expect(screen.queryByText("Factory paused")).not.toBeInTheDocument();
  });

  it("navigates_in_the_app_on_a_plain_click", () => {
    const { onNavigate } = renderShell();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
  });

  it("leaves_a_modified_click_to_the_browser", () => {
    const { onNavigate } = renderShell();
    fireEvent.click(screen.getByRole("link", { name: "History" }), { metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("signs_out_and_goes_to_login", async () => {
    const { onNavigate } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/login"));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
