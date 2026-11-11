import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../app/providers/AuthProvider";
import { NOT_OWNER_MESSAGE, NotOwnerPage } from "./NotOwner";

vi.mock("../app/providers/AuthProvider", () => ({ useAuth: vi.fn() }));

const logout = vi.fn(async () => undefined);
vi.mocked(useAuth).mockReturnValue({ claims: undefined, login: vi.fn(), logout, refresh: vi.fn(), status: "authenticated" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotOwnerPage", () => {
  it("renders_in_the_shared_panel_with_an_h1", () => {
    render(<NotOwnerPage onNavigate={vi.fn()} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Not a factory owner" });
    expect(h1).toHaveClass("sf-page-title");
    expect(h1.closest(".sf-screen-panel")).not.toBeNull();
    expect(screen.getByText(NOT_OWNER_MESSAGE)).toBeInTheDocument();
  });

  it("sign_out_is_a_primary_sf_button_that_signs_out_and_goes_to_login", async () => {
    const navigate = vi.fn();
    render(<NotOwnerPage onNavigate={navigate} />);
    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button).toHaveClass("sf-button", "sf-button-primary");
    fireEvent.click(button);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
