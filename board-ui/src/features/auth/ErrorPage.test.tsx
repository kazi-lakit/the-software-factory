import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorPage } from "./ErrorPage";

vi.mock("../../lib/i18n/LocalizationProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

describe("ErrorPage", () => {
  it("renders_in_the_shared_panel_with_an_h1", () => {
    render(<ErrorPage onNavigate={vi.fn()} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "common.error" });
    expect(h1).toHaveClass("sf-page-title");
    const panel = h1.closest(".sf-screen-panel");
    expect(panel).not.toBeNull();
    expect(screen.getByText("The page could not finish loading. Try again or return home.")).toBeInTheDocument();
    expect(panel!.querySelector("svg")).toBeNull();
  });

  it("the_board_link_navigates_home", () => {
    const navigate = vi.fn();
    render(<ErrorPage onNavigate={navigate} />);
    const link = screen.getByRole("link", { name: "notFound.home" });
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveClass("sf-button", "sf-button-primary");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
