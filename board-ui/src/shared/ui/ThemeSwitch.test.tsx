import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme } from "../../lib/theme";
import { ThemeSwitch } from "./ThemeSwitch";

beforeEach(() => {
  localStorage.clear();
  applyTheme("dark");
});
afterEach(cleanup);

describe("ThemeSwitch", () => {
  it("renders_a_group_named_Theme_with_Light_theme_and_Dark_theme_buttons", () => {
    render(<ThemeSwitch />);
    const group = screen.getByRole("group", { name: "Theme" });
    expect(within(group).getByRole("button", { name: "Light theme" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Dark theme" })).toBeInTheDocument();
  });

  it("marks_the_active_theme_with_aria_pressed_true_and_the_other_false", () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking_Light_theme_sets_data_theme_light_and_stores_light", () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking_Dark_theme_swaps_aria_pressed", () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("icons_are_aria_hidden", () => {
    const { container } = render(<ThemeSwitch />);
    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    icons.forEach((i) => expect(i).toHaveAttribute("aria-hidden", "true"));
  });
});
