import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../lib/theme";
import { loseContext, startField, type Field } from "./dotField";

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The landing page's WebGL2 dot field, fixed behind the page. Under reduced motion, or without WebGL2,
 * it renders nothing and the body's static CSS dot grid shows on its own.
 */
export function DotField() {
  const [on, setOn] = useState(() => !prefersReducedMotion());
  const ref = useRef<HTMLCanvasElement>(null);
  const field = useRef<Field | null>(null);
  // StrictMode runs effect cleanup and setup back to back on the same canvas. A lost context stays lost on
  // its canvas, so the context is only dropped on the next tick, and a setup that follows cancels that.
  const pendingLoss = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = ref.current;
    if (!on || !canvas) return;
    clearTimeout(pendingLoss.current);
    pendingLoss.current = undefined;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true }) as WebGL2RenderingContext | null;
    if (!gl || gl.isContextLost()) {
      setOn(false);
      return;
    }
    const start = (context: WebGL2RenderingContext): boolean => {
      try {
        field.current = startField(canvas, context, { theme: themeRef.current });
        return true;
      } catch {
        field.current = null;
        setOn(false);
        return false;
      }
    };
    if (!start(gl)) return;
    // A GPU reset loses the context: stop the loop, and ask for it back (preventDefault) to rebuild the field.
    const onLost = (event: Event) => {
      event.preventDefault();
      field.current?.stop();
      field.current = null;
    };
    const onRestored = () => {
      start(gl);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      field.current?.stop();
      field.current = null;
      pendingLoss.current = setTimeout(() => {
        pendingLoss.current = undefined;
        loseContext(gl);
      }, 0);
    };
  }, [on]);

  useEffect(() => {
    field.current?.setTheme(theme);
  }, [theme]);

  if (!on) return null;
  return <canvas aria-hidden="true" className="sf-landing-field" ref={ref} />;
}
