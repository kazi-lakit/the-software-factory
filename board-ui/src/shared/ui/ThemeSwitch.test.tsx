import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, it, expect } from "vitest";
import { THEME_KEY, applyTheme } from "../../lib/theme";
import { ThemeSwitch } from "./ThemeSwitch";

beforeEach(() => { localStorage.clear(); applyTheme("dark"); });
afterEach(cleanup);

it("shows one icon and toggles and remembers each theme", () => {
  const { container } = render(<ThemeSwitch />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem(THEME_KEY)).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_KEY)).toBe("dark");
});
