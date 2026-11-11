// The landing page's dot-matrix field: plain WebGL2, one small shader, no library.
// Pure parts (colours, layout, pulse, drift) are exported for tests; startField runs the loop.
import type { Theme } from "../../lib/theme";

export type Rgb = [number, number, number];

/** Dot colour per theme: the BAK F2 green on the dark field, near-black on the light one. */
export const DOT_RGB: Record<Theme, Rgb> = { dark: [92, 205, 160], light: [11, 17, 18] };

/** The highest alpha any dot reaches; the contrast test checks text over a dot at this alpha. */
export const DOT_ALPHA_MAX: Record<Theme, number> = { dark: 0.18, light: 0.08 };

/** One breath of the field, in ms. */
export const PULSE_PERIOD_MS = 6000;

/** Grid spacing in CSS px. */
export const DOT_SPACING = 24;

/** Share of grid cells that get a dot; the field stays sparse. */
const DENSITY = 0.3;

/** How far (CSS px) the nearest dots move with the pointer. */
const DRIFT_PX = 18;

/** Breathing term in [0, 1], period PULSE_PERIOD_MS: dim at 0, brightest half a period in. */
export function pulse(ms: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * ms) / PULSE_PERIOD_MS);
}

/** Small deterministic generator (mulberry32) so the layout is stable for a seed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sparse dots on a grid: x, y in CSS px and a depth in [0.2, 1] per dot. */
export function buildDots(width: number, height: number, spacing: number, rng: () => number): Float32Array {
  const cols = Math.ceil(width / spacing);
  const rows = Math.ceil(height / spacing);
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rng() >= DENSITY) continue;
      out.push((c + 0.5) * spacing, (r + 0.5) * spacing, 0.2 + 0.8 * rng());
    }
  }
  return new Float32Array(out);
}

export type Point = { x: number; y: number };

/** Ease the drift a fraction of the way toward the pointer (units in [-1, 1]). */
export function stepDrift(current: Point, target: Point, ease: number): Point {
  return { x: current.x + (target.x - current.x) * ease, y: current.y + (target.y - current.y) * ease };
}

export const VERTEX_SHADER = `#version 300 es
in vec3 aDot;
uniform vec2 uResolution;
uniform vec2 uDrift;
uniform float uTime;
uniform float uAlpha;
uniform float uDpr;
out float vAlpha;
void main() {
  float depth = aDot.z;
  // Nearer dots drift more toward the pointer.
  vec2 pos = aDot.xy + uDrift * ${DRIFT_PX.toFixed(1)} * depth;
  vec2 clip = (pos / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = (1.0 + 1.5 * depth) * uDpr;
  // Breathing, with a small per-dot phase so the field does not blink as one.
  float phase = (aDot.x + aDot.y) * 0.002;
  float breath = 0.5 - 0.5 * cos(6.2831853 * uTime / ${PULSE_PERIOD_MS.toFixed(1)} + phase);
  // Depth fade: far dots are fainter.
  vAlpha = uAlpha * depth * (0.55 + 0.45 * breath);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec3 uColor;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  if (length(p) > 0.5) discard;
  outColor = vec4(uColor, vAlpha);
}
`;

export type Field = { setTheme(theme: Theme): void; stop(): void };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("dot field: cannot create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`dot field: shader did not compile: ${log ?? ""}`);
  }
  return shader;
}

/**
 * Start drawing the field on `canvas`. Pauses while the tab is hidden. `stop()` frees the loop, listeners and
 * GL objects but leaves the context alive, so a remount on the same canvas (React StrictMode) can reuse it;
 * the caller drops the context once the canvas is really gone (see `loseContext`).
 */
export function startField(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, { theme }: { theme: Theme }): Field {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("dot field: cannot create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`dot field: program did not link: ${log ?? ""}`);
  }
  gl.useProgram(program);

  const u = {
    alpha: gl.getUniformLocation(program, "uAlpha"),
    color: gl.getUniformLocation(program, "uColor"),
    dpr: gl.getUniformLocation(program, "uDpr"),
    drift: gl.getUniformLocation(program, "uDrift"),
    resolution: gl.getUniformLocation(program, "uResolution"),
    time: gl.getUniformLocation(program, "uTime")
  };

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const loc = gl.getAttribLocation(program, "aDot");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  // Colour blends by source alpha; alpha accumulates as src + dst * (1 - src), so a dot over the cleared,
  // transparent canvas keeps its own alpha (blendFunc would store srcA * srcA on a non-premultiplied canvas).
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  let count = 0;
  let resizePending = false;
  function resize() {
    resizePending = false;
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    const dots = buildDots(width, height, DOT_SPACING, seededRng(7));
    count = dots.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, dots, gl.STATIC_DRAW);
    gl.uniform2f(u.resolution, width, height);
    gl.uniform1f(u.dpr, dpr);
  }

  function setTheme(next: Theme) {
    const [r, g, b] = DOT_RGB[next];
    gl.uniform3f(u.color, r / 255, g / 255, b / 255);
    gl.uniform1f(u.alpha, DOT_ALPHA_MAX[next]);
  }

  let drift: Point = { x: 0, y: 0 };
  let target: Point = { x: 0, y: 0 };
  let frameId: number | undefined;
  let running = false;
  const startedAt = performance.now();

  function frame(now: number) {
    if (!running) return;
    if (resizePending) resize();
    drift = stepDrift(drift, target, 0.05);
    gl.uniform2f(u.drift, drift.x, drift.y);
    gl.uniform1f(u.time, now - startedAt);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
    frameId = requestAnimationFrame(frame);
  }

  function play() {
    if (running) return;
    running = true;
    frameId = requestAnimationFrame(frame);
  }

  function pause() {
    running = false;
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    frameId = undefined;
  }

  // Resize events come in bursts while the window is dragged; rebuild the dots once, on the next frame.
  const onResize = () => {
    resizePending = true;
  };
  const onVisibility = () => (document.hidden ? pause() : play());
  const onPointer = (event: PointerEvent) => {
    target = { x: (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1, y: (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1 };
  };

  resize();
  setTheme(theme);
  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onPointer);
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) play();

  return {
    setTheme,
    stop() {
      pause();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    }
  };
}

/** Release the GPU context of a canvas that is gone for good. */
export function loseContext(gl: WebGL2RenderingContext): void {
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}
