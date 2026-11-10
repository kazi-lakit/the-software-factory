import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSelectedFactory } from "./useFactories";

function Pick({ name }: { name: string }) {
  const [picked, setPicked] = useSelectedFactory();
  return <button type="button" onClick={() => setPicked("delta")}>{`${name}:${picked}`}</button>;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useSelectedFactory", () => {
  it("reads_localStorage_once_and_a_view_mounted_later_agrees_with_one_already_mounted", () => {
    window.localStorage.setItem("factory-board:factory", "blocks");
    render(<Pick name="shell" />);
    expect(screen.getByText("shell:blocks")).toBeInTheDocument();
    window.localStorage.setItem("factory-board:factory", "other-tab");
    render(<Pick name="view" />);
    expect(screen.getByText("view:blocks")).toBeInTheDocument();
  });

  it("applies_a_pick_to_every_mounted_view_and_to_one_mounted_later_even_when_it_cannot_be_stored", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<Pick name="shell" />);
    fireEvent.click(screen.getByText("shell:all"));
    expect(screen.getByText("shell:delta")).toBeInTheDocument();
    render(<Pick name="view" />);
    expect(screen.getByText("view:delta")).toBeInTheDocument();
  });

  it("ignores_a_storage_event_from_another_tab", () => {
    render(<Pick name="shell" />);
    window.localStorage.setItem("factory-board:factory", "other-tab");
    window.dispatchEvent(new StorageEvent("storage", { key: "factory-board:factory", newValue: "other-tab" }));
    expect(screen.getByText("shell:all")).toBeInTheDocument();
  });
});
