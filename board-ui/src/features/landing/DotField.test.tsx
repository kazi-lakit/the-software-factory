import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme } from "../../lib/theme";
import { DOT_ALPHA_MAX, DOT_RGB } from "./dotField";
import { DotField } from "./DotField";

type Fake = Record<string, ReturnType<typeof vi.fn>>;

function fakeGl(loseContext: ReturnType<typeof vi.fn>, isLost: () => boolean = () => false): Fake {
  const cache: Fake = {};
  return new Proxy(cache, {
    get(target, prop: string) {
      if (!target[prop]) {
        if (prop === "getShaderParameter" || prop === "getProgramParameter") target[prop] = vi.fn(() => true);
        else if (prop.startsWith("create") || prop === "getUniformLocation") target[prop] = vi.fn(() => (isLost() ? null : {}));
        else if (prop === "isContextLost") target[prop] = vi.fn(() => isLost());
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

  it("blends_alpha_separately_so_the_dot_alpha_is_not_squared", () => {
    const { gl } = withGl();
    render(<DotField />);
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    expect(gl.blendFunc).not.toHaveBeenCalled();
  });

  it("survives_a_strict_mode_remount_on_the_same_canvas", async () => {
    // A lost context stays lost on its canvas: getContext hands it back and createShader returns null.
    let lost = false;
    const loseContext = vi.fn(() => {
      lost = true;
    });
    const gl = fakeGl(loseContext, () => lost);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => (kind === "webgl2" ? gl : null)) as never);
    const { container, unmount } = render(
      <StrictMode>
        <DotField />
      </StrictMode>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector("canvas.sf-landing-field")).not.toBeNull();
    expect(loseContext).not.toHaveBeenCalled();
    expect(lost).toBe(false);
    unmount();
    await waitFor(() => expect(loseContext).toHaveBeenCalled());
  });

  it("coalesces_resize_events_into_one_rebuild_per_frame", () => {
    const { gl } = withGl();
    render(<DotField />);
    const bufferData = gl.bufferData as ReturnType<typeof vi.fn>;
    const uploads = bufferData.mock.calls.length;
    expect(uploads).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("resize"));
    expect(bufferData.mock.calls.length).toBe(uploads);
    runFrames();
    expect(bufferData.mock.calls.length).toBe(uploads + 1);
    runFrames();
    expect(bufferData.mock.calls.length).toBe(uploads + 1);
  });

  it("cleans_up_on_unmount", async () => {
    const { loseContext } = withGl();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<DotField />);
    unmount();
    await waitFor(() => expect(loseContext).toHaveBeenCalled());
    expect(caf).toHaveBeenCalled();
    const windowEvents = removeWindow.mock.calls.map((c) => c[0]);
    expect(windowEvents).toContain("pointermove");
    expect(windowEvents).toContain("resize");
    expect(removeDocument.mock.calls.map((c) => c[0])).toContain("visibilitychange");
  });
});
