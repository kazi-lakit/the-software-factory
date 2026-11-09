import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearAllUnsent, clearUnsent, hasUnsent, keepUnsent, readUnsent, useUnsent } from "./unsent";

function Field({ id, initial = "" }: { id: string; initial?: string }) {
  const [text, setText, clear] = useUnsent(id, initial);
  return (
    <>
      <label>
        Comment
        <textarea value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <button type="button" onClick={clear}>Sent</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  clearAllUnsent();
});

describe("unsent text", () => {
  it("keeps_text_per_form_until_it_is_cleared", () => {
    keepUnsent("answer:T-1", "use the dev branch");
    keepUnsent("answer:T-2", "other");
    expect(readUnsent("answer:T-1")).toBe("use the dev branch");
    expect(hasUnsent("answer:T-1")).toBe(true);
    clearUnsent("answer:T-1");
    expect(readUnsent("answer:T-1")).toBeUndefined();
    expect(readUnsent("answer:T-2")).toBe("other");
  });

  it("restores_typed_text_when_the_form_mounts_again", () => {
    const first = render(<Field id="gate:T-1:spec" />);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "tighten the scope" } });
    // The session ends: the guard unmounts the page; the text stays in memory.
    first.unmount();
    render(<Field id="gate:T-1:spec" />);
    expect(screen.getByLabelText("Comment")).toHaveValue("tighten the scope");
  });

  it("forgets_the_text_once_it_is_sent", () => {
    const first = render(<Field id="new-task:title" />);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "draft" } });
    act(() => screen.getByRole("button", { name: "Sent" }).click());
    expect(screen.getByLabelText("Comment")).toHaveValue("");
    first.unmount();
    render(<Field id="new-task:title" />);
    expect(screen.getByLabelText("Comment")).toHaveValue("");
  });

  it("does_not_hold_text_that_equals_the_starting_value", () => {
    render(<Field id="edit:T-1:title" initial="Old title" />);
    const field = screen.getByLabelText("Comment");
    fireEvent.change(field, { target: { value: "New title" } });
    expect(hasUnsent("edit:T-1:title")).toBe(true);
    fireEvent.change(field, { target: { value: "Old title" } });
    expect(hasUnsent("edit:T-1:title")).toBe(false);
  });
});
