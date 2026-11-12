import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTabs } from "./TaskTabs";

const tabs = [
  { content: <p>a</p>, id: "a", label: "A" },
  { content: <p>b</p>, id: "b", label: "B" },
  { content: <p>c</p>, id: "c", label: "C" }
];

const renderTabs = () => render(<TaskTabs label="Task sections" tabs={tabs} />);
const tab = (name: string) => screen.getByRole("tab", { name });

const expectSelected = (name: string) => {
  for (const other of ["A", "B", "C"]) {
    expect(tab(other)).toHaveAttribute("aria-selected", other === name ? "true" : "false");
    expect(tab(other)).toHaveAttribute("tabindex", other === name ? "0" : "-1");
  }
  expect(screen.getByRole("tabpanel")).toHaveTextContent(name.toLowerCase());
};

afterEach(cleanup);

describe("TaskTabs", () => {
  it("renders_a_labelled_tablist_with_tabs_in_order", () => {
    renderTabs();
    const list = screen.getByRole("tablist", { name: "Task sections" });
    const names = [...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(names).toEqual(["A", "B", "C"]);
    for (const name of names) expect(tab(name!)).toHaveClass("sf-tab");
  });

  it("first_tab_is_selected_by_default", () => {
    renderTabs();
    expectSelected("A");
    expect(screen.getByRole("tabpanel", { name: "A" })).toHaveTextContent("a");
  });

  it("arrow_right_and_left_move_selection_and_focus_with_wrap", () => {
    renderTabs();
    fireEvent.keyDown(tab("A"), { key: "ArrowRight" });
    expectSelected("B");
    expect(tab("B")).toHaveFocus();
    fireEvent.keyDown(tab("B"), { key: "ArrowLeft" });
    expectSelected("A");
    fireEvent.keyDown(tab("A"), { key: "ArrowLeft" });
    expectSelected("C");
    expect(tab("C")).toHaveFocus();
    fireEvent.keyDown(tab("C"), { key: "ArrowRight" });
    expectSelected("A");
    expect(tab("A")).toHaveFocus();
  });

  it("home_and_end_go_to_first_and_last", () => {
    renderTabs();
    fireEvent.keyDown(tab("A"), { key: "End" });
    expectSelected("C");
    expect(tab("C")).toHaveFocus();
    fireEvent.keyDown(tab("C"), { key: "Home" });
    expectSelected("A");
    expect(tab("A")).toHaveFocus();
  });

  it("click_selects_a_tab", () => {
    renderTabs();
    fireEvent.click(tab("B"));
    expectSelected("B");
  });

  it("panel_is_labelled_by_the_selected_tab", () => {
    renderTabs();
    fireEvent.click(tab("C"));
    const panel = screen.getByRole("tabpanel");
    expect(tab("C").getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("C").id);
  });
});

it("keeps a marked panel mounted and hides it while another tab is selected", () => {
  render(<TaskTabs label="Sections" tabs={[{ id: "a", label: "A", content: <input aria-label="Draft" />, keepMounted: true }, { id: "b", label: "B", content: <p>Other</p> }]} />);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unfinished" } });
  fireEvent.click(screen.getByRole("tab", { name: "B" }));
  expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "A" }));
  expect(screen.getByLabelText("Draft")).toHaveValue("unfinished");
});
