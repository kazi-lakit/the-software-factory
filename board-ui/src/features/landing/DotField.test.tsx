import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme } from "../../lib/theme";
import { DOT_ALPHA_MAX, DOT_RGB, FRAGMENT_SHADER } from "./dotField";
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

  it.each(["dark", "light"] as const)("%s: a dot shows as its colour at its alpha over the page", (theme) => {
    // Model what the page shows: the fragment output, the blend into the cleared canvas, then the browser
    // compositing the canvas over the page (premultiplied unless the context opts out).
    document.documentElement.setAttribute("data-theme", theme);
    const { getContext, gl } = withGl();
    render(<DotField />);
    const attrs = (getContext.mock.calls[0]?.[1] ?? {}) as WebGLContextAttributes;
    const premultiplied = attrs.premultipliedAlpha !== false;
    const factor = (f: unknown, srcA: number, dstA: number): number => {
      if (f === gl.ZERO) return 0;
      if (f === gl.ONE) return 1;
      if (f === gl.SRC_ALPHA) return srcA;
      if (f === gl.ONE_MINUS_SRC_ALPHA) return 1 - srcA;
      if (f === gl.DST_ALPHA) return dstA;
      if (f === gl.ONE_MINUS_DST_ALPHA) return 1 - dstA;
      throw new Error("unmodelled blend factor");
    };
    const separate = (gl.blendFuncSeparate as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const single = (gl.blendFunc as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const [srcRgb, dstRgb, srcAlpha, dstAlpha] = separate ?? (single ? [single[0], single[1], single[0], single[1]] : []);
    expect(gl.enable).toHaveBeenCalledWith(gl.BLEND);
    const out = /outColor\s*=\s*vec4\((.+),\s*vAlpha\);/.exec(FRAGMENT_SHADER)?.[1]?.trim();
    const fragmentRgb = (c: number, a: number): number => {
      if (out === "uColor") return c;
      if (out === "uColor * vAlpha") return c * a;
      throw new Error(`unmodelled fragment output: ${out}`);
    };
    const a = DOT_ALPHA_MAX[theme];
    const bg = [0.3, 0.5, 0.7];
    DOT_RGB[theme].forEach((channel, i) => {
      const c = channel / 255;
      const src = fragmentRgb(c, a);
      // Over the cleared, transparent canvas the destination is 0 in every channel.
      const storedRgb = src * factor(srcRgb, a, 0) + 0 * factor(dstRgb, a, 0);
      const storedA = a * factor(srcAlpha, a, 0) + 0 * factor(dstAlpha, a, 0);
      const shown = (premultiplied ? storedRgb : storedRgb * storedA) + (bg[i] as number) * (1 - storedA);
      expect(storedA).toBeCloseTo(a, 6);
      expect(shown).toBeCloseTo(c * a + (bg[i] as number) * (1 - a), 6);
    });
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

  it("pauses_on_context_loss_and_rebuilds_on_restore", () => {
    const { gl } = withGl();
    const { container } = render(<DotField />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const programs = (gl.createProgram as ReturnType<typeof vi.fn>).mock.calls.length;
    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lostEvent);
    });
    // preventDefault tells the browser the page wants the context back.
    expect(lostEvent.defaultPrevented).toBe(true);
    expect(frames.size).toBe(0);
    const before = raf.mock.calls.length;
    act(() => {
      canvas.dispatchEvent(new Event("webglcontextrestored"));
    });
    expect((gl.createProgram as ReturnType<typeof vi.fn>).mock.calls.length).toBe(programs + 1);
    expect(raf.mock.calls.length).toBeGreaterThan(before);
    expect(container.querySelector("canvas.sf-landing-field")).not.toBeNull();
  });

  it("hides_the_canvas_when_a_restored_context_cannot_be_rebuilt", () => {
    const { gl } = withGl();
    const { container } = render(<DotField />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    act(() => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    (gl.getShaderParameter as ReturnType<typeof vi.fn>).mockReturnValue(false);
    act(() => {
      canvas.dispatchEvent(new Event("webglcontextrestored"));
    });
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("cleans_up_on_unmount", async () => {
    const { loseContext } = withGl();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeCanvas = vi.spyOn(HTMLCanvasElement.prototype, "removeEventListener");
    const { unmount } = render(<DotField />);
    unmount();
    const canvasEvents = removeCanvas.mock.calls.map((c) => c[0]);
    expect(canvasEvents).toContain("webglcontextlost");
    expect(canvasEvents).toContain("webglcontextrestored");
    await waitFor(() => expect(loseContext).toHaveBeenCalled());
    expect(caf).toHaveBeenCalled();
    const windowEvents = removeWindow.mock.calls.map((c) => c[0]);
    expect(windowEvents).toContain("pointermove");
    expect(windowEvents).toContain("resize");
    expect(removeDocument.mock.calls.map((c) => c[0])).toContain("visibilitychange");
  });
});
