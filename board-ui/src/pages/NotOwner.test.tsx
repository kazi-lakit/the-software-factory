import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../app/providers/AuthProvider";
import { NOT_OWNER_MESSAGE, NotOwnerPage } from "./NotOwner";

vi.mock("../app/providers/AuthProvider", () => ({ useAuth: vi.fn() }));
vi.mocked(useAuth).mockReturnValue({ claims: undefined, login: vi.fn(), logout: vi.fn(), refresh: vi.fn(), status: "signedIn" } as never);

afterEach(cleanup);

describe("NotOwnerPage", () => {
  it("renders_on_sf_classes_with_the_same_text", () => {
    const { container } = render(<NotOwnerPage onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Not a factory owner" })).toBeInTheDocument();
    expect(screen.getByText(NOT_OWNER_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(container.querySelector(".sf-status-screen .sf-status-card")).not.toBeNull();
    expect(container.querySelector('[class*="auth-"]')).toBeNull();
  });
});
