import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "@factory/core";
import { DocVersions } from "./DocVersions";

const doc = (version: number, body: string, status: Doc["status"] = "superseded"): Doc =>
  ({ author: "spec-agent", body, kind: "spec", status, taskId: "T-1", version });

const docs = [
  doc(1, "# Spec\nKeep the old API.\nShared line"),
  doc(2, "# Spec\nAdd paging.\nShared line\nNew last line", "current")
];

afterEach(cleanup);

describe("DocVersions", () => {
  it("shows_the_current_version_by_default", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    expect(screen.getByLabelText("Spec version")).toHaveValue("2");
    expect(screen.getByText(/Add paging\./)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "v2 (current)" })).toBeInTheDocument();
  });

  it("switches_to_an_earlier_version", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    fireEvent.change(screen.getByLabelText("Spec version"), { target: { value: "1" } });
    expect(screen.getByText(/Keep the old API\./)).toBeInTheDocument();
  });

  it("diffs_two_versions_with_added_and_removed_lines", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "1" } });
    const diff = screen.getByRole("region", { name: "Spec changes from v1 to v2" });
    expect(within(diff).getByText("− Keep the old API.")).toHaveClass("sf-diff-removed");
    expect(within(diff).getByText("+ Add paging.")).toHaveClass("sf-diff-added");
    expect(within(diff).getByText("+ New last line")).toHaveClass("sf-diff-added");
    expect(within(diff).getByText("Shared line")).toHaveClass("sf-diff-same");
    expect(within(diff).getByText("2 lines added, 1 removed")).toBeInTheDocument();
  });

  it("opens_on_an_explicit_from_and_to", () => {
    render(<DocVersions label="Spec" docs={docs} from={1} to={2} />);
    expect(screen.getByRole("region", { name: "Spec changes from v1 to v2" })).toBeInTheDocument();
  });

  it("says_when_there_is_no_version_yet", () => {
    render(<DocVersions label="Plan" docs={[]} />);
    expect(screen.getByText("No plan yet.")).toBeInTheDocument();
  });
});

describe("DocVersions dropdowns", () => {
  it("version_and_compare_selects_use_the_shared_select_class", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    expect(screen.getByLabelText("Spec version")).toHaveClass("sf-select");
    expect(screen.getByLabelText("Compare with")).toHaveClass("sf-select");
  });

  it("selects_have_no_inline_style_override", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    expect(screen.getByLabelText("Spec version")).not.toHaveAttribute("style");
    expect(screen.getByLabelText("Compare with")).not.toHaveAttribute("style");
  });

  it("labels_are_associated_with_the_selects", () => {
    render(<DocVersions label="Spec" docs={docs} />);
    expect(screen.getByLabelText("Spec version").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Compare with").tagName).toBe("SELECT");
  });
});

describe("DocVersions compare with previous", () => {
  it("previous_mode_has_a_compare_button_and_no_compare_select", () => {
    render(<DocVersions label="Spec" docs={docs} compare="previous" />);
    expect(screen.getByRole("button", { name: "Compare with v1" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Compare with")).toBeNull();
    expect(screen.getByLabelText("Spec version")).toBeInTheDocument();
  });

  it("compare_button_toggles_the_diff_from_the_previous_version", () => {
    render(<DocVersions label="Spec" docs={docs} compare="previous" />);
    const button = screen.getByRole("button", { name: "Compare with v1" });
    fireEvent.click(button);
    expect(screen.getByRole("region", { name: "Spec changes from v1 to v2" })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Spec changes from v1 to v2" })).toBeNull();
    expect(screen.getByText(/Add paging\./)).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("compare_button_is_hidden_at_v1", () => {
    const first = render(<DocVersions label="Spec" docs={docs} to={1} compare="previous" />);
    expect(screen.queryByRole("button", { name: /Compare with/ })).toBeNull();
    first.unmount();
    render(<DocVersions label="Spec" docs={[doc(1, "x", "current")]} compare="previous" />);
    expect(screen.queryByRole("button", { name: /Compare with/ })).toBeNull();
  });

  it("previous_mode_opens_on_to", () => {
    render(<DocVersions label="Spec" docs={docs} to={1} compare="previous" />);
    expect(screen.getByLabelText("Spec version")).toHaveValue("1");
  });

  it("compare_button_follows_the_shown_version", () => {
    const three = [doc(1, "a"), doc(2, "b"), doc(3, "c", "current")];
    render(<DocVersions label="Spec" docs={three} to={3} compare="previous" />);
    expect(screen.getByRole("button", { name: "Compare with v2" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Spec version"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Compare with v1" })).toBeInTheDocument();
  });
});
