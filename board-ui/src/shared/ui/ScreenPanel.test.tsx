import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LoadingScreen } from "./LoadingScreen";
import { ScreenPanel } from "./ScreenPanel";

afterEach(cleanup);

describe("ScreenPanel", () => {
  it("renders_the_wrapper_panel_and_a_title_h1", () => {
    render(<ScreenPanel title="Hello"><p>Body</p></ScreenPanel>);
    const h1 = screen.getByRole("heading", { level: 1, name: "Hello" });
    expect(h1).toHaveClass("sf-page-title");
    const panel = h1.closest(".sf-screen-panel");
    expect(panel).not.toBeNull();
    expect(panel!.closest(".sf-screen")).not.toBeNull();
    expect(panel).toHaveTextContent("Body");
  });

  it("renders_no_h1_without_a_title", () => {
    render(<ScreenPanel><p>Body</p></ScreenPanel>);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("LoadingScreen", () => {
  it("shows_a_label_type_loading_status_in_the_panel", () => {
    render(<LoadingScreen />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading…");
    expect(status).toHaveClass("sf-label", "sf-muted");
    expect(status.closest(".sf-screen-panel")).not.toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
