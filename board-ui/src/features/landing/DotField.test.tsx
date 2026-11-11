import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme } from "../../lib/theme";
import { DOT_ALPHA_MAX, DOT_RGB } from "./dotField";
import { DotField } from "./DotField";

type Fake = Record<string, ReturnType<typeof vi.fn>>;

function fakeGl(loseContext: ReturnType<typeof vi.fn>): Fake {
  const cache: Fake = {};
  return new Proxy(cache, {
    get(target, prop: string) {
      if (!target[prop]) {
        if (prop === "getShaderParameter" || prop === "getProgramParameter") target[prop] = vi.fn(() => true);
        else if (prop.startsWith("create") || prop === "getUniformLocation") target[prop] = vi.fn(() => ({}));
        else if (prop === "getExtension") target[prop] = vi.fn(() => ({ loseContext }));
        else if (prop === "getAttribLocation") target[prop] = vi.fn(() => 0);
        else target[prop] = vi.fn();
      }
      return target[prop];
    }
  });
}

let frames: Map<number, FrameRequestCallback>;
let nextId: number;
let raf: ReturnType<typeof vi.spyOn>;
let caf: ReturnType<typeof vi.spyOn>;
let hidden: boolean;
const realMatchMedia = window.matchMedia;

function mockMatchMedia(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: reduced && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  })) as typeof window.matchMedia;
}

function runFrames() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, cb] of pending) cb(performance.now());
}

beforeEach(() => {
  frames = new Map();
  nextId = 0;
  raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    nextId += 1;
    frames.set(nextId, cb);
    return nextId;
  });
  caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    frames.delete(id);
  });
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  document.documentElement.removeAttribute("data-theme");
});

function withGl() {
  const loseContext = vi.fn();
  const gl = fakeGl(loseContext);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => (kind === "webgl2" ? gl : null)) as never);
  return { getContext, gl, loseContext };
}

describe("DotField", () => {
  it("renders_an_aria_hidden_canvas_when_webgl2_is_available", () => {
    const { getContext } = withGl();
    const { container } = render(<DotField />);
    const canvas = container.querySelector("canvas.sf-landing-field");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(getContext.mock.calls[0]?.[0]).toBe("webgl2");
  });

  it("renders_no_canvas_under_reduced_motion", () => {
    mockMatchMedia(true);
    const { getContext } = withGl();
    const { container } = render(<DotField />);
    expect(container.querySelector("canvas")).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("renders_no_canvas_without_webgl2", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(<DotField />);
    await waitFor(() => expect(container.querySelector("canvas")).toBeNull());
  });

  it("pauses_while_the_tab_is_hidden_and_resumes", () => {
    withGl();
    render(<DotField />);
    expect(raf).toHaveBeenCalled();
    const last = nextId;
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(caf).toHaveBeenCalledWith(last);
    const before = raf.mock.calls.length;
    runFrames();
    expect(raf.mock.calls.length).toBe(before);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(raf.mock.calls.length).toBeGreaterThan(before);
  });

  it("recolours_when_the_theme_changes", () => {
    const { gl } = withGl();
    render(<DotField />);
    act(() => setTheme("light"));
    const [r, g, b] = DOT_RGB.light;
    expect(gl.uniform3f).toHaveBeenCalledWith(expect.anything(), r / 255, g / 255, b / 255);
    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), DOT_ALPHA_MAX.light);
  });

  it("cleans_up_on_unmount", () => {
    const { loseContext } = withGl();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<DotField />);
    unmount();
    expect(loseContext).toHaveBeenCalled();
    expect(caf).toHaveBeenCalled();
    const windowEvents = removeWindow.mock.calls.map((c) => c[0]);
    expect(windowEvents).toContain("pointermove");
    expect(windowEvents).toContain("resize");
    expect(removeDocument.mock.calls.map((c) => c[0])).toContain("visibilitychange");
  });
});
