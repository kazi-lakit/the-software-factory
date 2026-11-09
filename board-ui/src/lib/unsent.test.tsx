import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  sessionStorage.clear();
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

  it("survives_a_page_reload_through_session_storage", async () => {
    keepUnsent("gate:T-1:spec", "split the API part");
    expect(sessionStorage.getItem("factory-board:unsent:gate:T-1:spec")).toBe("split the API part");
    // The hosted sign-in reloads the page: a fresh module has an empty memory and reads sessionStorage.
    vi.resetModules();
    const reloaded = await import("./unsent");
    expect(reloaded.readUnsent("gate:T-1:spec")).toBe("split the API part");
    expect(reloaded.hasUnsent("gate:T-1:spec")).toBe(true);
  });

  it("removes_the_stored_text_once_sent", () => {
    keepUnsent("answer:T-1", "use dev");
    clearUnsent("answer:T-1");
    expect(sessionStorage.getItem("factory-board:unsent:answer:T-1")).toBeNull();
  });

  it("clears_every_unsent_key_and_leaves_other_keys", () => {
    sessionStorage.setItem("blocks-app:oidc-return-to", "/tasks/T-1");
    keepUnsent("answer:T-1", "a");
    keepUnsent("new-task:title", "b");
    clearAllUnsent();
    expect(sessionStorage.getItem("factory-board:unsent:answer:T-1")).toBeNull();
    expect(sessionStorage.getItem("factory-board:unsent:new-task:title")).toBeNull();
    expect(readUnsent("answer:T-1")).toBeUndefined();
    expect(sessionStorage.getItem("blocks-app:oidc-return-to")).toBe("/tasks/T-1");
  });

  it("falls_back_to_memory_when_storage_is_unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    keepUnsent("answer:T-2", "kept in memory");
    expect(readUnsent("answer:T-2")).toBe("kept in memory");
    expect(hasUnsent("answer:T-2")).toBe(true);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("SecurityError"); });
    clearUnsent("answer:T-2");
    expect(readUnsent("answer:T-2")).toBeUndefined();
  });
});
