import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_VIEW_KEY, resetBoardViewForTests, useBoardView } from "./useBoardView";

beforeEach(resetBoardViewForTests);
afterEach(() => {
  resetBoardViewForTests();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useBoardView", () => {
  it("defaults_to_lanes_with_empty_storage", () => {
    expect(renderHook(() => useBoardView()).result.current[0]).toBe("lanes");
  });
  it("reads_stages_from_factory_board_view", () => {
    window.localStorage.setItem(BOARD_VIEW_KEY, "stages");
    expect(renderHook(() => useBoardView()).result.current[0]).toBe("stages");
  });
  it("ignores_a_garbage_stored_value_and_uses_lanes", () => {
    window.localStorage.setItem(BOARD_VIEW_KEY, "garbage");
    expect(renderHook(() => useBoardView()).result.current[0]).toBe("lanes");
  });
  it("uses_lanes_when_getItem_throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("no"); });
    expect(renderHook(() => useBoardView()).result.current[0]).toBe("lanes");
  });
  it("set_writes_the_key_and_updates_the_hook", () => {
    const { result } = renderHook(() => useBoardView());
    act(() => result.current[1]("stages"));
    expect(result.current[0]).toBe("stages");
    expect(window.localStorage.getItem("factory-board:view")).toBe("stages");
  });
  it("set_still_switches_when_setItem_throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("no"); });
    const { result } = renderHook(() => useBoardView());
    act(() => result.current[1]("stages"));
    expect(result.current[0]).toBe("stages");
  });
  it("is_shared_between_two_mounted_hooks", () => {
    const a = renderHook(() => useBoardView());
    const b = renderHook(() => useBoardView());
    act(() => a.result.current[1]("stages"));
    expect(b.result.current[0]).toBe("stages");
  });
});
